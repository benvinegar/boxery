// Proxy tests: runs the real proxy against a fake upstream ("ollama" route) and a temp token file.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
let upstream, proxy, port, seen, conf;
const ALL_LLM = ["chatgpt", "openai", "anthropic", "ollama"];
/** What `boxery grant demo llm:…` leaves on the host (edge-set): the providers this VM may use. */
const grantLlm = (llm, extra = {}) => writeFileSync(path.join(conf, "edge", "demo.json"), JSON.stringify({ hosts: {}, llm, ...extra }));

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const jwt = (payload) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
/** @param {string} p @param {{ method?: string, headers?: Record<string, any>, body?: string }} [opts] */
async function req(p, { method = "GET", headers = {}, body } = {}) {
	const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body });
	return { status: r.status, text: await r.text() };
}

before(async () => {
	upstream = http.createServer((rq, rs) => {
		let b = "";
		rq.on("data", (c) => (b += c));
		rq.on("end", () => {
			seen = { url: rq.url, method: rq.method, headers: rq.headers, body: b };
			rs.writeHead(200, { "content-type": "application/json" });
			rs.end(JSON.stringify({ ok: true }));
		});
	});
	const up = await listen(upstream);
	conf = mkdtempSync(path.join(tmpdir(), "boxery-proxy-"));
	writeFileSync(path.join(conf, "tokens.json"), JSON.stringify({ demo: "s3cret" }));
	mkdirSync(path.join(conf, "edge"));
	grantLlm(ALL_LLM);
	// A port the OS just handed out (a random pick can collide with another suite's proxy, which answers
	// /healthz too and would make these tests talk to the wrong server).
	const probe = http.createServer();
	port = await listen(probe);
	await new Promise((r) => probe.close(r));
	proxy = spawn(process.execPath, [path.join(ROOT, "proxy/boxery-proxy.mjs")], {
		env: { ...process.env, BOXERY_PROXY_MAX_BODY: String(1024 * 1024), BOXERY_CONF: conf, BOXERY_PROXY_PORT: String(port), OLLAMA_URL: `http://127.0.0.1:${up}`, BOXERY_PI_AUTH: path.join(conf, "none.json") },
		stdio: "ignore",
	});
	for (let i = 0; i < 50; i++) {
		try {
			if ((await req("/healthz")).status === 200) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("proxy did not start");
});
after(() => {
	proxy?.kill();
	upstream?.close();
});

test("healthz", async () => assert.equal((await req("/healthz")).status, 200));

test("rejects missing, wrong and malformed tokens without crashing", async () => {
	const cases = [
		{},
		{ authorization: "Bearer demo:wrong" },
		{ authorization: "Bearer demo:s3cre" },
		{ authorization: "Bearer demo:s3cretx" },
		{ authorization: `Bearer demo:s3cret${"x".repeat(4096)}` },
		{ authorization: "Bearer demo:" },
		{ authorization: "Bearer nobody:s3cret" },
		{ authorization: "Bearer :s3cret" },
		{ authorization: `Bearer ${jwt({ boxery: {} })}` },
		{ authorization: `Bearer ${jwt({ boxery: 42 })}` },
		{ authorization: "Bearer null.bnVsbA.x" },
		{ authorization: "Bearer a.%%%.b" },
		{ "x-api-key": "demo:wrong" },
	];
	for (const h of cases) assert.equal((await req("/ollama/v1/models", { headers: h })).status, 401, JSON.stringify(h));
	assert.equal((await req("/healthz")).status, 200, "proxy still alive");
});

test("valid token (plain, x-api-key, JWT-wrapped) reaches upstream with VM auth stripped", async () => {
	for (const h of [{ authorization: "Bearer demo:s3cret" }, { "x-api-key": "demo:s3cret" }, { authorization: `Bearer ${jwt({ boxery: "demo:s3cret" })}` }]) {
		const r = await req("/ollama/v1/chat/completions?x=1", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: '{"m":1}' });
		assert.equal(r.status, 200);
		assert.equal(seen.url, "/v1/chat/completions?x=1");
		assert.equal(seen.body, '{"m":1}');
		assert.equal(seen.headers.authorization, undefined, "VM token must not reach upstream");
		assert.equal(seen.headers["x-api-key"], undefined);
	}
});

test("only inference endpoints are allowed (admin/account APIs → 403 before credentials)", async () => {
	const h = { authorization: "Bearer demo:s3cret" };
	seen = undefined;
	for (const [method, p] of [
		["DELETE", "/ollama/api/delete"],
		["POST", "/ollama/api/pull"],
		["POST", "/ollama/api/create"],
		["GET", "/openai/v1/files"],
		["POST", "/openai/v1/fine_tuning/jobs"],
		["GET", "/chatgpt/backend-api/me"],
		["POST", "/ollama/v1/chat/completions/../../api/pull"],
	]) {
		const r = await req(p, { method, headers: h, body: method === "GET" ? undefined : "{}" });
		assert.ok([403, 404].includes(r.status), `${method} ${p} → ${r.status}`);
	}
	assert.equal(seen, undefined, "nothing reached upstream");
	assert.equal((await req("/ollama/api/tags", { headers: h })).status, 200);
});

test("request body limit", async () => {
	const big = "x".repeat(2 * 1024 * 1024);
	const r = await req("/ollama/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer demo:s3cret" }, body: big });
	assert.equal(r.status, 413);
});

test("unknown route → 404; missing upstream credentials → 502 (not a crash)", async () => {
	assert.equal((await req("/nope/x", { headers: { authorization: "Bearer demo:s3cret" } })).status, 404);
	const r = await req("/anthropic/v1/messages", { method: "POST", headers: { authorization: "Bearer demo:s3cret" }, body: "{}" });
	assert.equal(r.status, 502);
	assert.match(r.text, /ANTHROPIC_API_KEY/);
});

test("tokens file changes take effect without restart (revocation)", async () => {
	const h = { authorization: "Bearer demo:s3cret" };
	assert.equal((await req("/ollama/v1/models", { headers: h })).status, 200);
	writeFileSync(path.join(conf, "tokens.json"), JSON.stringify({}));
	assert.equal((await req("/ollama/v1/models", { headers: h })).status, 401);
	writeFileSync(path.join(conf, "tokens.json"), JSON.stringify({ demo: "s3cret" }));
});

test("LLM routes are deny-by-default: no grant file, no llm list, or another provider's grant → 403", async () => {
	const h = { authorization: "Bearer demo:s3cret" };
	const f = path.join(conf, "edge", "demo.json");
	try {
		const cases = [
			["no edge file", () => rmSync(f, { force: true })],
			["unreadable/garbage edge file", () => writeFileSync(f, "{not json")],
			["http grants only (old host-map format)", () => writeFileSync(f, JSON.stringify({ hosts: { "api.example.com": { headers: {} } } }))],
			["llm not a list", () => grantLlm("ollama")],
			["empty llm list", () => grantLlm([])],
			["another provider granted", () => grantLlm(["chatgpt", "anthropic"])],
		];
		for (const [label, setup] of cases) {
			setup();
			seen = undefined;
			const r = await req("/ollama/v1/chat/completions", { method: "POST", headers: h, body: "{}" });
			assert.equal(r.status, 403, label);
			assert.match(r.text, /llm:ollama is not granted to this VM \(boxery grant demo llm:ollama\)/, label);
			assert.equal(seen, undefined, `${label}: nothing reached upstream`);
		}
		// Grant → works on the next request; revoke → refused on the next request. No restart.
		grantLlm(["ollama"]);
		assert.equal((await req("/ollama/v1/models", { headers: h })).status, 200, "granted");
		assert.equal((await req("/anthropic/v1/messages", { method: "POST", headers: h, body: "{}" })).status, 403, "only the granted provider");
		grantLlm([]);
		assert.equal((await req("/ollama/v1/models", { headers: h })).status, 403, "revoked");
	} finally {
		grantLlm(ALL_LLM);
	}
});

test("an LLM grant is per VM: another VM's token gets nothing", async () => {
	writeFileSync(path.join(conf, "tokens.json"), JSON.stringify({ demo: "s3cret", other: "pw" }));
	try {
		const r = await req("/ollama/v1/models", { headers: { authorization: "Bearer other:pw" } });
		assert.equal(r.status, 403);
		assert.match(r.text, /boxery grant other llm:ollama/);
	} finally {
		writeFileSync(path.join(conf, "tokens.json"), JSON.stringify({ demo: "s3cret" }));
	}
});

test("the grant check runs after authentication (no grant info leaks to bad tokens)", async () => {
	assert.equal((await req("/ollama/v1/models", { headers: { authorization: "Bearer other:nope" } })).status, 401);
});
