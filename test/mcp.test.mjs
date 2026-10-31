// MCP server protocol tests with a fake VM: an `ssh` stub on PATH runs the remote script locally
// (in a temp "VM home"), and BOXERY_BIN points at a stub controller.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER = path.join(ROOT, "mcp/boxery-mcp.mjs");
let dir, env;

before(() => {
	dir = mkdtempSync(path.join(tmpdir(), "boxery-mcp-"));
	const bin = path.join(dir, "bin");
	const vmroot = path.join(dir, "vm");
	mkdirSync(bin);
	mkdirSync(path.join(vmroot, "project"), { recursive: true });
	mkdirSync(path.join(dir, "home"));
	writeFileSync(path.join(dir, "home/ssh_config"), "# fake\n");
	// ssh -F CONF -o BatchMode=yes NAME.boxery "bash -c '<script>'": run the script locally, cwd = fake VM home.
	// /home/agent is rewritten to the fake VM root so absolute VM paths stay inside the sandbox.
	writeFileSync(
		path.join(bin, "ssh"),
		`#!/usr/bin/env bash
host=""; while [ $# -gt 1 ]; do case $1 in -F|-o) shift 2 ;; *.boxery) host=$1; shift ;; *) shift ;; esac; done
[ "$host" = "fakevm.boxery" ] || { echo "ssh: unknown host $host" >&2; exit 255; }
cmd=\${1//\\/home\\/agent/${vmroot}}
cd "${vmroot}" && HOME="${vmroot}" PATH="${bin}:$PATH" exec bash -c "$cmd"
`,
	);
	// macOS has no setsid; emulate "new process group + wait" with perl (present on macOS and Linux).
	writeFileSync(path.join(bin, "setsid"), `#!/usr/bin/env bash\n[ "$1" = -w ] && shift\nexec perl -e 'setpgrp(0,0); exec @ARGV or die' -- "$@"\n`);
	chmodSync(path.join(bin, "setsid"), 0o755);
	writeFileSync(path.join(bin, "boxery"), `#!/usr/bin/env bash\necho "stub boxery $*"\n[ "$1" = ls ] && printf 'NAME STATE\\nfakevm running\\n'\nexit 0\n`);
	chmodSync(path.join(bin, "ssh"), 0o755);
	chmodSync(path.join(bin, "boxery"), 0o755);
	env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BOXERY_HOME: path.join(dir, "home"), BOXERY_BIN: path.join(bin, "boxery") };
	env.VMROOT = vmroot;
});

/** Start the stdio server, return a client with call(method, params). */
function client(args = []) {
	const p = spawn(process.execPath, [SERVER, ...args], { env, stdio: ["pipe", "pipe", "ignore"] });
	let buf = "";
	const waiting = new Map();
	p.stdout.on("data", (d) => {
		buf += d;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const msg = JSON.parse(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
			waiting.get(msg.id)?.(msg);
		}
	});
	let id = 0;
	const call = (method, params) =>
		new Promise((resolve) => {
			const i = ++id;
			waiting.set(i, resolve);
			p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method, params })}\n`);
		});
	const tool = async (name, args) => (await call("tools/call", { name, arguments: args })).result;
	return { p, call, tool, notify: (method) => p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`), close: () => p.kill() };
}

describe("stdio", () => {
	let c;
	before(async () => {
		c = client(["--vm", "fakevm"]);
		const init = await c.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
		assert.equal(init.result.serverInfo.name, "boxery");
		assert.equal(init.result.protocolVersion, "2025-06-18");
		assert.match(init.result.instructions, /fakevm/);
		c.notify("notifications/initialized");
	});
	after(() => c.close());

	test("tools/list exposes the vm_* tools with schemas", async () => {
		const { tools } = (await c.call("tools/list")).result;
		const names = tools.map((t) => t.name);
		for (const n of ["vm_bash", "vm_read", "vm_write", "vm_edit", "vm_copy", "vm_screenshot", "vm_click", "vm_type", "vm_key", "vm_scroll", "vm_browser", "vm_manage"])
			assert.ok(names.includes(n), n);
		for (const t of tools) assert.equal(t.inputSchema.type, "object", t.name);
		assert.ok(!tools.some((t) => "run" in t), "internal fields not leaked");
	});

	test("vm_bash runs in the VM with exit codes", async () => {
		const r = await c.tool("vm_bash", { command: "echo hi; pwd" });
		assert.equal(r.isError, false);
		assert.match(r.content[0].text, /^hi\n.*project\n/);
		const bad = await c.tool("vm_bash", { command: "echo oops; exit 3" });
		assert.equal(bad.isError, true);
		assert.match(bad.content[0].text, /\[exit 3\]/);
	});

	test("vm_write / vm_edit / vm_read round trip, including shell-hostile content", async () => {
		const content = `line1\nit's $(not run) \`nor this\`\n"quoted"\n`;
		assert.equal((await c.tool("vm_write", { path: "dir/f.txt", content })).isError, false);
		assert.equal(readFileSync(path.join(env.VMROOT, "project/dir/f.txt"), "utf8"), content);
		assert.equal((await c.tool("vm_edit", { path: "dir/f.txt", edits: [{ oldText: "line1", newText: "LINE1" }] })).isError, false);
		const r = await c.tool("vm_read", { path: "dir/f.txt" });
		assert.match(r.content[0].text, /^LINE1\nit's \$\(not run\)/);
		const ambiguous = await c.tool("vm_edit", { path: "dir/f.txt", edits: [{ oldText: "t", newText: "T" }] });
		assert.equal(ambiguous.isError, true);
	});

	test("vm_read offset/limit and missing files", async () => {
		await c.tool("vm_write", { path: "n.txt", content: "1\n2\n3\n4\n5" });
		const r = await c.tool("vm_read", { path: "n.txt", offset: 2, limit: 2 });
		assert.match(r.content[0].text, /^2\n3\n\n\[showing lines 2-3 of 5/);
		assert.equal((await c.tool("vm_read", { path: "missing.txt" })).isError, true);
	});

	test("errors are tool errors, never crashes: bad VM names, unknown tools, unknown methods", async () => {
		assert.match((await c.tool("vm_bash", { vm: "Bad;Name", command: "x" })).content[0].text, /invalid VM name/);
		assert.match((await c.tool("vm_bash", { vm: "othervm", command: "x" })).content[0].text, /unreachable/);
		assert.equal((await c.call("tools/call", { name: "nope", arguments: {} })).error.code, -32602);
		assert.equal((await c.call("nope/method")).error.code, -32601);
		assert.ok((await c.call("ping")).result);
	});

	test("hostile file names never execute (read/edit error paths)", async () => {
		const marker = path.join(env.VMROOT, "pwned");
		await c.tool("vm_read", { path: `nope$(touch ${marker})` });
		await c.tool("vm_edit", { path: `nope$(touch ${marker})`, edits: [{ oldText: "a", newText: "b" }] });
		assert.equal(existsSync(marker), false);
	});

	test("snapshot names are validated before reaching the controller", async () => {
		const r = await c.tool("vm_manage", { action: "snap", name: "fakevm", snapshot: "x; touch /tmp/pwned #" });
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /invalid snapshot name/);
	});

	test("endless output is bounded (no unbounded buffering)", async () => {
		const r = await c.tool("vm_bash", { command: "yes | head -c 30000000; echo; echo END" });
		assert.match(r.content[0].text, /END/);
		assert.ok(r.content[0].text.length < 300_000, `returned ${r.content[0].text.length} chars`);
	});

	test("vm_copy failures are reported, not swallowed", async () => {
		const ro = path.join(env.VMROOT, "ro");
		mkdirSync(ro, { recursive: true });
		chmodSync(ro, 0o500);
		const src = path.join(env.VMROOT, "project/copy-src.txt");
		writeFileSync(src, "x");
		const r = await c.tool("vm_copy", { from: `local:${src}`, to: "/home/agent/ro/sub/x.txt" });
		chmodSync(ro, 0o700);
		assert.equal(r.isError, true, r.content[0].text);
	});

	test("timeouts kill the remote process group", async () => {
		const pidFile = path.join(env.VMROOT, "sleeper.pid");
		const r = await c.tool("vm_bash", { command: `sleep 300 & echo $! > ${pidFile}; wait`, timeout: 1 });
		assert.match(r.content[0].text, /timed out/);
		await new Promise((res) => setTimeout(res, 2500));
		const pid = Number(readFileSync(pidFile, "utf8"));
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		assert.equal(alive, false, "background child survived the timeout");
	});

	test("vm_manage uses the controller and tracks the current VM per session", async () => {
		assert.match((await c.tool("vm_manage", { action: "list" })).content[0].text, /current: fakevm/);
		assert.match((await c.tool("vm_manage", { action: "none" })).content[0].text, /no current VM/);
		assert.match((await c.tool("vm_bash", { command: "x" })).content[0].text, /no current VM/);
		assert.match((await c.tool("vm_manage", { action: "grants", name: "fakevm" })).content[0].text, /stub boxery grants fakevm/);
		assert.equal((await c.tool("vm_manage", { action: "bogus" })).isError, true);
	});
});

describe("http", () => {
	let p, port;
	const token = "t0ken";
	const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
	const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
	const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { ...H, ...headers }, body: JSON.stringify(body) });

	before(async () => {
		port = 20000 + Math.floor(Math.random() * 20000);
		p = spawn(process.execPath, [SERVER, "--http", `127.0.0.1:${port}`, "--vm", "fakevm", "--allow-user", "me@x"], { env: { ...env, BOXERY_MCP_TOKEN: token }, stdio: "ignore" });
		for (let i = 0; i < 50; i++) {
			try {
				if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
			} catch {}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error("http server did not start");
	});
	after(() => p?.kill());

	test("refuses to start without a token", async () => {
		const q = spawn(process.execPath, [SERVER, "--http", "127.0.0.1:1"], { env: { ...env, BOXERY_MCP_TOKEN: "" }, stdio: "ignore" });
		const code = await new Promise((r) => q.on("exit", r));
		assert.equal(code, 2);
	});

	test("--allow-user is refused unless listening on loopback", async () => {
		const q = spawn(process.execPath, [SERVER, "--http", "0.0.0.0:1", "--allow-user", "a@b"], { env: { ...env, BOXERY_MCP_TOKEN: "t" }, stdio: "ignore" });
		assert.equal(await new Promise((r) => q.on("exit", r)), 2);
	});

	test("auth: token required, Tailscale user allowlist, Origin check", async () => {
		assert.equal((await post(init)).status, 401);
		assert.equal((await post(init, { authorization: "Bearer nope" })).status, 401);
		assert.equal((await post(init, { authorization: `Bearer ${token}` })).status, 403, "no tailscale user");
		assert.equal((await post(init, { authorization: `Bearer ${token}`, "tailscale-user-login": "evil@x" })).status, 403);
		assert.equal((await post(init, { authorization: `Bearer ${token}`, "tailscale-user-login": "me@x", origin: "https://evil.example" })).status, 403);
	});

	test("session lifecycle and tool calls", async () => {
		const auth = { authorization: `Bearer ${token}`, "tailscale-user-login": "me@x" };
		const r = await post(init, auth);
		assert.equal(r.status, 200);
		const sid = r.headers.get("mcp-session-id");
		assert.ok(sid);
		assert.equal((await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, auth)).status, 404, "missing session");
		assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...auth, "mcp-session-id": sid })).status, 202);
		const call = await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vm_bash", arguments: { command: "echo via-http" } } }, { ...auth, "mcp-session-id": sid })).json();
		assert.match(call.result.content[0].text, /via-http/);
		const del = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "DELETE", headers: { ...auth, "mcp-session-id": sid } });
		assert.equal(del.status, 204);
		assert.equal((await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { ...auth, "mcp-session-id": sid })).status, 404, "deleted session");
	});
});
