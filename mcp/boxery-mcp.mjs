#!/usr/bin/env node
// boxery MCP server: exposes boxery VMs as MCP tools (vm_bash, vm_read, …, vm_browser, vm_manage).
// No dependencies; Node >= 18. Uses ~/.boxery (run `boxery setup user@host` first).
//
//   boxery-mcp [--host NAME] [--vm NAME]   stdio (launched by the MCP client)
//   boxery-mcp --http 127.0.0.1:8765 [--host NAME] [--vm NAME]   Streamable HTTP at /mcp
//        auth: bearer token from $BOXERY_MCP_TOKEN or --token-file (required unless --no-auth),
//              optional --allow-user a@b.c (checks Tailscale-User-Login from `tailscale serve`)
//
// "local" (vm_copy) and grant sources are the machine this server runs on.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import * as core from "../core/boxery-core.mjs";

const VERSION = "0.5.0";
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

const hostProp = { host: { type: "string", description: "Registered host alias (default: session host; legacy selects the root profile)" } };
const vmProp = { ...hostProp, vm: { type: "string", description: "VM name (default: the current VM)" } };
const shotProp = { screenshot: { type: "boolean", description: "Return a screenshot after the action (default true)" } };
const where = "in an boxery VM (default: the current VM). Relative paths are under /home/agent/project; ~ is /home/agent.";
const obj = (properties, required = []) => ({ type: "object", properties: { ...properties, ...vmProp }, required });

const TOOLS = [
	{
		name: "vm_bash",
		description: `Run a bash command ${where} Login shell, user "agent" with passwordless sudo, cwd /home/agent/project. Use rg / fdfind / ls for searching. Output keeps the last ${core.MAX_LINES} lines / ${core.MAX_BYTES / 1024}KB.`,
		inputSchema: obj({ command: { type: "string" }, timeout: { type: "number", description: "Seconds (default 120)" } }, ["command"]),
		annotations: { title: "VM bash", destructiveHint: true, openWorldHint: true },
		run: (vm, a, x) => core.bashTool(vm, a, x),
	},
	{
		name: "vm_read",
		description: `Read a file ${where} Images come back as images. offset/limit are 1-based line numbers.`,
		inputSchema: obj({ path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, ["path"]),
		annotations: { title: "VM read", readOnlyHint: true },
		run: (vm, a) => core.readTool(vm, a),
	},
	{
		name: "vm_write",
		description: `Create or overwrite a file ${where} Parent directories are created.`,
		inputSchema: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
		annotations: { title: "VM write", destructiveHint: true },
		run: (vm, a) => core.writeTool(vm, a),
	},
	{
		name: "vm_edit",
		description: `Edit a file ${where} Exact-text replacement: each edits[].oldText must match exactly once in the original file; edits must not overlap.`,
		inputSchema: obj(
			{
				path: { type: "string" },
				edits: {
					type: "array",
					items: { type: "object", properties: { oldText: { type: "string" }, newText: { type: "string" } }, required: ["oldText", "newText"] },
				},
			},
			["path", "edits"],
		),
		annotations: { title: "VM edit", destructiveHint: true },
		run: (vm, a) => core.editTool(vm, a),
	},
	{
		name: "vm_copy",
		description:
			"Copy a file or directory between the machine running this server and a VM, or between VMs. Locations: `HOST/NAME:/path`, `local:/path` (server machine), `NAME:/path` (session host), or a bare path (= current VM). Directories copy recursively.",
		inputSchema: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
		annotations: { title: "VM copy", destructiveHint: true },
		noVm: true,
		run: (_vm, a, x) => core.copyTool(a, { current: a.vm ?? x.current, signal: x.signal }),
	},
	{
		name: "vm_screenshot",
		description: "Screenshot of a VM's desktop (DISPLAY=:1).",
		inputSchema: obj({}),
		annotations: { title: "VM screenshot", readOnlyHint: true },
		run: (vm) => core.screenshot(vm),
	},
	{
		name: "vm_click",
		description: "Click at (x, y), in screenshot pixels, on a VM's desktop.",
		inputSchema: obj(
			{ x: { type: "number" }, y: { type: "number" }, button: { type: "string", description: "left (default), right or middle" }, double: { type: "boolean" }, ...shotProp },
			["x", "y"],
		),
		annotations: { title: "VM click", destructiveHint: true },
		run: (vm, a) => core.click(vm, a),
	},
	{
		name: "vm_type",
		description: "Type text into the focused window on a VM's desktop.",
		inputSchema: obj({ text: { type: "string" }, ...shotProp }, ["text"]),
		annotations: { title: "VM type", destructiveHint: true },
		run: (vm, a) => core.typeText(vm, a),
	},
	{
		name: "vm_key",
		description: 'Press keys on a VM\'s desktop, xdotool syntax, space-separated: "Return", "ctrl+l", "ctrl+shift+t", "Escape".',
		inputSchema: obj({ keys: { type: "string" }, ...shotProp }, ["keys"]),
		annotations: { title: "VM key", destructiveHint: true },
		run: (vm, a) => core.pressKeys(vm, a),
	},
	{
		name: "vm_scroll",
		description: "Scroll at (x, y), in screenshot pixels, on a VM's desktop.",
		inputSchema: obj(
			{ x: { type: "number" }, y: { type: "number" }, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number" }, ...shotProp },
			["x", "y", "direction"],
		),
		annotations: { title: "VM scroll" },
		run: (vm, a) => core.scroll(vm, a),
	},
	{
		name: "vm_browser",
		description:
			"Drive Google Chrome on a VM's desktop with Playwright (the user can watch it). `code` is the body of an async function receiving (page, context, browser); its return value comes back as JSON. " +
			"Chrome starts if needed and keeps state between calls. Example: `await page.goto('https://example.com'); return await page.title();`",
		inputSchema: obj({ code: { type: "string" }, screenshot: { type: "boolean", description: "Also return a page screenshot (default false)" }, timeout: { type: "number" } }, ["code"]),
		annotations: { title: "VM browser", destructiveHint: true, openWorldHint: true },
		run: (vm, a, x) => core.browser(vm, a, x),
	},
	{
		name: "vm_manage",
		description:
			"Manage boxery VMs (Ubuntu desktop VMs on the user's VM host). action: list | new | rm | snap | revert | use | none | grants | hosts | host. " +
			"`use` makes NAME the current VM (default for all vm_* tools; created if missing); `none` clears it; `new` creates a VM (with use=true also selects it); " +
			"`grants` shows what the VM may access from the user's machine (only the user can change grants). `hosts` lists registered targets; `host` selects a session host via host:NAME and clears the current VM. Registration and credentials remain user-controlled.",
		inputSchema: {
			type: "object",
			properties: {
				...hostProp,
				action: { type: "string", enum: ["list", "new", "rm", "snap", "revert", "use", "none", "grants", "hosts", "host"] },
				name: { type: "string" },
				snapshot: { type: "string" },
				use: { type: "boolean" },
			},
			required: ["action"],
		},
		annotations: { title: "VM manage", destructiveHint: true },
		noVm: true,
		async run(_vm, a, { session, host, current }) {
			switch (a.action) {
				case "hosts":
					return { text: core.registeredHosts().map((h) => `${h.name}${h.name === host.name ? " *" : ""}\t${h.dir}`).join("\n") };
				case "host":
					if (a.host == null) throw new Error("host selection requires host:NAME (or legacy)");
					session.host = host;
					session.current = null;
					session.currentHost = null;
					return { text: `current host: ${host.name}; no current VM` };
				case "use":
					await core.ensureVm(core.assertName(a.name));
					await core.boxeryCli(["grants", a.name, "apply", "--quiet"], 120_000).catch(() => {});
					session.current = a.name;
					session.host = session.currentHost = host;
					return { text: `current VM: ${a.name}` };
				case "none":
					session.current = null;
					session.currentHost = null;
					return { text: "no current VM" };
				case "list":
					return { text: `${await core.manage(a)}\ncurrent: ${current ?? "(none)"} (host: ${host.name})` };
				case "new": {
					const name = a.name ? core.assertName(a.name) : core.newName();
					const out = await core.manage({ ...a, name });
					if (a.use) { session.current = name; session.host = session.currentHost = host; }
					return { text: `${out}${a.use ? `\ncurrent VM: ${name}` : ""}` };
				}
				case "rm": {
					const out = await core.manage(a);
					if (session.current === a.name && sameHost(session.currentHost, host)) { session.current = null; session.currentHost = null; }
					return { text: out };
				}
				default:
					return { text: await core.manage(a) };
			}
		},
	},
];
const sameHost = (a, b) => a?.name === b?.name && a?.dir === b?.dir;
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------- MCP / JSON-RPC

function newSession() {
	return { id: randomUUID(), host: DEFAULT_HOST, current: DEFAULT_VM, currentHost: DEFAULT_VM ? DEFAULT_HOST : null, inflight: new Map() };
}

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
	process.stdin.on("end", () => process.exit(0));
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
				if (sid) sessions.delete(sid);
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
