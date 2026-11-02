#!/usr/bin/env node
// boxery MCP server: exposes boxery VMs as MCP tools (vm_bash, vm_read, …, vm_browser, vm_manage).
// No dependencies; Node >= 20. Uses ~/.boxery (run `boxery setup user@host` first).
//
//   boxery-mcp (or: npx boxery-vm) [--host NAME] [--vm NAME]   stdio (launched by the MCP client)
//   boxery-mcp --http 127.0.0.1:8765 [--host NAME] [--vm NAME]   Streamable HTTP at /mcp
//        auth: bearer token from $BOXERY_MCP_TOKEN or --token-file (required unless --no-auth, loopback only),
//              optional --allow-user a@b.c (checks Tailscale-User-Login from `tailscale serve`)
//   --ui   offer vm_view (live desktop view) even to clients that don't advertise MCP Apps support
//   --copy-root DIR   allow vm_copy local: paths only inside DIR (never boxery's config, ~/.ssh, ~/.pi)
//
// "local" (vm_copy) and grant sources are the machine this server runs on. Over HTTP that is the
// control plane, so vm_copy local: endpoints are refused unless --copy-root confines them.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import * as core from "../core/boxery-core.mjs";
import { HOST_PARAM, runTool, sameHost, TOOLS as SHARED_TOOLS, VM_PARAM } from "../core/boxery-tools.mjs";
/** @import { Lease } from "../core/boxery-core.mjs" */
/** @import { JsonSchema, ObjectSchema, Session as ToolSession, Tool, ToolContext } from "../core/boxery-tools.mjs" */
/** Sends one JSON-RPC message to the client. @typedef {(message: object) => unknown} Notify */
/**
 * One MCP client session: the shared tool session (current VM, host, leases; core/boxery-tools.mjs) plus protocol state.
 * pending: our requests to the client (elicitation) by id; approve: vm_grant's prompt (see elicitApprover).
 * @typedef {ToolSession & { id: string, inflight: Map<unknown, AbortController>, protocolVersion: string,
 *   lastActive: number, pending: Map<string, (msg: any) => void>, requestSeq: number, ui?: boolean, elicit?: boolean,
 *   approve?: (req: { message: string, send: Notify, signal: AbortSignal }) => Promise<string> }} Session
 */
/** A tool as this server lists and runs it. @typedef {{ name: string, title: string, description: string, inputSchema: ObjectSchema, outputSchema?: JsonSchema, annotations: Tool["annotations"], noVm?: boolean, _meta?: object, run: Tool["run"] }} McpTool */

const VERSION = (() => {
	try {
		return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
	} catch {
		return "0.0.0";
	}
})();
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
// Fields newer revisions added are sent only to clients that negotiated them (versions are ISO dates).
const since = (/** @type {Session} */ session, /** @type {string} */ version) => session.protocolVersion >= version;
const PROGRESS_INTERVAL_MS = 1000; // at most one status line per second per call
const HEARTBEAT_MS = 5000; // and an elapsed-time line when a call has been quiet this long
const MAX_BODY = 32 * 1024 * 1024; // HTTP request body limit, in bytes

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const opt = (/** @type {string} */ name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const has = (/** @type {string} */ name) => argv.includes(name);
if (has("-h") || has("--help")) {
	const lines = readFileSync(new URL(import.meta.url)).toString().split("\n");
	const end = lines.findIndex((l, i) => i > 0 && !l.startsWith("//"));
	process.stdout.write(lines.slice(1, end).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
	process.exit(0);
}
if (has("--host") && opt("--host") == null) throw new Error("--host needs a registered host name");
const DEFAULT_HOST = core.resolveHost(opt("--host"));
const DEFAULT_VM = opt("--vm") ?? process.env.BOXERY_VM ?? null;
if (DEFAULT_VM) core.assertName(DEFAULT_VM);
const log = (/** @type {unknown[]} */ ...a) => process.stderr.write(`[boxery-mcp] ${a.join(" ")}\n`);
const HTTP_LISTEN = opt("--http");
const TOKEN_FILE = opt("--token-file");
if (has("--copy-root") && !opt("--copy-root")) throw new Error("--copy-root needs a directory");
// vm_copy local: endpoints (core.copyTool's `local`): any path in stdio mode (the client's own machine),
// refused over HTTP (the control plane), or confined to --copy-root. The MCP token file is never copyable.
const COPY_DENY = TOKEN_FILE ? [TOKEN_FILE] : [];
const COPY_ROOT = opt("--copy-root") ? core.copyRoot(opt("--copy-root"), { deny: COPY_DENY }) : null;
const LOCAL_COPY = COPY_ROOT ? { root: COPY_ROOT, deny: COPY_DENY } : HTTP_LISTEN ? false : undefined;
const LOCAL_COPY_NOTE =
	LOCAL_COPY === false
		? "On this server `local:` endpoints are disabled: it runs on the boxery control plane, not your machine. Copy between VMs, or use vm_read/vm_write for small files."
		: LOCAL_COPY
			? `On this server \`local:\` means the machine it runs on, confined to ${COPY_ROOT} (relative paths resolve there; no "..", symlinks may not leave it, boxery's config and key directories are refused). Copies into it never merge into or replace an existing directory.`
			: null;

// ---------------------------------------------------------------- tools

// Built from the shared table (core/boxery-tools.mjs), host selection included. MCP adds only
// vm_copy's note on what `local:` means for this server, and the live desktop view below.
/** @type {Record<string, (t: Tool) => Tool>} */
const MCP_TOOL = { vm_copy: (t) => (LOCAL_COPY_NOTE ? { ...t, description: `${t.description} ${LOCAL_COPY_NOTE}` } : t) };
/** @type {McpTool[]} */
const TOOLS = SHARED_TOOLS.map((t) => MCP_TOOL[t.name]?.(t) ?? t).map((t) => ({
	name: t.name,
	title: t.title,
	description: t.description,
	inputSchema: t.parameters,
	outputSchema: t.outputSchema,
	annotations: { title: t.title, ...t.annotations },
	noVm: t.noVm,
	run: t.run,
}));

// Live desktop view (MCP Apps, extension io.modelcontextprotocol/ui). vm_view renders ui://boxery/desktop
// inline: a page that polls the app-only vm_view_frame and sends the user's input through vm_click,
// vm_type, vm_key and vm_scroll. Listed only to clients that advertise the extension (or with --ui),
// so text-only clients see no change. MCP-only: pi has no UI to render it.
const UI_EXT = "io.modelcontextprotocol/ui";
const UI_MIME = "text/html;profile=mcp-app";
const VIEW_URI = "ui://boxery/desktop";
const VIEW_UI = { prefersBorder: true };
const VIEW_RESOURCE = { uri: VIEW_URI, name: "desktop", title: "VM desktop", description: "Live view of a boxery VM's desktop", mimeType: UI_MIME, _meta: { ui: VIEW_UI } };
const viewHtml = () => readFileSync(new URL("./desktop-view.html", import.meta.url), "utf8");
// _meta.ui is current; the flat "ui/resourceUri" key is for hosts built before it.
const uiMeta = (/** @type {string[]} */ visibility) => ({ ui: { resourceUri: VIEW_URI, visibility }, "ui/resourceUri": VIEW_URI });
/** @type {McpTool[]} */
const VIEW_TOOLS = [
	{
		name: "vm_view",
		title: "VM live view",
		description:
			"Show the user a live view of a VM's desktop in the chat, which they can watch and, if they choose, control with mouse and keyboard. " +
			"Use it when the user wants to see or take over the desktop. To look at the screen yourself, use vm_screenshot.",
		inputSchema: { type: "object", properties: { vm: VM_PARAM, host: HOST_PARAM }, required: [] },
		annotations: { title: "VM live view", readOnlyHint: true, openWorldHint: false },
		_meta: uiMeta(["model", "app"]),
		async run(vm, _a, { host }) {
			const { size } = await core.screenshot(vm, 1280, { jpeg: true }); // fails early if the desktop is unreachable
			return {
				text: `Showing the user a live view of VM "${vm}" (${size.screenWidth}x${size.screenHeight}). Outside a chat client, \`boxery desktop ${vm}\` opens it in a browser.`,
				structured: { vm, host: host.name, ...size },
			};
		},
	},
	{
		name: "vm_view_frame",
		title: "VM live view frame",
		description: "One frame of the live view: a JPEG of the VM's desktop, sized like vm_screenshot so clicks use the same coordinates.",
		inputSchema: { type: "object", properties: { vm: VM_PARAM, host: HOST_PARAM }, required: [] },
		annotations: { title: "VM live view frame", readOnlyHint: true, openWorldHint: false },
		_meta: uiMeta(["app"]),
		async run(vm) {
			const s = await core.screenshot(vm, 1280, { jpeg: true });
			return { text: `${s.size.width}x${s.size.height}`, image: s.image, structured: s.size };
		},
	},
];
const TOOL_MAP = new Map([...TOOLS, ...VIEW_TOOLS].map((t) => [t.name, t]));

// ---------------------------------------------------------------- MCP / JSON-RPC

/** @type {Set<Session>} */
const allSessions = new Set();
function newSession() {
	const session = /** @type {Session} */ ({
		id: randomUUID(), host: DEFAULT_HOST, current: DEFAULT_VM, currentHost: DEFAULT_VM ? DEFAULT_HOST : null, inflight: new Map(), protocolVersion: PROTOCOL_VERSIONS.at(-1), lastActive: Date.now(),
		// Session hooks for the shared vm_manage / vm_lease (core/boxery-tools.mjs).
		adopt(name, host) { session.current = name; session.host = session.currentHost = host; },
		clear() { session.current = null; session.currentHost = null; },
		selectHost(host) { session.host = host; session.clear(); },
	});
	// Requests this server sent the client (elicitation), by id, awaiting the client's response.
	session.pending = new Map();
	session.requestSeq = 0;
	// Leases are renewed while the session is in use: a call is running, or one ran within the TTL.
	// An abandoned session (HTTP client gone without DELETE) stops renewing, and the host reaper resets the VM.
	session.keeper = new core.LeaseKeeper({
		alive: (l) => session.inflight.size > 0 || Date.now() - session.lastActive < l.ttl * 1000,
		/** @param {Lease} l @param {any} e */
		onLost(l, e) {
			log(`lost lease on ${l.name} (${e.message})`);
			if (session.current === l.name && sameHost(session.currentHost, l.host)) session.current = session.currentHost = null;
		},
	});
	allSessions.add(session);
	return session;
}

/** tools/list for this session: title/outputSchema only for clients on 2025-06-18 or later; vm_view only for MCP Apps clients. */
const listTools = (/** @type {Session} */ session) =>
	[...TOOLS, ...(session.ui ? VIEW_TOOLS : [])].map(({ run: _r, noVm: _n, title, outputSchema, ...t }) =>
		since(session, "2025-06-18") ? { ...t, title, ...(outputSchema ? { outputSchema } : {}) } : t);

/**
 * Progress reporter for one tools/call, or undefined when the client sent no progressToken.
 * Status lines are rate-limited; a quiet call still reports elapsed time, so clients that reset
 * their request timeout on progress keep waiting for slow forks and snapshots.
 */
/** @param {unknown} token @param {Notify | undefined} notify @param {string} tool */
function progressReporter(token, notify, tool) {
	if (token == null || !notify) return undefined;
	const started = Date.now();
	let n = 0;
	let last = 0;
	let done = false;
	const send = (/** @type {string} */ message) => {
		if (done) return; // never after the response
		last = Date.now();
		notify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++n, message } });
	};
	// Check every second, so a quiet gap never exceeds HEARTBEAT_MS by more than a tick.
	const timer = setInterval(() => {
		if (Date.now() - last >= HEARTBEAT_MS) send(`${tool}: running (${Math.round((Date.now() - started) / 1000)}s)`);
	}, PROGRESS_INTERVAL_MS);
	timer.unref?.();
	return {
		progress: (/** @type {string} */ message) => Date.now() - last >= PROGRESS_INTERVAL_MS && send(message),
		stop: () => {
			done = true;
			clearInterval(timer);
		},
	};
}

/** Give back a session's leases (the host resets those VMs) and forget it. */
/** @param {Session} session */
async function endSession(session) {
	allSessions.delete(session);
	await session.keeper.releaseAll();
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
	process.on(sig, async () => {
		await Promise.all([...allSessions].map(endSession));
		process.exit(0);
	});

const instructions = (/** @type {Session} */ s) =>
	core.guidance(s.current, {
		host: s.host.name,
		localToolsNote:
			"The vm_* tools act on remote VMs; any other tools you have (shell, file tools) act on the machine you run on, not the VM. Use those only when you deliberately need something local.",
	}) + (LOCAL_COPY_NOTE ? `\nvm_copy: ${LOCAL_COPY_NOTE}` : "");

/** Send the client a request on this call's channel and resolve with its result. Abort sends notifications/cancelled.
 * @param {Session} session @param {Notify} send @param {string} method @param {object} params @param {AbortSignal} [signal] @returns {Promise<any>} */
function clientRequest(session, send, method, params, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("aborted"));
		const id = `boxery-${++session.requestSeq}`;
		const onAbort = () => {
			session.pending.delete(id);
			send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "tool call cancelled" } });
			reject(new Error("aborted"));
		};
		session.pending.set(id, (msg) => {
			session.pending.delete(id);
			signal?.removeEventListener("abort", onAbort);
			if (msg.error) reject(new Error(msg.error.message ?? "client error"));
			else resolve(msg.result);
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		send({ jsonrpc: "2.0", id, method, params });
	});
}

/**
 * vm_grant's approval prompt: an elicitation the client shows the user, with no fields, only
 * accept/decline. Only for clients that declared form elicitation, on a channel that can carry it.
 * @param {Session} session @param {Notify | undefined} send @param {AbortSignal} signal
 */
function elicitApprover(session, send, signal) {
	if (!session.elicit || !send) return undefined;
	session.approve ??= core.oneAtATime(async (/** @type {Parameters<NonNullable<Session["approve"]>>[0]} */ { message, send: s, signal: sig }) => {
		const params = { ...(since(session, "2025-11-25") ? { mode: "form" } : {}), message, requestedSchema: { type: "object", properties: {} } };
		const r = await clientRequest(session, s, "elicitation/create", params, sig);
		return ["accept", "decline"].includes(r?.action) ? r.action : "cancel";
	});
	return (/** @type {string} */ message) => /** @type {NonNullable<Session["approve"]>} */ (session.approve)({ message, send, signal });
}

/** @param {Session} session @param {any} params @param {AbortSignal} signal @param {ToolContext["progress"]} [progress] @param {Notify} [send] */
async function callTool(session, params, signal, progress, send) {
	const tool = TOOL_MAP.get(params?.name);
	if (!tool) throw Object.assign(new Error(`unknown tool ${params?.name}`), { code: -32602 });
	const args = params.arguments ?? {};
	try {
		const approve = tool.name === "vm_grant" ? elicitApprover(session, send, signal) : undefined;
		const r = await runTool(tool, args, session, { signal, progress, approve, localCopy: LOCAL_COPY });
		/** @type {{ type: string, text?: string, data?: string, mimeType?: string }[]} */
		const content = [{ type: "text", text: r.text ?? "" }];
		if (r.image) content.push({ type: "image", data: r.image.data, mimeType: r.image.mimeType });
		const structured = r.structured !== undefined && since(session, "2025-06-18") ? { structuredContent: r.structured } : {};
		return { content, ...structured, isError: !!r.isError };
	} catch (/** @type {any} */ e) {
		return { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true };
	}
}

/**
 * Handle one JSON-RPC message. Returns a response object, or null for notifications.
 * notify(message) sends a server notification tied to this request (progress), when the transport can.
 * @param {Session} session @param {any} msg @param {Notify} [notify] @returns {Promise<object | null>}
 */
async function handle(session, msg, notify) {
	const { id, method, params } = msg ?? {};
	const isRequest = id !== undefined && id !== null;
	session.lastActive = Date.now();
	const reply = (/** @type {unknown} */ result) => (isRequest ? { jsonrpc: "2.0", id, result } : null);
	const fail = (/** @type {number} */ code, /** @type {string} */ message) => (isRequest ? { jsonrpc: "2.0", id, error: { code, message } } : null);
	// The client answering one of our requests (elicitation): never reply to a response.
	if (method === undefined && isRequest && ("result" in msg || "error" in msg)) {
		session.pending.get(id)?.(msg);
		return null;
	}
	try {
		switch (method) {
			case "initialize": {
				const want = params?.protocolVersion;
				session.protocolVersion = PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0];
				session.ui = has("--ui") || !!params?.capabilities?.extensions?.[UI_EXT]?.mimeTypes?.includes(UI_MIME);
				// Form elicitation: `elicitation: {}` (2025-06-18; form is implied) or `{form: {}, …}`.
				const el = params?.capabilities?.elicitation;
				session.elicit = !!el && typeof el === "object" && (Object.keys(el).length === 0 || !!el.form);
				const serverInfo = { name: "boxery", title: "boxery VMs", version: VERSION };
				if (since(session, "2025-11-25"))
					Object.assign(serverInfo, { description: "Self-hosted Ubuntu desktop VMs for coding agents: shell, files, computer use and Chrome.", websiteUrl: "https://github.com/benvinegar/boxery" });
				return reply({
					protocolVersion: session.protocolVersion,
					capabilities: { tools: { listChanged: false }, ...(session.ui ? { resources: {} } : {}) },
					serverInfo,
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
				return reply({ tools: listTools(session) });
			case "resources/list":
				return reply({ resources: session.ui ? [VIEW_RESOURCE] : [] });
			case "resources/templates/list":
				return reply({ resourceTemplates: [] });
			case "resources/read":
				if (params?.uri !== VIEW_URI) return fail(-32002, `resource not found: ${params?.uri}`);
				return reply({ contents: [{ uri: VIEW_URI, mimeType: UI_MIME, text: viewHtml(), _meta: { ui: VIEW_UI } }] });
			case "tools/call": {
				const ac = new AbortController();
				if (isRequest) session.inflight.set(id, ac);
				const reporter = isRequest ? progressReporter(params?._meta?.progressToken, notify, params?.name) : undefined;
				try {
					return reply(await callTool(session, params, ac.signal, reporter?.progress, isRequest ? notify : undefined));
				} finally {
					reporter?.stop();
					session.inflight.delete(id);
				}
			}
			default:
				return method?.startsWith("notifications/") ? null : fail(-32601, `method not found: ${method}`);
		}
	} catch (/** @type {any} */ e) {
		return fail(e.code ?? -32603, String(e?.message ?? e));
	}
}

// ---------------------------------------------------------------- stdio transport

function serveStdio() {
	const session = newSession();
	let buf = "";
	const send = (/** @type {unknown} */ obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
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
			for (const m of Array.isArray(msg) ? msg : [msg]) handle(session, m, send).then((r) => r && send(r));
		}
	});
	process.stdin.on("end", async () => {
		await endSession(session);
		process.exit(0);
	});
	log(`stdio ready${DEFAULT_VM ? ` (current VM: ${DEFAULT_VM})` : ""}`);
}

// ---------------------------------------------------------------- Streamable HTTP transport

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];
const sha256 = (/** @type {string} */ s) => createHash("sha256").update(s).digest();
/** Constant-time string compare: equal-length digests, so neither the length nor the content leaks through timing. */
const secretEquals = (/** @type {unknown} */ got, /** @type {unknown} */ want) => typeof got === "string" && typeof want === "string" && timingSafeEqual(sha256(got), sha256(want));

/** @param {string} listen */
function serveHttp(listen) {
	const [hostPart, portPart] = listen.includes(":") ? [listen.slice(0, listen.lastIndexOf(":")), listen.slice(listen.lastIndexOf(":") + 1)] : ["127.0.0.1", listen];
	const token = TOKEN_FILE ? readFileSync(TOKEN_FILE, "utf8").trim() : process.env.BOXERY_MCP_TOKEN;
	const noAuth = has("--no-auth");
	if (!token && !noAuth) {
		log("refusing to start: set BOXERY_MCP_TOKEN or --token-file (or --no-auth for local testing)");
		process.exit(2);
	}
	if (noAuth && !LOOPBACK.includes(hostPart)) {
		log("refusing to start: --no-auth serves every VM tool unauthenticated, so it only listens on loopback");
		process.exit(2);
	}
	const allowUsers = argv.flatMap((a, i) => (a === "--allow-user" ? [argv[i + 1]] : []));
	if (allowUsers.length && !LOOPBACK.includes(hostPart)) {
		log("refusing to start: --allow-user trusts the Tailscale-User-Login header, which is only safe when the server listens on loopback behind `tailscale serve`");
		process.exit(2);
	}
	const allowOrigins = argv.flatMap((a, i) => (a === "--allow-origin" ? [argv[i + 1]] : []));
	/** @type {Map<string, Session>} */
	const sessions = new Map();

	const server = http.createServer(async (req, res) => {
		/** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
		const send = (status, body, headers = {}) => {
			res.writeHead(status, { "content-type": "application/json", ...headers });
			res.end(body == null ? "" : JSON.stringify(body));
		};
		try {
			const url = new URL(/** @type {string} */ (req.url), "http://x");
			if (url.pathname === "/healthz") return send(200, { ok: true });
			if (url.pathname !== "/mcp") return send(404, { error: "not found" });
			// DNS-rebinding guard: browsers send Origin; reject unknown ones.
			const origin = req.headers.origin;
			if (origin && !allowOrigins.includes(origin)) return send(403, { error: `origin not allowed: ${origin}` });
			if (!noAuth && !secretEquals(req.headers.authorization, `Bearer ${token}`)) return send(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
			if (allowUsers.length) {
				// Set by `tailscale serve` for requests from tailnet users (absent for tagged devices).
				const who = req.headers["tailscale-user-login"];
				if (!who || !allowUsers.includes(String(who))) return send(403, { error: `tailnet user not allowed: ${who ?? "(none)"}` });
			}
			const sid = /** @type {string | undefined} */ (req.headers["mcp-session-id"]); // node joins a repeated header
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

			// Collect bytes and decode once: decoding each chunk would split multi-byte characters.
			/** @type {Buffer[]} */
			const chunks = [];
			let size = 0;
			for await (const c of req) {
				size += c.length;
				if (size > MAX_BODY) return send(413, { error: "body too large" });
				chunks.push(c);
			}
			let msg;
			try {
				msg = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
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
			const headers = { "mcp-session-id": session.id };
			// Progress and vm_grant's approval prompt need a stream: answer as SSE only when the client accepts
			// it and asked for progress or may be asked to approve; everything else keeps the plain JSON response.
			// The client posts its answer to the prompt as a separate request, which gets a 202.
			const wantsStream = msgs.some((m) => m?.id != null && m.method === "tools/call" && (m.params?._meta?.progressToken != null || (session.elicit && m.params?.name === "vm_grant")));
			if (wantsStream && String(req.headers.accept ?? "").includes("text/event-stream")) {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
				const event = (/** @type {unknown} */ obj) => !res.writableEnded && res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
				await Promise.all(msgs.map((m) => handle(session, m, event).then((r) => r && event(r))));
				return res.end();
			}
			const out = (await Promise.all(msgs.map((m) => handle(session, m)))).filter(Boolean);
			if (!out.length) return send(202, null, headers);
			return send(200, Array.isArray(msg) ? out : out[0], headers);
		} catch (/** @type {any} */ e) {
			log("error", e?.stack ?? e);
			if (!res.headersSent) send(500, { error: String(e?.message ?? e) });
			else res.end(); // mid-SSE: close the stream rather than leave it hanging
		}
	});
	server.requestTimeout = 0;
	server.listen(Number(portPart), hostPart, () =>
		log(`http ready on http://${hostPart}:${portPart}/mcp (auth: ${noAuth ? "none" : "bearer"}${allowUsers.length ? `, tailnet users: ${allowUsers.join(",")}` : ""}; vm_copy local: ${COPY_ROOT ? `confined to ${COPY_ROOT}` : "disabled"})`),
	);
}

if (HTTP_LISTEN) serveHttp(HTTP_LISTEN);
else serveStdio();
