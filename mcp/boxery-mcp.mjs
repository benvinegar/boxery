#!/usr/bin/env node
// boxery MCP server: exposes boxery VMs as MCP tools (vm_bash, vm_read, …, vm_browser, vm_manage).
// No dependencies; Node >= 20. Uses ~/.boxery (run `boxery setup user@host` first).
//
//   boxery-mcp (or: npx boxery-vm) [--host NAME] [--vm NAME]   stdio (launched by the MCP client)
//   boxery-mcp --http 127.0.0.1:8765 [--host NAME] [--vm NAME]   Streamable HTTP at /mcp
//        auth: bearer token from $BOXERY_MCP_TOKEN or --token-file (required unless --no-auth),
//              optional --allow-user a@b.c (checks Tailscale-User-Login from `tailscale serve`)
//
// "local" (vm_copy) and grant sources are the machine this server runs on.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import * as core from "../core/boxery-core.mjs";
import { leaseAction, manageAction, MANAGE_ACTIONS, TOOLS as SHARED_TOOLS } from "../core/boxery-tools.mjs";

const VERSION = (() => {
	try {
		return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
	} catch {
		return "0.0.0";
	}
})();
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const opt = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);
if (has("-h") || has("--help")) {
	process.stdout.write(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 12).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
	process.exit(0);
}
if (has("--host") && opt("--host") == null) throw new Error("--host needs a registered host name");
const DEFAULT_HOST = core.resolveHost(opt("--host"));
const DEFAULT_VM = opt("--vm") ?? process.env.BOXERY_VM ?? null;
if (DEFAULT_VM) core.assertName(DEFAULT_VM);
const log = (...a) => process.stderr.write(`[boxery-mcp] ${a.join(" ")}\n`);

// ---------------------------------------------------------------- tools

// Built from the shared table (core/boxery-tools.mjs). MCP adds per-call host selection, and
// vm_manage gains hosts/host because the session's host is MCP state. vm_manage/vm_lease act on the
// session's current VM and leases.
const hostProp = { host: { type: "string", description: "Registered host alias (default: session host; legacy selects the root profile)" } };
const withHost = (schema) => ({ ...schema, properties: { ...schema.properties, ...hostProp } });
const manageMcp = (t) => ({
	...t,
	description: `${t.description.replace(MANAGE_ACTIONS.join(" | "), [...MANAGE_ACTIONS, "hosts", "host"].join(" | "))} ` +
		"`hosts` lists registered targets; `host` selects a session host via host:NAME and clears the current VM. Registration and credentials remain user-controlled.",
	parameters: { ...t.parameters, properties: { ...t.parameters.properties, action: { type: "string", enum: [...MANAGE_ACTIONS, "hosts", "host"] } } },
	run(_vm, a, { session, host, current }) {
		if (a.action === "hosts")
			return { text: core.registeredHosts().map((h) => `${h.name}${h.name === host.name ? " *" : ""}\t${h.dir}`).join("\n") };
		if (a.action === "host") {
			if (a.host == null) throw new Error("host selection requires host:NAME (or legacy)");
			session.host = host;
			session.current = null;
			session.currentHost = null;
			return { text: `current host: ${host.name}; no current VM` };
		}
		const adopt = (name) => { session.current = name; session.host = session.currentHost = host; };
		return manageAction(a, {
			current,
			keeper: session.keeper,
			listNote: ` (host: ${host.name})`,
			async use(name) {
				await core.ensureVm(name);
				await core.boxeryCli(["grants", name, "apply", "--quiet"], 120_000).catch(() => {});
				adopt(name);
			},
			adopt,
			clear() { session.current = null; session.currentHost = null; },
			removed(name) { if (session.current === name && sameHost(session.currentHost, host)) this.clear(); },
		});
	},
});
const leaseMcp = (t) => ({
	...t,
	run(_vm, a, { session, host, current }) {
		return leaseAction(a, {
			keeper: session.keeper,
			current,
			adopt(name) { session.current = name; session.host = session.currentHost = host; },
			clear() { session.current = null; session.currentHost = null; },
		});
	},
});
const TOOLS = SHARED_TOOLS.map((t) => (t.name === "vm_manage" ? manageMcp(t) : t.name === "vm_lease" ? leaseMcp(t) : t)).map((t) => ({
	name: t.name,
	description: t.description,
	inputSchema: withHost(t.parameters),
	annotations: { title: t.title, ...t.annotations },
	noVm: t.noVm,
	run: t.run,
}));
const sameHost = (a, b) => a?.name === b?.name && a?.dir === b?.dir;
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------- MCP / JSON-RPC

const allSessions = new Set();
function newSession() {
	const session = { id: randomUUID(), host: DEFAULT_HOST, current: DEFAULT_VM, currentHost: DEFAULT_VM ? DEFAULT_HOST : null, inflight: new Map(), lastActive: Date.now() };
	// Leases are renewed while the session is in use: a call is running, or one ran within the TTL.
	// An abandoned session (HTTP client gone without DELETE) stops renewing, and the host reaper resets the VM.
	session.keeper = new core.LeaseKeeper({
		alive: (l) => session.inflight.size > 0 || Date.now() - session.lastActive < l.ttl * 1000,
		onLost(l, e) {
			log(`lost lease on ${l.name} (${e.message})`);
			if (session.current === l.name && sameHost(session.currentHost, l.host)) session.current = session.currentHost = null;
		},
	});
	allSessions.add(session);
	return session;
}

/** Give back a session's leases (the host resets those VMs) and forget it. */
async function endSession(session) {
	allSessions.delete(session);
	await session.keeper.releaseAll();
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
	process.on(sig, async () => {
		await Promise.all([...allSessions].map(endSession));
		process.exit(0);
	});

const instructions = (s) =>
	`Current host: ${s.host.name}. VM selections belong only to that host. Every vm_* tool accepts optional host.\n` + core.guidance(s.current, {
		localToolsNote:
			"The vm_* tools act on remote VMs; any other tools you have (shell, file tools) act on the machine you run on, not the VM. Use those only when you deliberately need something local.",
	});

async function callTool(session, params, signal) {
	const tool = TOOL_MAP.get(params?.name);
	if (!tool) throw Object.assign(new Error(`unknown tool ${params?.name}`), { code: -32602 });
	const args = params.arguments ?? {};
	try {
		// Snapshot before any await: concurrent selection must not retarget this call or its cleanup.
		const host = Object.hasOwn(args, "host") ? core.resolveHost(core.assertHost(args.host)) : session.host;
		const current = sameHost(session.currentHost, host) ? session.current : null;
		let vm = null;
		if (!tool.noVm) {
			vm = args.vm || current;
			if (!vm) throw new Error("No VM given and no current VM. Pass `vm`, or call vm_manage {action:'use', name:…} first.");
			core.assertName(vm);
		}
		const { vm: _drop, ...rest } = args;
		const r = await core.withHost(host, () => tool.run(vm, tool.noVm ? args : rest, { session, signal, host, current }));
		const content = [{ type: "text", text: r.text ?? "" }];
		if (r.image) content.push({ type: "image", data: r.image.data, mimeType: r.image.mimeType });
		return { content, isError: !!r.isError };
	} catch (e) {
		return { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true };
	}
}

/** Handle one JSON-RPC message. Returns a response object, or null for notifications. */
async function handle(session, msg) {
	const { id, method, params } = msg ?? {};
	const isRequest = id !== undefined && id !== null;
	session.lastActive = Date.now();
	const reply = (result) => (isRequest ? { jsonrpc: "2.0", id, result } : null);
	const fail = (code, message) => (isRequest ? { jsonrpc: "2.0", id, error: { code, message } } : null);
	try {
		switch (method) {
			case "initialize": {
				const want = params?.protocolVersion;
				return reply({
					protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "boxery", title: "boxery VMs", version: VERSION },
					instructions: instructions(session),
				});
			}
			case "notifications/initialized":
				return null;
			case "notifications/cancelled":
				session.inflight.get(params?.requestId)?.abort();
				return null;
			case "ping":
				return reply({});
			case "tools/list":
				return reply({ tools: TOOLS.map(({ run: _r, noVm: _n, ...t }) => t) });
			case "tools/call": {
				const ac = new AbortController();
				if (isRequest) session.inflight.set(id, ac);
				try {
					return reply(await callTool(session, params, ac.signal));
				} finally {
					session.inflight.delete(id);
				}
			}
			default:
				return method?.startsWith("notifications/") ? null : fail(-32601, `method not found: ${method}`);
		}
	} catch (e) {
		return fail(e.code ?? -32603, String(e?.message ?? e));
	}
}

// ---------------------------------------------------------------- stdio transport

function serveStdio() {
	const session = newSession();
	let buf = "";
	const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
				continue;
			}
			// Requests run concurrently (tool calls can be slow); responses are matched by id.
			for (const m of Array.isArray(msg) ? msg : [msg]) handle(session, m).then((r) => r && send(r));
		}
	});
	process.stdin.on("end", async () => {
		await endSession(session);
		process.exit(0);
	});
	log(`stdio ready${DEFAULT_VM ? ` (current VM: ${DEFAULT_VM})` : ""}`);
}

// ---------------------------------------------------------------- Streamable HTTP transport

function serveHttp(listen) {
	const [hostPart, portPart] = listen.includes(":") ? [listen.slice(0, listen.lastIndexOf(":")), listen.slice(listen.lastIndexOf(":") + 1)] : ["127.0.0.1", listen];
	const tokenFile = opt("--token-file");
	const token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : process.env.BOXERY_MCP_TOKEN;
	const noAuth = has("--no-auth");
	if (!token && !noAuth) {
		log("refusing to start: set BOXERY_MCP_TOKEN or --token-file (or --no-auth for local testing)");
		process.exit(2);
	}
	const allowUsers = argv.flatMap((a, i) => (a === "--allow-user" ? [argv[i + 1]] : []));
	if (allowUsers.length && !["127.0.0.1", "::1", "localhost"].includes(hostPart)) {
		log("refusing to start: --allow-user trusts the Tailscale-User-Login header, which is only safe when the server listens on loopback behind `tailscale serve`");
		process.exit(2);
	}
	const allowOrigins = argv.flatMap((a, i) => (a === "--allow-origin" ? [argv[i + 1]] : []));
	const sessions = new Map();

	const server = http.createServer(async (req, res) => {
		const send = (status, body, headers = {}) => {
			res.writeHead(status, { "content-type": "application/json", ...headers });
			res.end(body == null ? "" : JSON.stringify(body));
		};
		try {
			const url = new URL(req.url, "http://x");
			if (url.pathname === "/healthz") return send(200, { ok: true });
			if (url.pathname !== "/mcp") return send(404, { error: "not found" });
			// DNS-rebinding guard: browsers send Origin; reject unknown ones.
			const origin = req.headers.origin;
			if (origin && !allowOrigins.includes(origin)) return send(403, { error: `origin not allowed: ${origin}` });
			if (!noAuth && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
			if (allowUsers.length) {
				// Set by `tailscale serve` for requests from tailnet users (absent for tagged devices).
				const who = req.headers["tailscale-user-login"];
				if (!who || !allowUsers.includes(String(who))) return send(403, { error: `tailnet user not allowed: ${who ?? "(none)"}` });
			}
			const sid = req.headers["mcp-session-id"];
			if (req.method === "DELETE") {
				const ended = sid && sessions.get(sid);
				if (ended) {
					sessions.delete(sid);
					await endSession(ended);
				}
				return send(204, null);
			}
			if (req.method === "GET") return send(405, { error: "SSE stream not supported; use POST" }, { allow: "POST, DELETE" });
			if (req.method !== "POST") return send(405, { error: "method not allowed" }, { allow: "POST, DELETE" });

			let raw = "";
			for await (const c of req) {
				raw += c;
				if (raw.length > 32 * 1024 * 1024) return send(413, { error: "body too large" });
			}
			let msg;
			try {
				msg = JSON.parse(raw);
			} catch {
				return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
			}
			const msgs = Array.isArray(msg) ? msg : [msg];
			let session;
			if (msgs.some((m) => m?.method === "initialize")) {
				session = newSession();
				sessions.set(session.id, session);
			} else {
				session = sid && sessions.get(sid);
				if (!session) return send(404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "unknown or missing Mcp-Session-Id; re-initialize" } });
			}
			res.on("close", () => {
				if (!res.writableEnded) for (const m of msgs) session.inflight.get(m?.id)?.abort();
			});
			const out = (await Promise.all(msgs.map((m) => handle(session, m)))).filter(Boolean);
			const headers = { "mcp-session-id": session.id };
			if (!out.length) return send(202, null, headers);
			return send(200, Array.isArray(msg) ? out : out[0], headers);
		} catch (e) {
			log("error", e?.stack ?? e);
			if (!res.headersSent) send(500, { error: String(e?.message ?? e) });
		}
	});
	server.requestTimeout = 0;
	server.listen(Number(portPart), hostPart, () =>
		log(`http ready on http://${hostPart}:${portPart}/mcp (auth: ${noAuth ? "none" : "bearer"}${allowUsers.length ? `, tailnet users: ${allowUsers.join(",")}` : ""})`),
	);
}

const httpListen = opt("--http");
if (httpListen) serveHttp(httpListen);
else serveStdio();
