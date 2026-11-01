// MCP server protocol tests with a fake VM: an `ssh` stub on PATH runs the remote script locally
// (in a temp "VM home"), and BOXERY_BIN points at a stub controller.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
	const tar = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
	mkdirSync(bin);
	// Capture the actual wire archive: macOS extraction consumes AppleDouble entries, while Linux
	// extraction leaves them as ._* files. Checking just the extracted fake VM would miss the bug.
	writeFileSync(path.join(bin, "tar"), `#!/usr/bin/env bash\nset -eo pipefail\nif [ "$1" = -cf ]; then\n${JSON.stringify(tar)} "$@" | tee ${JSON.stringify(path.join(dir, "copy.tar"))}\nelse exec ${JSON.stringify(tar)} "$@"; fi\n`);
	chmodSync(path.join(bin, "tar"), 0o755);
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
	writeFileSync(
		path.join(bin, "boxery"),
		`#!/usr/bin/env bash
[ "$1" != --host ] || shift 2
case "$*" in
"ls --json") echo '[{"name":"fakevm","state":"running","addr":"10.0.0.2","disk":"1GiB","lease":null,"shape":"standard","cpus":4,"mem":8192,"grants":[{"kind":"ssh-agent"},{"kind":"env","var":"TOKEN","cmd":null}]}]' ;;
"shapes --json") echo '{"default":"standard","shapes":{"standard":{"cpus":4,"mem":8192,"disk":40},"large":{"cpus":8,"mem":16384,"disk":80}}}' ;;
"grants "*" --json") echo '[{"kind":"file","local":"/l/.env","remote":"/home/agent/project/.env"}]' ;;
"snaps "*" --json") echo '[{"name":"s1","created":"2026-10-01T00:00:00Z","size":"1.2G","legacy":false}]' ;;
"new slow"*) echo "==> creating slow"; sleep 1.2; echo "==> slow is ready" ;;
*) echo "stub boxery $*" ;;
esac
exit 0
`,
	);
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
	const notifications = [];
	p.stdout.on("data", (d) => {
		buf += d;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const msg = JSON.parse(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
			if (msg.id === undefined) notifications.push(msg);
			else waiting.get(msg.id)?.(msg);
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
	return { p, call, tool, notifications, notify: (method) => p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`), close: () => p.kill() };
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
		for (const n of ["vm_bash", "vm_jobs", "vm_read", "vm_write", "vm_edit", "vm_copy", "vm_screenshot", "vm_click", "vm_type", "vm_key", "vm_scroll", "vm_browser", "vm_manage", "vm_info"])
			assert.ok(names.includes(n), n);
		for (const t of tools) assert.equal(t.inputSchema.type, "object", t.name);
		assert.ok(!tools.some((t) => "run" in t), "internal fields not leaked");
	});

	test("tools/list is the shared tool table plus host selection", async () => {
		const { TOOLS } = await import("../core/boxery-tools.mjs");
		const { tools } = (await c.call("tools/list")).result;
		assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name));
		for (const shared of TOOLS) {
			const t = tools.find((x) => x.name === shared.name);
			const { host, ...props } = t.inputSchema.properties;
			assert.ok(host, `${t.name} takes host`);
			if (t.name === "vm_manage") {
				assert.deepEqual(props.action.enum, [...shared.parameters.properties.action.enum, "hosts", "host"]);
				continue;
			}
			if (t.name === "vm_info") {
				assert.deepEqual(props.action.enum, [...shared.parameters.properties.action.enum, "hosts"]);
				continue;
			}
			assert.equal(t.description, shared.description, t.name);
			assert.deepEqual({ ...t.inputSchema, properties: props }, shared.parameters, t.name);
		}
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

	test("vm_copy round-trips a checkout without macOS metadata sidecars", async () => {
		const src = path.join(dir, "copy source");
		mkdirSync(path.join(src, ".git/objects/pack"), { recursive: true });
		const file = "file's.txt";
		writeFileSync(path.join(src, file), "COPY_OK\n");
		writeFileSync(path.join(src, ".git/objects/pack/pack-test.idx"), "index\n");
		if (process.platform === "darwin") {
			for (const f of [file, ".git/objects/pack/pack-test.idx"])
				execFileSync("xattr", ["-w", "com.boxery.copy-test", "metadata", path.join(src, f)]);
		}
		const uploaded = await c.tool("vm_copy", { from: `local:${src}`, to: "copied-checkout" });
		assert.equal(uploaded.isError, false, uploaded.content[0].text);
		// Inspect raw headers: BSD tar also hides AppleDouble entries in its normal listing.
		const archive = readFileSync(path.join(dir, "copy.tar"));
		for (let at = 0; at + 512 <= archive.length;) {
			const name = archive.subarray(at, at + 100).toString().replace(/\0.*$/s, "");
			if (!name) break;
			assert.ok(!path.basename(name).startsWith("._"), `wire archive contains AppleDouble entry: ${name}`);
			const size = Number.parseInt(archive.subarray(at + 124, at + 136).toString().trim(), 8) || 0;
			at += 512 + Math.ceil(size / 512) * 512;
		}
		const dest = path.join(env.VMROOT, "project/copied-checkout");
		assert.equal(readFileSync(path.join(dest, file), "utf8"), "COPY_OK\n");
		assert.ok(!readdirSync(dest, { recursive: true }).some((f) => path.basename(f).startsWith("._")), "tar introduced AppleDouble files");
		const back = path.join(dir, "copy back");
		const downloaded = await c.tool("vm_copy", { from: "copied-checkout", to: `local:${back}` });
		assert.equal(downloaded.isError, false, downloaded.content[0].text);
		assert.equal(readFileSync(path.join(back, file), "utf8"), "COPY_OK\n");
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
		const list = (await c.tool("vm_manage", { action: "list" })).content[0].text;
		assert.match(list, /current: fakevm/);
		assert.match(list, /^fakevm +running +10\.0\.0\.2 +standard +- +ssh-agent,env:TOKEN$/m, "list is rendered from ls --json");
		assert.match((await c.tool("vm_manage", { action: "none" })).content[0].text, /no current VM/);
		assert.match((await c.tool("vm_bash", { command: "x" })).content[0].text, /no current VM/);
		assert.match((await c.tool("vm_manage", { action: "grants", name: "fakevm" })).content[0].text, /file:\/l\/\.env → \/home\/agent\/project\/\.env/);
		assert.equal((await c.tool("vm_manage", { action: "bogus" })).isError, true);
	});

	test("vm_manage fork passes validated names to the controller", async () => {
		assert.match((await c.tool("vm_manage", { action: "fork", name: "fakevm", to: ["try-a", "try-b"] })).content[0].text, /stub boxery fork fakevm try-a try-b/);
		assert.match((await c.tool("vm_manage", { action: "fork", name: "fakevm", to: "one" })).content[0].text, /stub boxery fork fakevm one$/m);
		assert.match((await c.tool("vm_manage", { action: "fork", name: "fakevm" })).content[0].text, /stub boxery fork fakevm pi-[0-9a-f]{6}/);
		const bad = await c.tool("vm_manage", { action: "fork", name: "fakevm", to: ["ok", "x; touch /tmp/pwned"] });
		assert.equal(bad.isError, true);
		assert.match(bad.content[0].text, /invalid VM name/);
		assert.equal((await c.tool("vm_manage", { action: "fork", name: "fakevm", to: Array.from({ length: 9 }, (_, i) => `f${i}`) })).isError, true);
	});

	test("vm_manage shapes lists sizes; new/fork pass a validated shape", async () => {
		const shapes = (await c.tool("vm_manage", { action: "shapes" })).content[0].text;
		assert.match(shapes, /^standard \(default\) +4 +8 GiB +40 GiB$/m);
		assert.match(shapes, /^large +8 +16 GiB +80 GiB$/m);
		assert.match((await c.tool("vm_manage", { action: "new", name: "big", shape: "large" })).content[0].text, /stub boxery new big --shape large$/m);
		assert.match((await c.tool("vm_manage", { action: "new", name: "plain" })).content[0].text, /stub boxery new plain$/m);
		assert.match((await c.tool("vm_manage", { action: "fork", name: "fakevm", to: "f1", shape: "large" })).content[0].text, /stub boxery fork fakevm f1 --shape large$/m);
		const bad = await c.tool("vm_manage", { action: "new", name: "x", shape: "large; touch /tmp/pwned" });
		assert.equal(bad.isError, true);
		assert.match(bad.content[0].text, /invalid shape/);
	});

	test("vm_manage start/stop/resize/snap-rm/images/new-from reach the controller validated", async () => {
		const out = async (a) => (await c.tool("vm_manage", a)).content[0].text;
		const err = async (a, re) => {
			const r = await c.tool("vm_manage", a);
			assert.equal(r.isError, true, JSON.stringify(a));
			assert.match(r.content[0].text, re);
		};
		assert.match(await out({ action: "start", name: "fakevm" }), /stub boxery start fakevm$/m);
		assert.match(await out({ action: "stop", name: "fakevm" }), /stub boxery stop fakevm$/m);
		assert.match(await out({ action: "resize", name: "fakevm", cpus: 8, disk: 80 }), /stub boxery resize fakevm --cpus 8 --disk 80$/m);
		await err({ action: "resize", name: "fakevm" }, /resize needs/);
		await err({ action: "resize", name: "fakevm", mem: "8192; touch /tmp/pwned" }, /mem must be a positive integer/);
		await err({ action: "resize", name: "fakevm", cpus: 0 }, /cpus must be a positive integer/);
		assert.match(await out({ action: "snap-rm", name: "fakevm", snapshot: "s1" }), /stub boxery snap-rm fakevm s1$/m);
		await err({ action: "snap-rm", name: "fakevm" }, /invalid snapshot name/);
		assert.match(await out({ action: "images" }), /stub boxery images$/m);
		assert.match(await out({ action: "new", name: "copy", from: "fakevm@s1" }), /stub boxery new copy --from fakevm@s1$/m);
		assert.match(await out({ action: "new", name: "big", shape: "large", mem: 32768 }), /stub boxery new big --shape large --mem 32768$/m);
		assert.match(await out({ action: "fork", name: "fakevm", to: "f2", cpus: 2 }), /stub boxery fork fakevm f2 --cpus 2$/m);
		for (const from of ["fakevm", "fakevm@s1@x", "x;y@s1", "fakevm@-s"]) await err({ action: "new", name: "x", from }, /invalid image/);
	});
});

describe("protocol features", () => {
	let c;
	before(async () => {
		c = client(["--vm", "fakevm"]);
		await c.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } });
	});
	after(() => c.close());

	test("2025-11-25 clients get serverInfo description and tool titles", async () => {
		const init = await c.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } });
		assert.match(init.result.serverInfo.description, /desktop VMs/);
		const { tools } = (await c.call("tools/list")).result;
		assert.equal(tools.find((t) => t.name === "vm_bash").title, "VM bash");
	});

	test("vm_info is read-only and returns structured results", async () => {
		const { tools } = (await c.call("tools/list")).result;
		const info = tools.find((t) => t.name === "vm_info");
		assert.equal(info.annotations.readOnlyHint, true);
		assert.equal(info.outputSchema.type, "object");
		assert.equal(tools.find((t) => t.name === "vm_read").annotations.openWorldHint, false);
		const list = await c.tool("vm_info", { action: "list" });
		assert.match(list.content[0].text, /current: fakevm/);
		assert.equal(list.structuredContent.vms[0].name, "fakevm");
		assert.equal(list.structuredContent.current, "fakevm");
		assert.equal(list.structuredContent.host, "legacy");
		assert.equal((await c.tool("vm_info", { action: "shapes" })).structuredContent.default, "standard");
		const grants = await c.tool("vm_info", { action: "grants" });
		assert.equal(grants.structuredContent.name, "fakevm", "name defaults to the current VM");
		assert.equal(grants.structuredContent.grants[0].kind, "file");
		const snaps = await c.tool("vm_info", { action: "snaps", name: "fakevm" });
		assert.match(snaps.content[0].text, /^s1\t2026-10-01T00:00:00Z\t1\.2G$/);
		assert.equal(snaps.structuredContent.snapshots[0].name, "s1");
		assert.ok(Array.isArray((await c.tool("vm_info", { action: "hosts" })).structuredContent.hosts));
		assert.equal((await c.tool("vm_info", { action: "snaps", name: "Bad;Name" })).isError, true);
		assert.equal((await c.tool("vm_info", { action: "grants", name: ["fakevm"] })).isError, true, "names must be strings, not arrays that coerce");
	});

	test("vm_manage keeps its lookup actions", async () => {
		assert.match((await c.tool("vm_manage", { action: "list" })).content[0].text, /current: fakevm/);
	});

	test("vm_jobs declares an output schema and returns structured records", async () => {
		const { tools } = (await c.call("tools/list")).result;
		assert.ok(tools.find((t) => t.name === "vm_jobs").outputSchema.properties.jobs);
		const start = await c.tool("vm_jobs", { action: "start", command: "echo job-out" });
		assert.equal(start.isError, false, start.content[0].text);
		assert.match(start.structuredContent.id, /^job-/);
		assert.deepEqual(JSON.parse(start.content[0].text), start.structuredContent);
		const wait = await c.tool("vm_jobs", { action: "wait", job: start.structuredContent.id, timeout: 10 });
		assert.equal(wait.structuredContent.state, "completed");
		assert.equal(wait.structuredContent.exit_code, 0);
		const list = await c.tool("vm_jobs", { action: "list" });
		assert.ok(list.structuredContent.jobs.some((j) => j.id === start.structuredContent.id));
		const logs = await c.tool("vm_jobs", { action: "logs", job: start.structuredContent.id });
		assert.match(logs.structuredContent.log, /job-out/);
		assert.equal(logs.structuredContent.truncated, false);
		// A job whose metadata is empty must not hide the others or break the JSON.
		writeFileSync(path.join(env.VMROOT, ".boxery/jobs/job-AAAAAAAAAAAA.meta"), "");
		const withBad = await c.tool("vm_jobs", { action: "list" });
		assert.equal(withBad.isError, false, withBad.content[0].text);
		assert.equal(withBad.structuredContent.jobs.find((j) => j.id === "job-AAAAAAAAAAAA").started_at, null);
	});

	test("progress notifications stream status lines when the client sends a progressToken", async () => {
		const r = await c.call("tools/call", { name: "vm_bash", arguments: { command: "echo first; sleep 1.2; echo second" }, _meta: { progressToken: "tok-1" } });
		assert.equal(r.result.isError, false);
		const mine = c.notifications.filter((n) => n.method === "notifications/progress" && n.params.progressToken === "tok-1");
		assert.deepEqual(mine.map((n) => n.params.message), ["first", "second"]);
		assert.deepEqual(mine.map((n) => n.params.progress), [1, 2], "progress increases");
		const managed = await c.call("tools/call", { name: "vm_manage", arguments: { action: "new", name: "slow" }, _meta: { progressToken: 7 } });
		assert.equal(managed.result.isError, false);
		assert.deepEqual(c.notifications.filter((n) => n.params?.progressToken === 7).map((n) => n.params.message), ["==> creating slow", "==> slow is ready"]);
		const before = c.notifications.length;
		await c.tool("vm_bash", { command: "echo quiet" });
		assert.equal(c.notifications.length, before, "no token, no notifications");
	});
});

describe("older protocol versions", () => {
	let c;
	before(async () => {
		c = client(["--vm", "fakevm"]);
		const init = await c.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
		assert.equal(init.result.protocolVersion, "2025-03-26");
		assert.equal(init.result.serverInfo.description, undefined);
	});
	after(() => c.close());

	test("no outputSchema, tool title or structuredContent before 2025-06-18", async () => {
		const { tools } = (await c.call("tools/list")).result;
		for (const t of tools) {
			assert.equal(t.outputSchema, undefined, t.name);
			assert.equal(t.title, undefined, t.name);
		}
		const r = await c.tool("vm_info", { action: "list" });
		assert.equal(r.structuredContent, undefined);
		assert.match(r.content[0].text, /current: fakevm/);
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

	test("progress arrives as SSE only when requested; plain calls stay JSON", async () => {
		const auth = { authorization: `Bearer ${token}`, "tailscale-user-login": "me@x" };
		const sid = (await post(init, auth)).headers.get("mcp-session-id");
		const r = await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "vm_bash", arguments: { command: "echo one; sleep 1.2; echo two" }, _meta: { progressToken: "p" } } }, { ...auth, "mcp-session-id": sid });
		assert.equal(r.status, 200);
		assert.match(r.headers.get("content-type"), /text\/event-stream/);
		const events = (await r.text()).split("\n\n").filter(Boolean).map((e) => JSON.parse(e.replace(/^event: message\ndata: /, "")));
		assert.deepEqual(events.filter((e) => e.method === "notifications/progress").map((e) => e.params.message), ["one", "two"]);
		assert.match(events.at(-1).result.content[0].text, /one\ntwo/);
		const asNotification = await post({ jsonrpc: "2.0", method: "tools/call", params: { name: "vm_bash", arguments: { command: "true" }, _meta: { progressToken: "n" } } }, { ...auth, "mcp-session-id": sid });
		assert.equal(asNotification.status, 202, "a tools/call without id gets no stream");
		const noSse = await post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "vm_bash", arguments: { command: "echo x" }, _meta: { progressToken: "q" } } }, { ...auth, "mcp-session-id": sid, accept: "application/json" });
		assert.match(noSse.headers.get("content-type"), /application\/json/);
		assert.match((await noSse.json()).result.content[0].text, /x/);
	});
});
