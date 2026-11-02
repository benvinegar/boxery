// MCP server protocol tests with a fake VM: an `ssh` stub on PATH runs the remote script locally
// (in a temp "VM home"), and BOXERY_BIN points at a stub controller.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeTmux } from "./fake-tmux.mjs";
import { guestFixture } from "./helpers/atomic-edit-fixture.mjs";
import { registerHost } from "./fixtures/register-host.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER = path.join(ROOT, "mcp/boxery-mcp.mjs");
let dir, env;

before(() => {
	dir = mkdtempSync(path.join(tmpdir(), "boxery-mcp-"));
	const bin = path.join(dir, "bin");
	const vmroot = path.join(dir, "vm");
	const tar = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
	mkdirSync(bin);
	guestFixture(dir); // flock/stat shims only on macOS; no new guest dependency.
	// Capture the actual wire archive: macOS extraction consumes AppleDouble entries, while Linux
	// extraction leaves them as ._* files. Checking just the extracted fake VM would miss the bug.
	// A directory holding .crafted.tar produces that archive instead (hostile-VM tests).
	writeFileSync(path.join(bin, "tar"), `#!/usr/bin/env bash\nset -eo pipefail\nif [ "$1" = -cf ] && [ -f .crafted.tar ]; then cat .crafted.tar\nelif [ "$1" = -cf ]; then\n${JSON.stringify(tar)} "$@" | tee ${JSON.stringify(path.join(dir, "copy.tar"))}\nelse exec ${JSON.stringify(tar)} "$@"; fi\n`);
	chmodSync(path.join(bin, "tar"), 0o755);
	mkdirSync(path.join(vmroot, "project"), { recursive: true });
	mkdirSync(path.join(dir, "home"));
	writeFileSync(path.join(dir, "home/ssh_config"), "# fake\n");
	registerHost(path.join(dir, "home"), "local");
	// ssh -F CONF -o BatchMode=yes NAME.boxery "bash -c '<script>'": run the script locally, cwd = fake VM home.
	// /home/agent is rewritten to the fake VM root so absolute VM paths stay inside the sandbox.
	writeFileSync(
		path.join(bin, "ssh"),
		`#!/usr/bin/env bash
host=""; while [ $# -gt 1 ]; do case $1 in -F|-o) shift 2 ;; *.boxery) host=$1; shift ;; *) shift ;; esac; done
[ "$host" = "fakevm.boxery" ] || { echo "ssh: unknown host $host" >&2; exit 255; }
cmd=\${1//\\/home\\/agent/${vmroot}}
cmd=\${cmd//\\/etc\\/boxery/${vmroot}/etc/boxery}
# vm_edit carries the guest path as JSON on stdin, rather than in shell source.
if [[ "$cmd" == *"flock -w 60"* ]]; then
 node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);r.path=r.path.replace("/home/agent",process.argv[1]);process.stdout.write(JSON.stringify(r))})' "${vmroot}" | HOME="${vmroot}" PATH="${bin}:$PATH" bash -c "$cmd"
 exit $?
fi
cd "${vmroot}" && HOME="${vmroot}" PATH="${bin}:$PATH" exec bash -c "$cmd"
`,
	);
	// macOS has no setsid; emulate it with perl (present on macOS and Linux): a new session, then exec.
	// -w (wait for the child) is implied: perl execs in place, so the caller already waits on it.
	writeFileSync(path.join(bin, "setsid"), `#!/usr/bin/env bash\n[ "$1" = -w ] && shift\nexec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die' -- "$@"\n`);
	chmodSync(path.join(bin, "setsid"), 0o755);
	// vm_jobs needs tmux in the VM; the fake keeps it off the developer's server and works where tmux isn't installed.
	writeFileSync(path.join(bin, "tmux"), fakeTmux());
	chmodSync(path.join(bin, "tmux"), 0o755);
	// Screen grabs: a 1600x1000 desktop; `import` prints the format it was asked for. A file
	// ~/.xdotool-mode in the fake VM makes the geometry query warn first ("warn") or fail ("fail").
	writeFileSync(
		path.join(bin, "xdotool"),
		`#!/usr/bin/env bash\nmode=$(cat ~/.xdotool-mode 2>/dev/null)\n[ "$mode" = fail ] && { echo "Error: Can't open display: :1"; exit 1; }\n[ "$mode" = warn ] && echo "Xlib:  extension \\"RANDR\\" missing on display \\":1\\"."\n[ "$1" = getdisplaygeometry ] && echo "1600 1000"\nexit 0\n`,
	);
	writeFileSync(path.join(bin, "import"), `#!/usr/bin/env bash\nfor a; do :; done; printf '%s' "\${a%%:*}-bytes"\n`);
	chmodSync(path.join(bin, "xdotool"), 0o755);
	chmodSync(path.join(bin, "import"), 0o755);
	writeFileSync(
		path.join(bin, "boxery"),
		`#!/usr/bin/env bash
[ "$1" != --host ] || shift 4 # --host NAME --profile-dir DIR
echo "$*" >> "$BOXERY_HOME/calls"
case "$*" in
"acquire "*) echo "==> leased pool-1" >&2; echo "pool-1 l-0123456789abcdef0123456789abcdef" ;;
"renew "*) echo "pool-1 9999999999" ;;
"ls --json") echo '[{"name":"fakevm","state":"running","ssh_addr":"10.0.0.2:22","disk_size":40,"disk_used":1.5,"tunnel":null,"lease":null,"shape":"standard","cpus":4,"mem":8192,"grants":[{"kind":"ssh-agent"},{"kind":"env","var":"TOKEN","cmd":null}]}]' ;;
"shapes --json") echo '{"default":"standard","shapes":{"standard":{"cpus":4,"mem":8192,"disk":40},"large":{"cpus":8,"mem":16384,"disk":80}}}' ;;
"grants granted --json") echo '[{"kind":"ssh-agent"}]' ;;
"grants "*" --json") echo '[{"kind":"file","local":"/l/.env","remote":"/home/agent/project/.env"}]' ;;
"version --json") echo '{"controller":{"version":"0.8.0","describe":"v0.8.0"},"host":{"name":"local","version":"0.7.0","describe":null,"install":"npm"},"behind":true}' ;;
"images --json") echo '[{"image":"fakevm@s1","created":"2026-10-01T00:00:00Z","size":"1.2G"}]' ;;
"snaps "*" --json") echo '[{"name":"s1","created":"2026-10-01T00:00:00Z","size":"1.2G"}]' ;;
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
function client(args = [], extraEnv = {}) {
	const p = spawn(process.execPath, [SERVER, ...args], { env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "ignore"] });
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
			else if (msg.method) answer(msg); // the server asking us (elicitation)
			else waiting.get(msg.id)?.(msg);
		}
	});
	const requests = [];
	const self = { onRequest: null };
	async function answer(msg) {
		requests.push(msg);
		const result = await self.onRequest?.(msg);
		if (result !== undefined) p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...(result.error ? { error: result.error } : { result }) })}\n`);
	}
	let id = 0;
	const call = (method, params) =>
		new Promise((resolve) => {
			const i = ++id;
			self.lastId = i;
			waiting.set(i, resolve);
			p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method, params })}\n`);
		});
	const tool = async (name, args) => (await call("tools/call", { name, arguments: args })).result;
	return Object.assign(self, { p, call, tool, notifications, requests, notify: (method, params) => p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`), close: () => p.kill() });
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
		for (const n of ["vm_bash", "vm_jobs", "vm_read", "vm_write", "vm_edit", "vm_copy", "vm_screenshot", "vm_click", "vm_type", "vm_key", "vm_scroll", "vm_browser", "vm_manage", "vm_lease", "vm_info"])
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
				assert.deepEqual(props.action.enum, [...shared.parameters.properties.action.enum, "host", "host_add", "host_rm"]);
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
		const r = await c.tool("vm_manage", { action: "snap", vm: "fakevm", snapshot: "x; touch /tmp/pwned #" });
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
		const list = (await c.tool("vm_info", { action: "list" })).content[0].text;
		assert.match(list, /current: fakevm/);
		assert.match(list, /^fakevm +running +10\.0\.0\.2:22 +1\.5\/40GiB +standard +desktop +- +ssh-agent,env:TOKEN$/m, "list is rendered from ls --json");
		assert.match((await c.tool("vm_manage", { action: "none" })).content[0].text, /no current VM/);
		assert.match((await c.tool("vm_bash", { command: "x" })).content[0].text, /no current VM/);
		assert.match((await c.tool("vm_info", { action: "grants", vm: "fakevm" })).content[0].text, /file:\/l\/\.env → \/home\/agent\/project\/\.env/);
		assert.equal((await c.tool("vm_manage", { action: "bogus" })).isError, true);
	});

	test("vm_manage fork passes validated names to the controller", async () => {
		assert.match((await c.tool("vm_manage", { action: "fork", vm: "fakevm", to: ["try-a", "try-b"] })).content[0].text, /stub boxery fork fakevm try-a try-b/);
		assert.match((await c.tool("vm_manage", { action: "fork", vm: "fakevm", to: "one" })).content[0].text, /stub boxery fork fakevm one$/m);
		assert.match((await c.tool("vm_manage", { action: "fork", vm: "fakevm" })).content[0].text, /stub boxery fork fakevm pi-[0-9a-f]{6}/);
		const bad = await c.tool("vm_manage", { action: "fork", vm: "fakevm", to: ["ok", "x; touch /tmp/pwned"] });
		assert.equal(bad.isError, true);
		assert.match(bad.content[0].text, /invalid VM name/);
		assert.equal((await c.tool("vm_manage", { action: "fork", vm: "fakevm", to: Array.from({ length: 9 }, (_, i) => `f${i}`) })).isError, true);
	});

	test("vm_info shapes lists sizes; vm_manage new/fork pass a validated shape", async () => {
		const shapes = (await c.tool("vm_info", { action: "shapes" })).content[0].text;
		assert.match(shapes, /^standard \(default\) +4 +8 GiB +40 GiB$/m);
		assert.match(shapes, /^large +8 +16 GiB +80 GiB$/m);
		assert.match((await c.tool("vm_manage", { action: "new", vm: "big", shape: "large" })).content[0].text, /stub boxery new big --shape large$/m);
		assert.match((await c.tool("vm_manage", { action: "new", vm: "plain" })).content[0].text, /stub boxery new plain$/m);
		assert.match((await c.tool("vm_manage", { action: "fork", vm: "fakevm", to: "f1", shape: "large" })).content[0].text, /stub boxery fork fakevm f1 --shape large$/m);
		const bad = await c.tool("vm_manage", { action: "new", vm: "x", shape: "large; touch /tmp/pwned" });
		assert.equal(bad.isError, true);
		assert.match(bad.content[0].text, /invalid shape/);
	});

	test("vm_manage start/stop/resize/snap-rm/new-from reach the controller validated", async () => {
		const out = async (a) => (await c.tool("vm_manage", a)).content[0].text;
		const err = async (a, re) => {
			const r = await c.tool("vm_manage", a);
			assert.equal(r.isError, true, JSON.stringify(a));
			assert.match(r.content[0].text, re);
		};
		assert.match(await out({ action: "start", vm: "fakevm" }), /stub boxery start fakevm$/m);
		assert.match(await out({ action: "stop", vm: "fakevm" }), /stub boxery stop fakevm$/m);
		assert.match(await out({ action: "resize", vm: "fakevm", cpus: 8, disk: 80 }), /stub boxery resize fakevm --cpus 8 --disk 80$/m);
		await err({ action: "resize", vm: "fakevm" }, /resize needs/);
		await err({ action: "resize", vm: "fakevm", mem: "8192; touch /tmp/pwned" }, /mem must be a positive integer/);
		await err({ action: "resize", vm: "fakevm", cpus: 0 }, /cpus must be a positive integer/);
		assert.match(await out({ action: "snap-rm", vm: "fakevm", snapshot: "s1" }), /stub boxery snap-rm fakevm s1$/m);
		await err({ action: "snap-rm", vm: "fakevm" }, /invalid snapshot name/);
		assert.match(await out({ action: "new", vm: "copy", from: "fakevm@s1" }), /stub boxery new copy --from fakevm@s1$/m);
		assert.match(await out({ action: "new", vm: "big", shape: "large", mem: 32768 }), /stub boxery new big --shape large --mem 32768$/m);
		assert.match(await out({ action: "fork", vm: "fakevm", to: "f2", cpus: 2 }), /stub boxery fork fakevm f2 --cpus 2$/m);
		for (const from of ["fakevm", "fakevm@s1@x", "x;y@s1", "fakevm@-s"]) await err({ action: "new", vm: "x", from }, /invalid image/);
	});

	test("vm_manage new headless:true passes --headless; desktop tools refuse a headless VM", async () => {
		assert.match((await c.tool("vm_manage", { action: "new", vm: "hl", headless: true })).content[0].text, /stub boxery new hl --headless$/m);
		assert.match((await c.tool("vm_manage", { action: "new", vm: "dt", headless: false })).content[0].text, /stub boxery new dt$/m);
		mkdirSync(path.join(env.VMROOT, "etc/boxery"), { recursive: true });
		writeFileSync(path.join(env.VMROOT, "etc/boxery/headless"), "no desktop\n");
		try {
			for (const [tool, args] of [["vm_screenshot", {}], ["vm_click", { x: 1, y: 1 }], ["vm_type", { text: "x" }], ["vm_key", { keys: "Return" }], ["vm_scroll", { x: 1, y: 1, direction: "down" }], ["vm_browser", { code: "return 1" }], ["vm_view", {}], ["vm_view_frame", {}]]) {
				const r = await c.tool(tool, { vm: "fakevm", ...args });
				assert.equal(r.isError, true, tool);
				assert.match(r.content[0].text, /is headless .*no desktop/, tool);
			}
		} finally {
			rmSync(path.join(env.VMROOT, "etc"), { recursive: true });
		}
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
		assert.equal(list.structuredContent.host, "local");
		assert.equal((await c.tool("vm_info", { action: "shapes" })).structuredContent.default, "standard");
		const grants = await c.tool("vm_info", { action: "grants" });
		assert.equal(grants.structuredContent.vm, "fakevm", "vm defaults to the current VM");
		assert.equal(grants.structuredContent.grants[0].kind, "file");
		const snaps = await c.tool("vm_info", { action: "snaps", vm: "fakevm" });
		assert.match(snaps.content[0].text, /^s1\t2026-10-01T00:00:00Z\t1\.2G$/);
		assert.equal(snaps.structuredContent.snapshots[0].name, "s1");
		const images = await c.tool("vm_info", { action: "images" });
		assert.match(images.content[0].text, /^fakevm@s1\t2026-10-01T00:00:00Z\t1\.2G$/);
		assert.equal(images.structuredContent.images[0].image, "fakevm@s1");
		assert.ok(Array.isArray((await c.tool("vm_info", { action: "hosts" })).structuredContent.hosts));
		const version = await c.tool("vm_info", { action: "version" });
		assert.equal(version.structuredContent.behind, true);
		assert.equal(version.structuredContent.host.version, "0.7.0");
		assert.match(version.content[0].text, /older than the controller.*boxery upgrade-host/s, "tells the agent to hand the upgrade to the user");
		assert.equal((await c.tool("vm_info", { action: "snaps", vm: "Bad;Name" })).isError, true);
		assert.equal((await c.tool("vm_info", { action: "grants", vm: ["fakevm"] })).isError, true, "names must be strings, not arrays that coerce");
	});

	test("vm_manage has no lookup actions and needs an explicit vm", async () => {
		for (const action of ["list", "shapes", "grants", "snaps", "images"]) {
			const r = await c.tool("vm_manage", { action, vm: "fakevm" });
			assert.equal(r.isError, true, action);
			assert.match(r.content[0].text, new RegExp(`use vm_info \\{action:"${action}"\\}`), action);
		}
		const hosts = await c.tool("vm_manage", { action: "hosts" });
		assert.equal(hosts.isError, true);
		const rm = await c.tool("vm_manage", { action: "rm" });
		assert.equal(rm.isError, true);
		assert.match(rm.content[0].text, /rm needs `vm`/);
		const name = await c.tool("vm_manage", { action: "start", name: "fakevm" });
		assert.equal(name.isError, true, "no `name` alias");
		assert.match(name.content[0].text, /start needs `vm`/);
	});

	// The VM-side job helper needs Node's type stripping (22.18+; boxery images ship it).
	const jobsSkip = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module-typescript", "-e", ""]).status === 0 ? false : "needs Node >= 22.18 (type stripping)";
	test("vm_jobs declares an output schema and returns structured records", { skip: jobsSkip }, async () => {
		const { tools } = (await c.call("tools/list")).result;
		assert.ok(tools.find((t) => t.name === "vm_jobs").outputSchema.properties.jobs);
		const start = await c.tool("vm_jobs", { action: "start", command: "echo job-out" });
		assert.equal(start.isError, false, start.content[0].text);
		assert.match(start.structuredContent.id, /^job-/);
		assert.deepEqual(JSON.parse(start.content[0].text), start.structuredContent);
		const wait = await c.tool("vm_jobs", { action: "wait", job: start.structuredContent.id, timeout: 10 });
		assert.equal(wait.structuredContent.state, "exited");
		assert.equal(wait.structuredContent.exit_code, 0);
		assert.match(wait.structuredContent.output, /job-out/, "wait includes the output tail");
		const list = await c.tool("vm_jobs", { action: "list" });
		assert.ok(list.structuredContent.jobs.some((j) => j.id === start.structuredContent.id));
		const logs = await c.tool("vm_jobs", { action: "logs", job: start.structuredContent.id });
		assert.match(logs.structuredContent.log, /job-out/);
		assert.equal(logs.structuredContent.truncated, false);
		// A job whose record is corrupt must not hide the others or break the JSON.
		writeFileSync(path.join(env.VMROOT, ".boxery/jobs/job-20260101-000000-aaaaaa.json"), "");
		const withBad = await c.tool("vm_jobs", { action: "list" });
		assert.equal(withBad.isError, false, withBad.content[0].text);
		assert.ok(withBad.structuredContent.jobs.some((j) => j.id === start.structuredContent.id));
		const killed = await c.tool("vm_jobs", { action: "kill", job: start.structuredContent.id });
		assert.equal(killed.structuredContent.id, start.structuredContent.id);
	});

	test("progress notifications stream status lines when the client sends a progressToken", async () => {
		const r = await c.call("tools/call", { name: "vm_bash", arguments: { command: "echo first; sleep 1.2; echo second" }, _meta: { progressToken: "tok-1" } });
		assert.equal(r.result.isError, false);
		const mine = c.notifications.filter((n) => n.method === "notifications/progress" && n.params.progressToken === "tok-1");
		assert.deepEqual(mine.map((n) => n.params.message), ["first", "second"]);
		assert.deepEqual(mine.map((n) => n.params.progress), [1, 2], "progress increases");
		const managed = await c.call("tools/call", { name: "vm_manage", arguments: { action: "new", vm: "slow" }, _meta: { progressToken: 7 } });
		assert.equal(managed.result.isError, false);
		assert.deepEqual(c.notifications.filter((n) => n.params?.progressToken === 7).map((n) => n.params.message), ["==> creating slow", "==> slow is ready"]);
		const before = c.notifications.length;
		await c.tool("vm_bash", { command: "echo quiet" });
		assert.equal(c.notifications.length, before, "no token, no notifications");
	});
});

describe("live view (MCP Apps)", () => {
	const APPS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
	const init = (c, capabilities) => c.call("initialize", { protocolVersion: "2025-11-25", capabilities, clientInfo: { name: "t", version: "0" } });
	let c;
	before(async () => {
		c = client(["--vm", "fakevm"]);
		const r = await init(c, APPS);
		assert.deepEqual(r.result.capabilities.resources, {});
	});
	after(() => c.close());

	test("clients without MCP Apps see no vm_view and no resources", async () => {
		const plain = client(["--vm", "fakevm"]);
		try {
			const r = await init(plain, {});
			assert.equal(r.result.capabilities.resources, undefined);
			const names = (await plain.call("tools/list")).result.tools.map((t) => t.name);
			assert.ok(!names.includes("vm_view") && !names.includes("vm_view_frame"));
			assert.deepEqual((await plain.call("resources/list")).result.resources, []);
		} finally {
			plain.close();
		}
	});

	test("--ui offers the view without the capability", async () => {
		const forced = client(["--vm", "fakevm", "--ui"]);
		try {
			await init(forced, {});
			assert.ok((await forced.call("tools/list")).result.tools.some((t) => t.name === "vm_view"));
		} finally {
			forced.close();
		}
	});

	test("vm_view links the ui:// resource; vm_view_frame is app-only", async () => {
		const { tools } = (await c.call("tools/list")).result;
		const view = tools.find((t) => t.name === "vm_view");
		assert.deepEqual(view._meta.ui, { resourceUri: "ui://boxery/desktop", visibility: ["model", "app"] });
		assert.equal(view._meta["ui/resourceUri"], "ui://boxery/desktop");
		assert.equal(view.annotations.readOnlyHint, true);
		assert.deepEqual(tools.find((t) => t.name === "vm_view_frame")._meta.ui.visibility, ["app"]);
		const { resources } = (await c.call("resources/list")).result;
		assert.deepEqual(resources.map((r) => [r.uri, r.mimeType]), [["ui://boxery/desktop", "text/html;profile=mcp-app"]]);
	});

	test("resources/read serves the view page", async () => {
		const [page] = (await c.call("resources/read", { uri: "ui://boxery/desktop" })).result.contents;
		assert.equal(page.mimeType, "text/html;profile=mcp-app");
		assert.match(page.text, /^<!doctype html>/);
		for (const m of ["ui/initialize", "vm_view_frame", "vm_click", "vm_type", "vm_key", "vm_scroll"]) assert.ok(page.text.includes(m), m);
		assert.equal((await c.call("resources/read", { uri: "ui://boxery/nope" })).error.code, -32002);
	});

	test("vm_view names the VM for the page; frames are JPEGs in vm_click coordinates", async () => {
		const view = await c.tool("vm_view", {});
		assert.equal(view.isError, false, view.content[0].text);
		assert.match(view.content[0].text, /live view of VM "fakevm" \(1600x1000\)/);
		assert.deepEqual(view.structuredContent, { vm: "fakevm", host: "local", width: 1280, height: 800, screenWidth: 1600, screenHeight: 1000 });
		const f = await c.tool("vm_view_frame", { vm: "fakevm" });
		const img = f.content.find((x) => x.type === "image");
		assert.equal(img.mimeType, "image/jpeg");
		assert.equal(Buffer.from(img.data, "base64").toString(), "jpeg-bytes");
		assert.equal(f.structuredContent.width, 1280);
		const shot = await c.tool("vm_screenshot", {});
		assert.equal(shot.content[1].mimeType, "image/png");
		assert.equal(shot.structuredContent, undefined);
	});
});

describe("screenshots", () => {
	let c;
	before(async () => {
		c = client(["--vm", "fakevm"]);
		await c.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } });
	});
	after(() => c.close());
	const mode = (m) => writeFileSync(path.join(env.VMROOT, ".xdotool-mode"), m);

	test("the screen size is found after X11 warnings", async () => {
		mode("warn");
		try {
			const shot = await c.tool("vm_screenshot", {});
			assert.equal(shot.isError, false, shot.content[0].text);
			assert.match(shot.content[0].text, /1600x1000, shown at 1280x800/);
		} finally {
			rmSync(path.join(env.VMROOT, ".xdotool-mode"));
		}
	});

	test("without a screen size, screenshots fail clearly instead of returning NaN sizes", async () => {
		mode("fail");
		try {
			for (const tool of ["vm_screenshot", "vm_view", "vm_view_frame"]) {
				const r = await c.tool(tool, { vm: "fakevm" });
				assert.equal(r.isError, true, tool);
				assert.match(r.content[0].text, /desktop not ready, couldn't read the screen size \(Error: Can't open display: :1\)/, tool);
			}
		} finally {
			rmSync(path.join(env.VMROOT, ".xdotool-mode"));
		}
		assert.equal((await c.tool("vm_screenshot", {})).isError, false);
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

describe("leases", () => {
	const LEASE = "l-0123456789abcdef0123456789abcdef";
	const calls = () => readFileSync(path.join(env.BOXERY_HOME, "calls"), "utf8").trim().split("\n");

	test("vm_lease acquires, tracks, renews and releases pool VMs per session; leases end with the session", async () => {
		const c = client();
		await c.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
		const lease = async (a) => (await c.tool("vm_lease", a)).content[0].text;
		const err = async (tool, a, re) => {
			const r = await c.tool(tool, a);
			assert.equal(r.isError, true, JSON.stringify(a));
			assert.match(r.content[0].text, re);
		};
		try {
			assert.equal(await lease({ action: "list" }), "this session holds no leases");
			await err("vm_lease", { action: "acquire", ttl: 5 }, /ttl must be/);
			assert.match(await lease({ action: "acquire", ttl: 600, wait: 5 }), new RegExp(`^leased pool-1 \\(lease ${LEASE}, ttl 600s.*\ncurrent VM: pool-1$`));
			assert.equal(calls().at(-1), "acquire --ttl 600 --wait 5");
			assert.match(await lease({ action: "list" }), new RegExp(`^pool-1\t${LEASE}\texpires in 600s .*\tcurrent$`));
			assert.match((await c.tool("vm_info", { action: "list" })).content[0].text, /current: pool-1/);
			await err("vm_manage", { action: "rm", vm: "pool-1" }, /leased from the pool/);
			assert.equal(await lease({ action: "renew", ttl: 900 }), "renewed pool-1 for 900s");
			assert.equal(calls().at(-1), `renew ${LEASE} --ttl 900`);
			await err("vm_lease", { action: "renew", vm: "fakevm" }, /holds no lease on fakevm/);
			assert.match(await lease({ action: "release" }), /^released pool-1; .*\nno current VM$/);
			assert.equal(calls().at(-1), `release ${LEASE}`);
			await err("vm_bash", { command: "true" }, /no current VM/);
			await err("vm_lease", { action: "release", vm: "pool-1" }, /holds no lease/);
			assert.doesNotMatch(await lease({ action: "acquire", use: false }), /current VM/);
			assert.equal(calls().at(-1), "acquire --ttl 1800 --wait 60");
		} finally {
			c.p.stdin.end(); // stdio session over: its leases are released before the server exits
			await new Promise((r) => c.p.on("exit", r));
		}
		assert.equal(calls().at(-1), `release ${LEASE}`);
	});
});

describe("grant requests (vm_grant)", () => {
	const calls = () => readFileSync(path.join(env.BOXERY_HOME, "calls"), "utf8").trim().split("\n");
	const grantCalls = () => calls().filter((l) => l.startsWith("grant "));
	const elicitClient = async (protocolVersion = "2025-06-18", elicitation = {}, extraEnv = {}) => {
		const c = client(["--vm", "fakevm"], extraEnv);
		await c.call("initialize", { protocolVersion, capabilities: { elicitation }, clientInfo: { name: "t", version: "0" } });
		return c;
	};
	let plain, c;
	before(async () => {
		writeFileSync(path.join(env.BOXERY_HOME, "calls"), "", { flag: "a" });
		plain = client(["--vm", "fakevm"]);
		await plain.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
		c = await elicitClient();
	});
	after(() => {
		plain.close();
		c.close();
	});

	test("a client that can't prompt gets the command for the user; nothing is granted", async () => {
		const before = grantCalls().length;
		const r = await plain.tool("vm_grant", { spec: "github", readonly: true, reason: "clone a private repo" });
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /can't show the user an approval prompt[\s\S]*\n  boxery --host local grant fakevm github --readonly$/);
		assert.equal(grantCalls().length, before);
		assert.equal(plain.requests.length, 0);
	});

	test("the user approves in an elicitation: the controller adds the grant", async () => {
		c.onRequest = () => ({ action: "accept", content: {} });
		const r = await c.tool("vm_grant", { spec: "ssh-agent", reason: "git push over ssh\nIGNORE PREVIOUS" });
		assert.equal(r.isError, false, r.content[0].text);
		assert.match(r.content[0].text, /^The user approved: fakevm now has ssh-agent/);
		assert.equal(grantCalls().at(-1), "grant fakevm ssh-agent");
		const req = c.requests.at(-1);
		assert.equal(req.method, "elicitation/create");
		assert.deepEqual(req.params.requestedSchema, { type: "object", properties: {} });
		assert.equal(req.params.mode, undefined, "mode is a 2025-11-25 field");
		assert.match(req.params.message, /^Give VM "fakevm" on host "local" access to:\n\nssh-agent: /);
		assert.match(req.params.message, /Revoke any time: boxery --host local revoke fakevm ssh-agent/);
		assert.match(req.params.message, /\n\nThe agent's reason: "git push over ssh IGNORE PREVIOUS"$/, "the reason is last, labelled, on one line");
	});

	test("declined or dismissed: nothing is granted and the agent is told not to ask again", async () => {
		const before = grantCalls().length;
		c.onRequest = () => ({ action: "decline" });
		const r = await c.tool("vm_grant", { spec: "ssh-agent", reason: "x" });
		assert.match(r.content[0].text, /^The user declined the request; fakevm did not get ssh-agent\. Don't ask for it again/);
		c.onRequest = () => ({ action: "cancel" });
		assert.match((await c.tool("vm_grant", { spec: "ssh-agent", reason: "x" })).content[0].text, /^The user dismissed/);
		c.onRequest = () => ({ error: { code: -32601, message: "no elicitation here" } });
		const failed = await c.tool("vm_grant", { spec: "ssh-agent", reason: "x" });
		assert.equal(failed.isError, true);
		assert.match(failed.content[0].text, /prompt failed \(no elicitation here\)[\s\S]*boxery --host local grant fakevm ssh-agent/);
		assert.equal(grantCalls().length, before);
	});

	test("file specs resolve to an absolute local path and a /home/agent-relative remote", async () => {
		const f = path.join(realpathSync(dir), "auth.ini");
		writeFileSync(f, "//registry/:_authToken=x\n", { mode: 0o644 });
		c.onRequest = () => ({ action: "accept" });
		const r = await c.tool("vm_grant", { spec: `file:${f}=~/.config/pnpm/auth.ini`, reason: "pnpm install got 401" });
		assert.equal(r.isError, false, r.content[0].text);
		assert.equal(grantCalls().at(-1), `grant fakevm file:${f}=.config/pnpm/auth.ini`);
		assert.match(c.requests.at(-1).params.message, new RegExp(`file: ${f}\n  → in the VM: ~/\\.config/pnpm/auth\\.ini\n`));
	});

	test("a symlink is granted, and shown, as the file it leads to", async () => {
		const proj = path.join(realpathSync(dir), "linked-proj");
		mkdirSync(proj, { recursive: true });
		writeFileSync(path.join(proj, "real.env"), "A=1\n");
		symlinkSync("real.env", path.join(proj, ".env"));
		c.onRequest = () => ({ action: "accept" });
		const r = await c.tool("vm_grant", { spec: `file:${proj}/.env`, reason: "x" });
		assert.equal(r.isError, false, r.content[0].text);
		assert.equal(grantCalls().at(-1), `grant fakevm file:${proj}/real.env=project/.env`, "the real path is stored; the remote keeps the requested name");
		const msg = c.requests.at(-1).params.message;
		assert.ok(msg.includes(`file: ${proj}/real.env\n  (the agent asked for ${proj}/.env, which leads here through a symlink)\n  → in the VM: ~/project/.env\n`), msg);
		assert.ok(msg.includes(`revoke fakevm file:${proj}/real.env`), msg);
	});

	test("refused before any prompt: boxery's own files, http: grants, unset env vars, bad specs", async () => {
		const n = c.requests.length;
		const err = async (args) => {
			const r = await c.tool("vm_grant", { reason: "x", ...args });
			assert.equal(r.isError, true, JSON.stringify(args));
			return r.content[0].text;
		};
		assert.match(await err({ spec: `file:${path.join(env.BOXERY_HOME, "ssh_config")}` }), /boxery's own configuration/);
		assert.match(await err({ spec: "file:/no/such/file" }), /no such local file/);
		assert.match(await err({ spec: `file:${path.join(dir, "auth.ini")}=../../etc/x` }), /invalid remote path/);
		assert.match(await err({ spec: "http:api.example.com" }), /needs a command[\s\S]*only the user can add it/);
		assert.match(await err({ spec: "env:SURELY_UNSET_FOR_BOXERY" }), /isn't set where boxery runs[\s\S]*boxery --host local grant fakevm env:SURELY_UNSET_FOR_BOXERY --cmd/);
		assert.match(await err({ spec: "ssh-agent", readonly: true }), /readonly applies only to the github grant/);
		assert.match(await err({ spec: "everything" }), /unknown grant/);
		assert.equal(c.requests.length, n, "no prompt for a request that can't be granted");
	});

	test("keys, boxery's state and agent logins are refused, also through a symlink; so are boxery's env vars", async () => {
		const home = mkdtempSync(path.join(dir, "grant-home-"));
		const conf = path.join(dir, "grant-hostconf");
		const files = [".ssh/id_ed25519", ".gnupg/private-keys-v1.d/k.key", ".config/boxery/mgmt_ed25519", ".config/boxery/tokens.json", ".config/boxery/proxy.env", ".config/boxery-work/proxy.env", ".pi/agent/auth.json"].map((f) => path.join(home, f));
		for (const f of [...files, path.join(conf, "proxy.env")]) {
			mkdirSync(path.dirname(f), { recursive: true });
			writeFileSync(f, "secret\n");
		}
		mkdirSync(path.join(home, "proj"));
		symlinkSync(path.join(home, ".config/boxery/tokens.json"), path.join(home, "proj/tokens.json"));
		symlinkSync(path.join(home, ".ssh"), path.join(home, "proj/keys"));
		const h = await elicitClient("2025-06-18", {}, { HOME: home, BOXERY_CONF: conf, BOXERY_MCP_TOKEN: "t0ken" });
		h.onRequest = () => ({ action: "accept" });
		const before = grantCalls().length;
		const err = async (spec) => {
			const r = await h.tool("vm_grant", { spec, reason: "x" });
			assert.equal(r.isError, true, `${spec}: ${r.content[0].text}`);
			return r.content[0].text;
		};
		try {
			for (const f of files.slice(0, 2)) assert.match(await err(`file:${f}`), /holds keys; request ssh-agent instead/);
			for (const f of [...files.slice(2), path.join(conf, "proxy.env"), path.join(env.BOXERY_HOME, "ssh_config")]) assert.match(await err(`file:${f}`), /boxery's own configuration or the user's credentials\) and can't be granted/);
			assert.match(await err("file:~/proj/tokens.json"), /proj\/tokens\.json \(→ .*\/\.config\/boxery\/tokens\.json\) is inside/);
			assert.match(await err("file:~/proj/keys/id_ed25519"), /holds keys/);
			assert.match(await err("env:BOXERY_MCP_TOKEN"), /\$BOXERY_MCP_TOKEN is boxery's own setting and can't be requested/);
			assert.equal(h.requests.length, 0, "no prompt for any of them");
			assert.equal(grantCalls().length, before);
		} finally {
			h.close();
		}
	});

	test("something already granted is reported without a prompt", async () => {
		const n = c.requests.length;
		const r = await c.tool("vm_grant", { vm: "granted", spec: "ssh-agent", reason: "x" });
		assert.match(r.content[0].text, /^granted already has ssh-agent/);
		assert.equal(c.requests.length, n);
	});

	test("one prompt at a time per session; cancelling the call withdraws its prompt", { timeout: 15_000 }, async () => {
		let answerFirst;
		c.onRequest = () => new Promise((r) => (answerFirst = r));
		const first = c.call("tools/call", { name: "vm_grant", arguments: { spec: "ssh-agent", reason: "x" } });
		while (!answerFirst) await new Promise((r) => setTimeout(r, 10));
		const second = await c.tool("vm_grant", { spec: "github", reason: "y" });
		assert.equal(second.isError, true);
		assert.match(second.content[0].text, /Another grant request is waiting/);
		answerFirst({ action: "decline" });
		assert.match((await first).result.content[0].text, /declined/);

		c.onRequest = () => undefined; // never answer
		const asked = c.requests.length;
		const pending = c.call("tools/call", { name: "vm_grant", arguments: { spec: "ssh-agent", reason: "x" } });
		const callId = c.lastId;
		while (c.requests.length === asked) await new Promise((r) => setTimeout(r, 10));
		const prompt = c.requests.at(-1);
		c.notify("notifications/cancelled", { requestId: callId });
		assert.match((await pending).result.content[0].text, /aborted/);
		assert.ok(c.notifications.some((m) => m.method === "notifications/cancelled" && m.params.requestId === prompt.id), "the server withdraws its elicitation");
	});

	test("2025-11-25 clients get mode:form; clients declaring only URL elicitation get no prompt", async () => {
		const c2 = await elicitClient("2025-11-25", { form: {}, url: {} });
		c2.onRequest = () => ({ action: "decline" });
		await c2.tool("vm_grant", { spec: "ssh-agent", reason: "x" });
		assert.equal(c2.requests.at(-1).params.mode, "form");
		c2.close();
		const urlOnly = await elicitClient("2025-11-25", { url: {} });
		const r = await urlOnly.tool("vm_grant", { spec: "ssh-agent", reason: "x" });
		assert.match(r.content[0].text, /can't show the user an approval prompt/);
		assert.equal(urlOnly.requests.length, 0);
		urlOnly.close();
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

	test("--no-auth is refused unless listening on loopback", async () => {
		for (const listen of ["0.0.0.0:1", "192.0.2.1:1", "[::]:1"]) {
			const q = spawn(process.execPath, [SERVER, "--http", listen, "--no-auth"], { env: { ...env, BOXERY_MCP_TOKEN: "" }, stdio: "ignore" });
			assert.equal(await new Promise((r) => q.on("exit", r)), 2, listen);
		}
		const lport = 20000 + Math.floor(Math.random() * 20000);
		const q = spawn(process.execPath, [SERVER, "--http", `127.0.0.1:${lport}`, "--vm", "fakevm", "--no-auth"], { env: { ...env, BOXERY_MCP_TOKEN: "" }, stdio: "ignore" });
		try {
			let r;
			for (let i = 0; i < 50 && !r; i++) {
				r = await fetch(`http://127.0.0.1:${lport}/mcp`, { method: "POST", headers: H, body: JSON.stringify(init) }).catch(() => null);
				if (!r) await new Promise((res) => setTimeout(res, 100));
			}
			assert.equal(r?.status, 200, "loopback --no-auth serves without a token");
		} finally {
			q.kill();
		}
	});

	test("auth: token required, Tailscale user allowlist, Origin check", async () => {
		assert.equal((await post(init)).status, 401);
		for (const bad of ["Bearer nope", "Bearer t0ke", `Bearer ${token}x`, `Bearer ${token}${"x".repeat(4096)}`, token, `bearer ${token}`, "Bearer "]) {
			assert.equal((await post(init, { authorization: bad })).status, 401, bad.slice(0, 40));
		}
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
		const acq = await (await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "vm_lease", arguments: { action: "acquire", use: false } } }, { ...auth, "mcp-session-id": sid })).json();
		assert.match(acq.result.content[0].text, /^leased pool-1/);
		const del = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "DELETE", headers: { ...auth, "mcp-session-id": sid } });
		assert.equal(del.status, 204);
		assert.equal(readFileSync(path.join(env.BOXERY_HOME, "calls"), "utf8").trim().split("\n").at(-1), "release l-0123456789abcdef0123456789abcdef", "DELETE releases the session's leases");
		assert.equal((await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { ...auth, "mcp-session-id": sid })).status, 404, "deleted session");
	});

	test("vm_grant prompts over the call's SSE stream; the answer arrives as its own POST", async () => {
		const auth = { authorization: `Bearer ${token}`, "tailscale-user-login": "me@x" };
		const sid = (await post({ ...init, params: { ...init.params, capabilities: { elicitation: {} } } }, auth)).headers.get("mcp-session-id");
		const h = { ...auth, "mcp-session-id": sid };
		const r = await post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "vm_grant", arguments: { spec: "ssh-agent", reason: "git over ssh" } } }, h);
		assert.match(r.headers.get("content-type"), /text\/event-stream/);
		const reader = r.body.getReader();
		let buf = "";
		const next = async () => {
			for (;;) {
				const end = buf.indexOf("\n\n");
				if (end >= 0) {
					const e = JSON.parse(buf.slice(0, end).replace(/^event: message\ndata: /, ""));
					buf = buf.slice(end + 2);
					return e;
				}
				const { value, done } = await reader.read();
				if (done) throw new Error("stream ended");
				buf += new TextDecoder().decode(value);
			}
		};
		const ask = await next();
		assert.equal(ask.method, "elicitation/create");
		assert.match(ask.params.message, /ssh-agent/);
		assert.equal((await post({ jsonrpc: "2.0", id: ask.id, result: { action: "accept" } }, h)).status, 202);
		const done = await next();
		assert.equal(done.id, 7);
		assert.match(done.result.content[0].text, /^The user approved: fakevm now has ssh-agent/);
		const plainJson = await post({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "vm_grant", arguments: { spec: "ssh-agent", reason: "x" } } }, { ...h, accept: "application/json" });
		assert.match((await plainJson.json()).result.content[0].text, /can't show the user an approval prompt/, "no stream, no prompt");
	});

	test("vm_copy local: is refused by default: it would be the control plane's files", async () => {
		const auth = { authorization: `Bearer ${token}`, "tailscale-user-login": "me@x" };
		const r = await post(init, auth);
		const sid = r.headers.get("mcp-session-id");
		assert.match((await r.json()).result.instructions, /vm_copy: .*`local:` endpoints are disabled/);
		const h = { ...auth, "mcp-session-id": sid };
		const tools = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, h)).json()).result.tools;
		assert.match(tools.find((t) => t.name === "vm_copy").description, /`local:` endpoints are disabled/);
		const copy = async (args) => (await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vm_copy", arguments: args } }, h)).json()).result;
		const read = await copy({ from: "local:~/.config/boxery/proxy.env", to: "fakevm:/home/agent/project/stolen.env" });
		assert.equal(read.isError, true);
		assert.match(read.content[0].text, /local: endpoints are disabled on this server/);
		const target = path.join(dir, "http-default-write.txt");
		writeFileSync(path.join(env.VMROOT, "project/to-host.txt"), "x");
		const write = await copy({ from: "fakevm:to-host.txt", to: `local:${target}` });
		assert.equal(write.isError, true);
		assert.match(write.content[0].text, /disabled/);
		assert.ok(!existsSync(target));
		assert.ok(!existsSync(path.join(env.VMROOT, "project/stolen.env")));
	});

	test("a multi-byte character split across request chunks arrives intact", async () => {
		const auth = { authorization: `Bearer ${token}`, "tailscale-user-login": "me@x" };
		const sid = (await post(init, auth)).headers.get("mcp-session-id");
		const content = "café 日本語 🦀 end\n";
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "vm_write", arguments: { path: "utf8-split.txt", content } } }));
		const split = body.indexOf(Buffer.from("🦀")) + 2; // inside the crab's four bytes
		const reply = await new Promise((resolve, reject) => {
			const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { ...H, ...auth, "mcp-session-id": sid } }, (res) => {
				let text = "";
				res.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => resolve({ status: res.statusCode, text }));
			});
			req.on("error", reject);
			// Two chunked writes with a pause, so the server reads them as separate chunks.
			req.write(body.subarray(0, split));
			setTimeout(() => req.end(body.subarray(split)), 100);
		});
		assert.equal(reply.status, 200, reply.text);
		assert.equal(JSON.parse(reply.text).result.isError, false, reply.text);
		assert.equal(readFileSync(path.join(env.VMROOT, "project/utf8-split.txt"), "utf8"), content);
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

/** A ustar archive from {name, type ("0" file, "1" hard link, "2" symlink, "5" dir), body, link}. For hostile-VM tests. */
function tarball(entries) {
	const blocks = entries.flatMap(({ name, type = "0", body = "", link = "" }) => {
		const h = Buffer.alloc(512);
		let prefix = "";
		if (Buffer.byteLength(name) > 100) {
			const cut = name.lastIndexOf("/", name.length - 2);
			[prefix, name] = [name.slice(0, cut), name.slice(cut + 1)];
		}
		assert.ok(Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(link) <= 100, "tar test path too long");
		const data = Buffer.from(body);
		const put = (at, s) => h.write(s, at);
		put(0, name);
		put(100, `${(type === "5" ? 0o755 : 0o644).toString(8).padStart(7, "0")}\0`);
		put(108, "0000000\0");
		put(116, "0000000\0");
		put(124, `${data.length.toString(8).padStart(11, "0")}\0`);
		put(136, `${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`);
		put(148, "        ");
		put(156, type);
		put(157, link);
		put(257, "ustar\0");
		put(263, "00");
		put(345, prefix);
		put(148, `${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `);
		return [h, Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])];
	});
	return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

describe("http vm_copy --copy-root", () => {
	let p, port, sid, home, outside;
	const token = "t0ken";
	const vm = (f) => path.join(env.VMROOT, "project", f);
	const rpc = async (method, params) => {
		const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}`, ...(sid ? { "mcp-session-id": sid } : {}) },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		sid ??= r.headers.get("mcp-session-id");
		return (await r.json()).result;
	};
	const copy = (from, to) => rpc("tools/call", { name: "vm_copy", arguments: { from, to } });
	const ok = async (from, to) => {
		const r = await copy(from, to);
		assert.equal(r.isError, false, `${from} → ${to}: ${r.content[0].text}`);
	};
	const refused = async (from, to, re) => {
		const r = await copy(from, to);
		assert.equal(r.isError, true, `${from} → ${to} should be refused: ${r.content[0].text}`);
		assert.match(r.content[0].text, re);
	};

	before(async () => {
		// The fake HOME is also the copy root, so it holds the directories that stay refused inside it.
		const base = mkdtempSync(path.join(dir, "copy-root-"));
		home = path.join(base, "home");
		outside = path.join(base, "outside");
		mkdirSync(path.join(home, ".ssh"), { recursive: true });
		writeFileSync(path.join(home, ".ssh/authorized_keys"), "KEYS\n");
		mkdirSync(path.join(home, ".config/boxery/edge"), { recursive: true });
		writeFileSync(path.join(home, ".config/boxery/proxy.env"), "OPENAI_API_KEY=sk-secret\n");
		mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
		writeFileSync(path.join(home, ".pi/agent/auth.json"), "{}\n");
		mkdirSync(path.join(home, "work"));
		writeFileSync(path.join(home, "work/notes.txt"), "NOTES\n");
		mkdirSync(outside);
		writeFileSync(path.join(outside, "secret.txt"), "SECRET\n");
		symlinkSync(outside, path.join(home, "work/out-dir"));
		symlinkSync(path.join(outside, "secret.txt"), path.join(home, "work/out-file"));
		symlinkSync(path.join(home, ".ssh"), path.join(home, "work/ssh-link"));
		symlinkSync(path.join(outside, "missing"), path.join(home, "work/dangling"));
		writeFileSync(vm("to-host.txt"), "FROM_VM\n");
		port = 20000 + Math.floor(Math.random() * 20000);
		p = spawn(process.execPath, [SERVER, "--http", `127.0.0.1:${port}`, "--vm", "fakevm", "--copy-root", home], { env: { ...env, HOME: home, BOXERY_MCP_TOKEN: token }, stdio: "ignore" });
		for (let i = 0; i < 50; i++) {
			try {
				if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
			} catch {}
			await new Promise((r) => setTimeout(r, 100));
		}
		const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
		assert.match(init.instructions, /vm_copy: .*confined to /);
	});
	after(() => p?.kill());

	test("--copy-root inside boxery's configuration is refused at startup", async () => {
		const q = spawn(process.execPath, [SERVER, "--http", "127.0.0.1:1", "--copy-root", path.join(home, ".config/boxery")], { env: { ...env, HOME: home, BOXERY_MCP_TOKEN: token }, stdio: "ignore" });
		assert.notEqual(await new Promise((r) => q.on("exit", r)), 0);
	});

	test("copies inside the root work both ways; relative paths resolve there", async () => {
		await ok("local:work/notes.txt", "fakevm:cr-notes.txt");
		assert.equal(readFileSync(vm("cr-notes.txt"), "utf8"), "NOTES\n");
		await ok("fakevm:to-host.txt", "local:work/back.txt");
		assert.equal(readFileSync(path.join(home, "work/back.txt"), "utf8"), "FROM_VM\n");
		writeFileSync(vm("to-host.txt"), "FROM_VM v2\n");
		await ok("fakevm:to-host.txt", "local:work/back.txt"); // a file is replaced
		assert.equal(readFileSync(path.join(home, "work/back.txt"), "utf8"), "FROM_VM v2\n");
		mkdirSync(vm("cr-dir"));
		writeFileSync(vm("cr-dir/a.txt"), "A\n");
		await ok("fakevm:cr-dir", "local:work");
		assert.equal(readFileSync(path.join(home, "work/cr-dir/a.txt"), "utf8"), "A\n");
		await refused("fakevm:cr-dir", "local:work", /already exists.*doesn't merge/);
	});

	test("reads outside the root fail, including through symlinks and ..", async () => {
		for (const [from, re] of [
			[`local:${outside}/secret.txt`, /outside the copy root/],
			["local:../outside/secret.txt", /"\.\." is not allowed/],
			["local:work/out-file", /outside the copy root/],
			["local:work/out-dir", /outside the copy root/],
			["local:work/out-dir/secret.txt", /outside the copy root/],
			["local:~/.config/boxery/proxy.env", /boxery's own configuration or keys/],
			["local:.ssh/authorized_keys", /boxery's own configuration or keys/],
			["local:work/ssh-link/authorized_keys", /boxery's own configuration or keys/],
			["local:.pi/agent/auth.json", /boxery's own configuration or keys/],
			["local:~", /is or holds/], // the root itself holds ~/.ssh
		])
			await refused(from, "fakevm:stolen", re);
		assert.ok(!existsSync(vm("stolen")));
	});

	test("writes outside the root fail, including through symlinks", async () => {
		mkdirSync(vm(".ssh"), { recursive: true });
		writeFileSync(vm(".ssh/authorized_keys"), "ATTACKER\n");
		for (const [from, to, re] of [
			["fakevm:to-host.txt", `local:${outside}/w.txt`, /outside the copy root/],
			["fakevm:to-host.txt", "local:../outside/w.txt", /"\.\." is not allowed/],
			["fakevm:to-host.txt", "local:work/out-dir/w.txt", /outside the copy root/],
			["fakevm:to-host.txt", "local:work/out-dir", /outside the copy root/],
			["fakevm:to-host.txt", "local:work/dangling", /symlink to a missing path/],
			["fakevm:to-host.txt", "local:work/dangling/w.txt", /symlink to a missing path/],
			["fakevm:.ssh/authorized_keys", "local:.ssh/authorized_keys", /boxery's own configuration or keys/],
			["fakevm:.ssh/authorized_keys", "local:work/ssh-link/authorized_keys", /boxery's own configuration or keys/],
			["fakevm:.ssh", "local:.", /boxery's own configuration or keys/], // would land on ~/.ssh
			["fakevm:to-host.txt", "local:.config/boxery/edge/x.json", /boxery's own configuration or keys/],
		])
			await refused(from, to, re);
		assert.deepEqual(readdirSync(outside), ["secret.txt"]);
		assert.equal(readFileSync(path.join(home, ".ssh/authorized_keys"), "utf8"), "KEYS\n");
		assert.deepEqual(readdirSync(path.join(home, ".config/boxery/edge")), []);
	});

	test("a VM can't write outside the root with archive entries or symlinks it planted", async () => {
		// 1. A hostile archive: absolute and ../ entries, and a file through a symlink it just made.
		mkdirSync(vm("crafted"));
		writeFileSync(vm("crafted/.crafted.tar"), tarball([
			{ name: "payload/", type: "5" },
			{ name: "payload/esc", type: "2", link: outside },
			{ name: "payload/esc/evil.txt", body: "PWNED\n" },
			{ name: `${outside}/abs-evil.txt`, body: "PWNED\n" },
			// Enough ../ to climb from the staging directory (ROOT/work/.boxery-copy-*/data) to /.
			{ name: `${"../".repeat(realpathSync(home).split("/").length + 3)}${outside.slice(1)}/dotdot-evil.txt`, body: "PWNED\n" },
		]));
		await copy("fakevm:crafted/payload", "local:work/crafted"); // tar refuses some entries; either way nothing escapes
		assert.deepEqual(readdirSync(outside), ["secret.txt"]);

		// 2. Plant a symlink with one copy, then write through it with a second: never merged into.
		mkdirSync(vm("plant1/m"), { recursive: true });
		symlinkSync(outside, vm("plant1/m/esc"));
		await ok("fakevm:plant1/m", "local:work/m");
		assert.ok(lstatSync(path.join(home, "work/m/esc")).isSymbolicLink(), "the symlink itself arrives");
		mkdirSync(vm("plant2/m/esc"), { recursive: true });
		writeFileSync(vm("plant2/m/esc/evil.txt"), "PWNED\n");
		await refused("fakevm:plant2/m", "local:work", /already exists/);
		await refused("fakevm:plant2/m/esc", "local:work/m", /already exists/);
		await refused("fakevm:plant2/m/esc/evil.txt", "local:work/m/esc/evil.txt", /outside the copy root/);
		await refused("local:work/m/esc", "fakevm:stolen", /outside the copy root/);
		assert.deepEqual(readdirSync(outside), ["secret.txt"]);

		// 3. A hard link to a file outside the copied entry (tar itself refuses ones outside the staging area).
		mkdirSync(vm("hardlink"));
		writeFileSync(vm("hardlink/.crafted.tar"), tarball([
			{ name: "other", body: "OTHER\n" },
			{ name: "payload/", type: "5" },
			{ name: "payload/hl", type: "1", link: "other" },
		]));
		await refused("fakevm:hardlink/payload", "local:work/hl", /hard-links a file outside the copy/);
		assert.ok(!existsSync(path.join(home, "work/hl")));
		// No staging directories are left behind.
		assert.deepEqual(readdirSync(path.join(home, "work")).filter((f) => f.startsWith(".boxery-copy-")), []);
	});
});
