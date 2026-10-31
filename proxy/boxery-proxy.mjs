#!/usr/bin/env node
// boxery LLM proxy: VMs hold only a per-VM token; real credentials stay on the host.
//
//   /chatgpt/* -> https://chatgpt.com/*               (ChatGPT/Codex OAuth from ~/.pi/agent/auth.json)
//   /openai/*  -> https://api.openai.com/*            (OPENAI_API_KEY)
//   /anthropic/* -> https://api.anthropic.com/*       (ANTHROPIC_API_KEY)
//   /ollama/*  -> http://127.0.0.1:11434/*            (no auth)
//
// Auth from VM: "Authorization: Bearer <token>" or "x-api-key: <token>".
// <token> is "name:secret" or a JWT-shaped string whose payload carries {"boxery":"name:secret"} (legacy key: "avm")
// (the Codex client derives the account id from a JWT, so we hand it a fake one).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const CONF = process.env.BOXERY_CONF ?? path.join(os.homedir(), ".config/boxery");
const TOKENS = path.join(CONF, "tokens.json");
const PI_AUTH = process.env.BOXERY_PI_AUTH ?? path.join(os.homedir(), ".pi/agent/auth.json");
const PORT = Number(process.env.BOXERY_PROXY_PORT ?? 8088);
const HOST = process.env.BOXERY_PROXY_BIND ?? "127.0.0.1";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const JWT_CLAIM = "https://api.openai.com/auth";

function loadEnvFile() {
	const f = path.join(CONF, "proxy.env");
	if (!fs.existsSync(f)) return;
	for (const line of fs.readFileSync(f, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
}
loadEnvFile();

function readTokens() {
	try {
		return JSON.parse(fs.readFileSync(TOKENS, "utf8"));
	} catch {
		return {};
	}
}

function b64urlJson(s) {
	return JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

/** Returns the VM name for a valid token, else null. */
function authenticate(req) {
	let raw = req.headers["x-api-key"] ?? "";
	const authz = req.headers.authorization ?? "";
	if (authz.toLowerCase().startsWith("bearer ")) raw = authz.slice(7).trim();
	if (!raw) return null;
	let cred = raw;
	const parts = raw.split(".");
	if (parts.length === 3) {
		try {
			const payload = b64urlJson(parts[1]);
			cred = payload?.boxery ?? payload?.avm; // "avm": tokens minted before the rename to boxery
		} catch {
			return null;
		}
	}
	if (typeof cred !== "string") return null;
	const i = cred.indexOf(":");
	if (i < 1) return null;
	const name = cred.slice(0, i);
	const secret = cred.slice(i + 1);
	const tokens = readTokens();
	return tokens[name] && tokens[name] === secret ? name : null;
}

// ---- Codex OAuth (shared with host pi's auth.json) ----
let refreshing = null;
async function codexCreds() {
	const auth = JSON.parse(fs.readFileSync(PI_AUTH, "utf8"));
	const c = auth["openai-codex"];
	if (!c?.access) throw new Error("no openai-codex credentials in " + PI_AUTH + " (run `pi` then /login on the host)");
	if (c.expires - Date.now() > 5 * 60_000) return c;
	refreshing ??= (async () => {
		const res = await fetch("https://auth.openai.com/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refresh, client_id: CODEX_CLIENT_ID }),
		});
		if (!res.ok) throw new Error(`codex refresh failed: ${res.status} ${await res.text()}`);
		const j = await res.json();
		const fresh = JSON.parse(fs.readFileSync(PI_AUTH, "utf8"));
		const accountId = b64urlJson(j.access_token.split(".")[1])?.[JWT_CLAIM]?.chatgpt_account_id ?? c.accountId;
		fresh["openai-codex"] = { ...c, access: j.access_token, refresh: j.refresh_token, expires: Date.now() + j.expires_in * 1000, accountId };
		const tmp = PI_AUTH + ".boxery.tmp";
		fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, PI_AUTH);
		log("refreshed codex token");
		return fresh["openai-codex"];
	})().finally(() => (refreshing = null));
	return refreshing;
}

const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "content-length"]);

// Per-route allowlist of [METHOD, path regex] (path = after the route prefix). Requests outside it are
// rejected before credentials are attached: VMs get inference, not account administration.
const ALLOW = {
	chatgpt: [["POST", /^\/backend-api\/codex\/responses$/]],
	openai: [
		["POST", /^\/v1\/(responses|chat\/completions|completions|embeddings)$/],
		["GET", /^\/v1\/models(\/[\w.:-]+)?$/],
	],
	anthropic: [
		["POST", /^\/v1\/messages(\/count_tokens)?$/],
		["GET", /^\/v1\/models(\/[\w.:-]+)?$/],
	],
	ollama: [
		["POST", /^\/v1\/(chat\/completions|completions|embeddings)$/],
		["GET", /^\/v1\/models(\/[\w.:/-]+)?$/],
		["POST", /^\/api\/(chat|generate|embed|embeddings|show)$/],
		["GET", /^\/api\/(tags|version)$/],
	],
};
export const allowed = (route, method, p) => (ALLOW[route] ?? []).some(([m, re]) => m === method && re.test(p));

const LIMITS = {
	maxBody: Number(process.env.BOXERY_PROXY_MAX_BODY ?? 32 * 1024 * 1024), // request body bytes
	perVm: Number(process.env.BOXERY_PROXY_MAX_CONCURRENT ?? 8), // concurrent requests per VM
	maxMs: Number(process.env.BOXERY_PROXY_MAX_MS ?? 30 * 60_000), // wall time per request
};
const active = new Map(); // vm → in-flight count

const routes = {
	chatgpt: {
		base: "https://chatgpt.com",
		async auth(h) {
			const c = await codexCreds();
			h.set("authorization", `Bearer ${c.access}`);
			h.set("chatgpt-account-id", c.accountId);
		},
	},
	openai: {
		base: "https://api.openai.com",
		async auth(h) {
			if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set in proxy.env");
			h.set("authorization", `Bearer ${process.env.OPENAI_API_KEY}`);
		},
	},
	anthropic: {
		base: "https://api.anthropic.com",
		async auth(h) {
			if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set in proxy.env");
			h.delete("authorization");
			h.set("x-api-key", process.env.ANTHROPIC_API_KEY);
		},
	},
	ollama: {
		base: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
		async auth(h) {
			h.delete("authorization");
		},
	},
};

function log(...a) {
	console.log(new Date().toISOString(), ...a);
}

const server = http.createServer((req, res) => {
	handle(req, res).catch((e) => {
		log("UNHANDLED", e?.message);
		if (!res.headersSent) res.writeHead(500);
		res.end();
	});
});
async function handle(req, res) {
	const started = Date.now();
	const url = new URL(req.url, "http://x");
	if (url.pathname === "/healthz") return res.end("ok\n");
	const [, routeName, ...rest] = url.pathname.split("/");
	const route = routes[routeName];
	if (!route) {
		res.writeHead(404).end("unknown route\n");
		return;
	}
	const vm = authenticate(req);
	if (!vm) {
		res.writeHead(401, { "content-type": "application/json" }).end('{"error":"invalid boxery token"}\n');
		log("401", req.method, url.pathname);
		return;
	}
	const subpath = "/" + rest.join("/");
	if (!allowed(routeName, req.method, subpath)) {
		res.writeHead(403, { "content-type": "application/json" }).end(`{"error":"not an allowed inference endpoint: ${req.method} /${routeName}${subpath.replace(/["\\]/g, "")}"}\n`);
		log(vm, "403", req.method, routeName, subpath);
		return;
	}
	const len = Number(req.headers["content-length"] ?? 0);
	if (len > LIMITS.maxBody) {
		res.writeHead(413).end("request body too large\n");
		return;
	}
	if ((active.get(vm) ?? 0) >= LIMITS.perVm) {
		res.writeHead(429, { "retry-after": "2" }).end("too many concurrent requests for this VM\n");
		return;
	}
	active.set(vm, (active.get(vm) ?? 0) + 1);
	// Abort the upstream call when the guest disconnects or the wall-time limit hits, so abandoned
	// requests stop costing money.
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(new Error("request exceeded time limit")), LIMITS.maxMs);
	let done = false; // set once we've finished writing the response; later "close" events are normal
	res.on("close", () => {
		if (!done) ac.abort(new Error("client disconnected"));
	});
	try {
		const h = new Headers();
		for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v != null) h.set(k, Array.isArray(v) ? v.join(", ") : v);
		h.delete("x-api-key");
		h.delete("chatgpt-account-id");
		await route.auth(h);
		const target = `${route.base}${subpath}${url.search}`;
		const hasBody = !["GET", "HEAD"].includes(req.method);
		let seen = 0;
		const body = hasBody
			? Readable.toWeb(
					req.pipe(
						new Transform({
							transform(chunk, _e, cb) {
								seen += chunk.length;
								if (seen > LIMITS.maxBody) return cb(new Error("request body too large"));
								cb(null, chunk);
							},
						}),
					),
				)
			: undefined;
		const up = await fetch(target, { method: req.method, headers: h, body, duplex: hasBody ? "half" : undefined, redirect: "manual", signal: ac.signal });
		const outHeaders = {};
		up.headers.forEach((v, k) => {
			if (!HOP.has(k) && k !== "content-encoding") outHeaders[k] = v;
		});
		res.writeHead(up.status, outHeaders);
		// pipeline respects backpressure from slow guests and tears down both sides on error/abort
		if (up.body) await pipeline(Readable.fromWeb(up.body), res);
		else res.end();
		done = true;
		log(vm, req.method, routeName, subpath, up.status, `${Date.now() - started}ms`);
	} catch (e) {
		const msg = ac.signal.aborted ? String(ac.signal.reason?.message ?? "aborted") : e.message;
		// Clients often close a stream once they have the final event; that's not an error.
		log(vm, msg === "client disconnected" ? "closed-by-client" : "ERROR", req.method, routeName, subpath, `${Date.now() - started}ms`, msg === "client disconnected" ? "" : msg);
		if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
		if (!res.writableEnded) res.end(JSON.stringify({ error: msg }) + "\n");
	} finally {
		clearTimeout(timer);
		const n = (active.get(vm) ?? 1) - 1;
		n > 0 ? active.set(vm, n) : active.delete(vm);
	}
}
process.on("uncaughtException", (e) => log("uncaught", e?.message));
// Refuse websocket upgrades so clients fall back to SSE.
server.on("upgrade", (_req, sock) => sock.end("HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\n\r\n"));
server.requestTimeout = 0;
server.listen(PORT, HOST, () => log(`boxery-proxy on http://${HOST}:${PORT}`));
