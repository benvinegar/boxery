#!/usr/bin/env node
// agentvm LLM proxy: VMs hold only a per-VM token; real credentials stay on the host.
//
//   /chatgpt/* -> https://chatgpt.com/*               (ChatGPT/Codex OAuth from ~/.pi/agent/auth.json)
//   /openai/*  -> https://api.openai.com/*            (OPENAI_API_KEY)
//   /anthropic/* -> https://api.anthropic.com/*       (ANTHROPIC_API_KEY)
//   /ollama/*  -> http://127.0.0.1:11434/*            (no auth)
//
// Auth from VM: "Authorization: Bearer <token>" or "x-api-key: <token>".
// <token> is "name:secret" or a JWT-shaped string whose payload carries {"avm":"name:secret"}
// (the Codex client derives the account id from a JWT, so we hand it a fake one).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const CONF = process.env.AGENTVM_CONF ?? path.join(os.homedir(), ".config/agentvm");
const TOKENS = path.join(CONF, "tokens.json");
const PI_AUTH = process.env.AGENTVM_PI_AUTH ?? path.join(os.homedir(), ".pi/agent/auth.json");
const PORT = Number(process.env.AGENTVM_PROXY_PORT ?? 8088);
const HOST = process.env.AGENTVM_PROXY_BIND ?? "127.0.0.1";
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
			cred = b64urlJson(parts[1])?.avm;
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
		const tmp = PI_AUTH + ".agentvm.tmp";
		fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, PI_AUTH);
		log("refreshed codex token");
		return fresh["openai-codex"];
	})().finally(() => (refreshing = null));
	return refreshing;
}

const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "content-length"]);

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
		res.writeHead(401, { "content-type": "application/json" }).end('{"error":"invalid agentvm token"}\n');
		log("401", req.method, url.pathname);
		return;
	}
	try {
		const h = new Headers();
		for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v != null) h.set(k, Array.isArray(v) ? v.join(", ") : v);
		h.delete("x-api-key");
		h.delete("chatgpt-account-id");
		await route.auth(h);
		const target = `${route.base}/${rest.join("/")}${url.search}`;
		const hasBody = !["GET", "HEAD"].includes(req.method);
		const up = await fetch(target, {
			method: req.method,
			headers: h,
			body: hasBody ? Readable.toWeb(req) : undefined,
			duplex: hasBody ? "half" : undefined,
			redirect: "manual",
		});
		const outHeaders = {};
		up.headers.forEach((v, k) => {
			if (!HOP.has(k) && k !== "content-encoding") outHeaders[k] = v;
		});
		res.writeHead(up.status, outHeaders);
		if (up.body) for await (const chunk of up.body) res.write(chunk);
		res.end();
		log(vm, req.method, routeName, "/" + rest.join("/"), up.status, `${Date.now() - started}ms`);
	} catch (e) {
		log(vm, "ERROR", url.pathname, e.message);
		if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: String(e.message) }) + "\n");
	}
}
process.on("uncaughtException", (e) => log("uncaught", e?.message));
// Refuse websocket upgrades so clients fall back to SSE.
server.on("upgrade", (_req, sock) => sock.end("HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\n\r\n"));
server.requestTimeout = 0;
server.listen(PORT, HOST, () => log(`agentvm-proxy on http://${HOST}:${PORT}`));
