// Edge-grant tests: the real proxy's /edge/ route against a fake upstream (BOXERY_EDGE_UPSTREAM).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOKEN = "demo%3As3cret";
let upstream, proxy, port, seen, conf, logs = "", upReply = null;

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const setRoutes = (vm, hosts) => writeFileSync(path.join(conf, "edge", `${vm}.json`), JSON.stringify({ hosts }));
async function edge(p, { method = "GET", headers = {}, body, token = TOKEN } = {}) {
	seen = null;
	const r = await fetch(`http://127.0.0.1:${port}/edge/${token}${p}`, { method, headers, body, redirect: "manual" });
	return { status: r.status, text: await r.text(), headers: r.headers };
}

before(async () => {
	upstream = http.createServer((rq, rs) => {
		let b = "";
		rq.on("data", (c) => (b += c));
		rq.on("end", () => {
			seen = { url: rq.url, method: rq.method, headers: rq.headers, body: b };
			if (upReply) return upReply(rq, rs);
			rs.writeHead(200, { "content-type": "application/json", "set-cookie": "s=1" });
			rs.end('{"ok":true}');
		});
	});
	const up = await listen(upstream);
	conf = mkdtempSync(path.join(tmpdir(), "boxery-edge-"));
	mkdirSync(path.join(conf, "edge"));
	writeFileSync(path.join(conf, "tokens.json"), JSON.stringify({ demo: "s3cret", other: "x9" }));
	port = 20000 + Math.floor(Math.random() * 20000);
	proxy = spawn(process.execPath, [path.join(ROOT, "proxy/boxery-proxy.mjs")], {
		env: { ...process.env, BOXERY_CONF: conf, BOXERY_PROXY_PORT: String(port), BOXERY_EDGE_UPSTREAM: `http://127.0.0.1:${up}`, BOXERY_PI_AUTH: path.join(conf, "none.json") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proxy.stdout.on("data", (d) => (logs += d));
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("proxy did not start");
});
after(() => {
	proxy?.kill();
	upstream?.close();
	rmSync(conf, { recursive: true, force: true });
});

test("injects the granted header and strips the VM's own credentials", async () => {
	setRoutes("demo", { "api.example.com": { headers: { Authorization: "Bearer REAL" } } });
	const r = await edge("/api.example.com/v1/thing?x=1", { headers: { authorization: "Bearer guest-guess", cookie: "c=1", "x-api-key": "k", "x-custom": "kept" } });
	assert.equal(r.status, 200);
	assert.equal(seen.url, "/v1/thing?x=1");
	assert.equal(seen.headers.authorization, "Bearer REAL");
	assert.equal(seen.headers.cookie, undefined);
	assert.equal(seen.headers["x-api-key"], undefined);
	assert.equal(seen.headers["x-custom"], "kept");
	assert.ok(!JSON.stringify(seen).includes("s3cret"), "VM token must not reach the upstream");
	assert.equal(r.headers.get("set-cookie"), null);
});

test("custom header names", async () => {
	setRoutes("demo", { "api.example.com": { headers: { "X-Api-Key": "REAL" } } });
	await edge("/api.example.com/v1");
	assert.equal(seen.headers["x-api-key"], "REAL");
	assert.equal(seen.headers.authorization, undefined);
});

test("auth: bad, missing and other VMs' tokens", async () => {
	setRoutes("demo", { "api.example.com": { headers: { Authorization: "Bearer REAL" } } });
	for (const token of ["demo%3Awrong", "nobody%3As3cret", "", "%3As3cret", "demo"]) {
		const r = await edge("/api.example.com/v1", { token });
		assert.ok([401, 404].includes(r.status), `${token} → ${r.status}`);
		assert.equal(seen, null);
	}
	// "other" has a valid token but no routes: the demo grant is not shared
	const r = await edge("/api.example.com/v1", { token: "other%3Ax9" });
	assert.equal(r.status, 403);
	assert.equal(seen, null);
});

test("only granted, well-formed hosts", async () => {
	setRoutes("demo", { "api.example.com": { headers: { Authorization: "Bearer REAL" } } });
	for (const h of ["evil.example.com", "api.example.com.evil.net", "127.0.0.1", "localhost", "api.example.com:8443", "API.EXAMPLE.COM", "%2e%2e", "a..b.com"]) {
		const r = await edge(`/${h}/v1`);
		assert.ok([400, 401, 403, 404].includes(r.status), `${h} → ${r.status}`);
		assert.equal(seen, null, h);
	}
});

test("route changes take effect without a restart (revoke is immediate)", async () => {
	setRoutes("demo", { "api.example.com": { headers: { Authorization: "Bearer REAL" } } });
	assert.equal((await edge("/api.example.com/v1")).status, 200);
	setRoutes("demo", {});
	assert.equal((await edge("/api.example.com/v1")).status, 403);
});

test("read-only grants: fetch and git clone, but no writes or push", async () => {
	setRoutes("demo", { "github.com": { headers: { Authorization: "Basic X" }, readonly: true } });
	assert.equal((await edge("/github.com/o/r.git/info/refs?service=git-upload-pack")).status, 200);
	assert.equal((await edge("/github.com/o/r.git/git-upload-pack", { method: "POST", body: "x" })).status, 200);
	assert.equal((await edge("/github.com/o/r.git/info/refs?service=git-receive-pack")).status, 403);
	assert.equal((await edge("/github.com/o/r.git/git-receive-pack", { method: "POST", body: "x" })).status, 403);
	assert.equal((await edge("/github.com/repos/o/r/issues", { method: "POST", body: "{}" })).status, 403);
	assert.equal((await edge("/github.com/repos/o/r", { method: "DELETE" })).status, 403);
});

test("redirects: rewritten only to granted hosts, never followed", async () => {
	setRoutes("demo", { "api.example.com": { headers: { Authorization: "Bearer REAL" } }, "dl.example.com": { headers: {} } });
	upReply = (rq, rs) => rs.writeHead(302, { location: rq.url.includes("in") ? "https://dl.example.com/f?a=1" : "https://elsewhere.net/f" }).end();
	try {
		let r = await edge("/api.example.com/in");
		assert.equal(r.status, 302);
		assert.equal(r.headers.get("location"), `http://127.0.0.1:${port}/edge/${TOKEN}/dl.example.com/f?a=1`);
		r = await edge("/api.example.com/out");
		assert.equal(r.headers.get("location"), "https://elsewhere.net/f");
	} finally {
		upReply = null;
	}
});

test("bodies stream through (git push sized)", async () => {
	setRoutes("demo", { "api.example.com": { headers: { Authorization: "Bearer REAL" } } });
	const big = "x".repeat(5 * 1024 * 1024);
	const r = await edge("/api.example.com/upload", { method: "POST", body: big });
	assert.equal(r.status, 200);
	assert.equal(seen.body.length, big.length);
});

test("malformed route files and header values are ignored, not crashes", async () => {
	writeFileSync(path.join(conf, "edge", "demo.json"), "{not json");
	assert.equal((await edge("/api.example.com/v1")).status, 403);
	setRoutes("demo", { "api.example.com": { headers: { "Bad Header": "x", Authorization: "a\r\nInjected: 1" } } });
	assert.equal((await edge("/api.example.com/v1")).status, 200);
	assert.equal(seen.headers.authorization, undefined);
	assert.equal(seen.headers.injected, undefined);
});

test("the VM token never appears in the log", async () => {
	await new Promise((r) => setTimeout(r, 100));
	assert.match(logs, /EDGE/);
	assert.ok(!logs.includes("s3cret"), "token leaked into the proxy log");
	assert.ok(!logs.includes("REAL"), "credential leaked into the proxy log");
});
