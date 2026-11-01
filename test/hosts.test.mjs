// Isolated host-aware core/MCP regressions. No real SSH, HOME, credentials or VM host.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER = path.join(ROOT, "mcp/boxery-mcp.mjs");
let dir, env;
const clients = [];
const text = (r) => r.content[0].text;
const vmroot = (host) => path.join(dir, `vm-${host}`);
const profile = (host) => path.join(dir, "home", "profiles", host);
const calls = (host) => readFileSync(path.join(vmroot(host), "calls"), "utf8");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

before(() => {
	dir = mkdtempSync(path.join(tmpdir(), "boxery-hosts-"));
	const bin = path.join(dir, "bin");
	mkdirSync(bin);
	mkdirSync(path.join(dir, "home", "host-registry"), { recursive: true });
	for (const host of ["alpha", "beta"]) {
		mkdirSync(profile(host), { recursive: true });
		mkdirSync(path.join(vmroot(host), "project"), { recursive: true });
		writeFileSync(path.join(profile(host), "config"), "# fake controller config\n");
		writeFileSync(path.join(profile(host), "ssh_config"), "# fake SSH config\n");
		writeFileSync(path.join(dir, "home", "host-registry", host), `${profile(host)}\n`);
		writeFileSync(path.join(vmroot(host), "calls"), "");
	}
	writeFileSync(path.join(dir, "home", "default-host"), "alpha\n");
	writeFileSync(path.join(bin, "boxery"), `#!/usr/bin/env bash
[ "$1" != --host ] || shift 2
tag="PROFILE:$(basename "$BOXERY_HOME") OVERRIDES:\${BOXERY_HOST-}:\${BOXERY_HOST_BIN-}"
case "$*" in
"ls --json") printf '[{"name":"fakevm","state":"running","ssh_addr":"%s"}]\\n' "$tag" ;;
"grants "*" --json") printf '[{"kind":"file","local":"%s","remote":"fixture"}]\\n' "$tag" ;;
*) printf '%s\\nCOMMAND:%s\\n' "$tag" "$*" ;;
esac
`);
	writeFileSync(path.join(bin, "ssh"), `#!/usr/bin/env bash
conf=""; vm=""
while [ $# -gt 1 ]; do case $1 in -F) conf=$2; shift 2 ;; -o) shift 2 ;; *.boxery) vm=$1; shift ;; *) shift ;; esac; done
[ "$vm" = fakevm.boxery ] || exit 255
host=$(basename "$(dirname "$conf")")
case $host in alpha|beta) ;; *) echo 'wrong profile' >&2; exit 255 ;; esac
vmroot=${JSON.stringify(dir)}/vm-$host
cmd=\${1//\\/home\\/agent/$vmroot}
printf '%s\\n' "$cmd" >>"$vmroot/calls"
# Keep multi-step core tools overlapped to catch lost async host context.
sleep 0.02
case $cmd in
 *getdisplaygeometry*) if [ "$host" = alpha ]; then echo '2560 1440' >&2; else echo '1280 720' >&2; fi; printf 'fake-png'; exit 0 ;;
 *xdotool*) exit 0 ;;
esac
cd "$vmroot" && HOST_TAG=$host HOME="$vmroot" exec bash -c "$cmd"
`);
	writeFileSync(path.join(bin, "setsid"), "#!/usr/bin/env bash\n[ \"$1\" != -w ] || shift\nexec perl -e 'setpgrp(0,0); exec @ARGV or die' -- \"$@\"\n");
	for (const f of ["boxery", "ssh", "setsid"]) chmodSync(path.join(bin, f), 0o755);
	env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: path.join(dir, "isolated-home"), BOXERY_HOME: path.join(dir, "home"), BOXERY_VM: "", BOXERY_BIN: path.join(bin, "boxery"), BOXERY_HOST: "must-not-leak", BOXERY_HOST_BIN: "/must/not/leak" };
});
after(() => {
	for (const c of clients) c.close();
	rmSync(dir, { recursive: true, force: true });
});

function client(args = [], overrides = {}) {
	const p = spawn(process.execPath, [SERVER, ...args], { env: { ...env, ...overrides }, stdio: ["pipe", "pipe", "pipe"] });
	let buf = "", id = 0;
	const waiting = new Map();
	p.stdout.on("data", (d) => {
		buf += d;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const msg = JSON.parse(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
			waiting.get(msg.id)?.(msg);
			waiting.delete(msg.id);
		}
	});
	p.on("exit", () => { for (const resolve of waiting.values()) resolve({ error: "server exited" }); });
	const call = (method, params) => new Promise((resolve) => {
		const i = ++id;
		waiting.set(i, resolve);
		p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method, params })}\n`);
	});
	const c = { call, tool: async (name, a) => (await call("tools/call", { name, arguments: a })).result, close: () => p.kill() };
	clients.push(c);
	return c;
}

// Run core in its own process, rather than mutate global process.env for profile selection.
test("core registry, default/legacy resolution, trusted contexts and per-call subprocess env", () => {
	const script = `
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import * as c from ${JSON.stringify(new URL("../core/boxery-core.mjs", import.meta.url).href)};
assert.equal(c.resolveHost().name, 'alpha');
assert.equal(c.currentHost().name, 'alpha');
try {
 writeFileSync(c.BOXERY_HOME + '/default-host', 'beta\\n');
 assert.equal(c.resolveHost().name, 'beta');
 assert.equal(c.currentHost().name, 'alpha', 'implicit pi transport default stays pinned');
 assert.equal(c.controllerCommand(['desktop','fakevm']).env.BOXERY_HOME, c.resolveHost('alpha').dir);
} finally {writeFileSync(c.BOXERY_HOME + '/default-host', 'alpha\\n');}

assert.equal(c.resolveHost('legacy').dir, c.BOXERY_HOME);
assert.deepEqual(c.registeredHosts().map(h => h.name), ['legacy','alpha','beta']);
for (const bad of ['', '../alpha', '-oX', 'a/b', { name:'alpha', dir:'/tmp/arbitrary' }]) assert.throws(() => c.resolveHost(bad), /invalid host/);
assert.throws(() => c.resolveHost('unknown'), /unknown host/);
assert.throws(() => c.parseLoc('unknown/fakevm:/x', 'fakevm'), /unknown host/);
assert.throws(() => c.parseLoc('../fakevm:/x', 'fakevm'), /invalid host/);
const loc = c.parseLoc('beta/fakevm:foo', 'fakevm');
assert.equal(loc.host.name, 'beta'); assert.equal(loc.vm, 'fakevm');
const before = {...process.env};
const [a,b] = await Promise.all(['alpha','beta'].map(h => c.withHost(h, async () => {
 await c.sleep(h === 'alpha' ? 20 : 1);
 const cmd = c.controllerCommand(['ls']);
 assert.equal(cmd.env.BOXERY_HOME, c.resolveHost(h).dir);
 assert.equal(cmd.env.BOXERY_HOST, undefined);
 assert.equal(cmd.env.BOXERY_HOST_BIN, undefined);
 const [ssh, listed] = await Promise.all([
  c.sshOk('fakevm', 'printf %s "$HOST_TAG"'),
  c.listVms()
 ]);
 assert.equal(listed[0].ssh_addr, 'PROFILE:' + h + ' OVERRIDES::', 'JSON subprocess stays host-scoped');
 return ssh.toString();
})));
assert.deepEqual([a,b], ['alpha','beta']);
assert.deepEqual({...process.env}, before);
console.log('core host assertions passed');
`;
	assert.match(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" }), /core host assertions passed/);
});

test("all MCP schemas accept host; default/startup selection and VM ownership fail closed", async () => {
	const c = client(["--vm", "fakevm"]);
	const tools = (await c.call("tools/list")).result.tools;
	for (const t of tools) assert.equal(t.inputSchema.properties.host.type, "string", t.name);
	assert.match(text(await c.tool("vm_bash", { command: 'echo "$HOST_TAG"' })), /^alpha\n/);
	assert.equal((await c.tool("vm_bash", { host: "beta", command: "true" })).isError, true);
	assert.match(text(await c.tool("vm_bash", { host: "beta", vm: "fakevm", command: 'echo "$HOST_TAG"' })), /^beta\n/);
	for (const host of ["unknown", "../alpha", "", null, "alpha\n", { name: "beta", dir: profile("beta") }])
		assert.equal((await c.tool("vm_bash", { host, vm: "fakevm", command: "true" })).isError, true);
	assert.match(text(await c.tool("vm_info", { action: "hosts" })), /alpha \*/);
	assert.equal((await c.tool("vm_manage", { action: "add", vm: "untrusted" })).isError, true);
	assert.equal((await c.tool("vm_manage", { action: "host", host: "beta" })).isError, false);
	assert.equal((await c.tool("vm_bash", { command: "true" })).isError, true, "host switch must clear VM");
	assert.equal((await c.tool("vm_manage", { action: "use", host: "beta", vm: "fakevm" })).isError, false);
	assert.match(text(await c.tool("vm_bash", { command: 'echo "$HOST_TAG"' })), /^beta\n/);
	assert.match(text(await c.tool("vm_info", { action: "grants", vm: "fakevm" })), /PROFILE:beta OVERRIDES::/);
	await c.tool("vm_manage", { action: "rm", host: "alpha", vm: "fakevm" });
	assert.equal((await c.tool("vm_bash", { command: "true" })).isError, false, "other-host rm must not clear selected pair");
	await c.tool("vm_manage", { action: "rm", host: "beta", vm: "fakevm" });
	assert.equal((await c.tool("vm_bash", { command: "true" })).isError, true);
	await c.tool("vm_manage", { action: "new", host: "alpha", vm: "fakevm", use: true });
	assert.match(text(await c.tool("vm_bash", { command: 'echo "$HOST_TAG"' })), /^alpha\n/);
	const other = client(["--host", "beta", "--vm", "fakevm"]);
	assert.match(text(await other.tool("vm_bash", { command: 'echo "$HOST_TAG"' })), /^beta\n/);
});

test("vm_manage host_add/host_rm run against the registry root with only validated arguments; build-base on the call's host", async () => {
	const c = client(["--host", "beta"]);
	const out = text(await c.tool("vm_manage", { action: "host_add", name: "gamma", dest: "local", backend: "exe" }));
	assert.match(out, /PROFILE:home OVERRIDES::\nCOMMAND:host add gamma local --backend exe\n/, "registry root, not the session's profile");
	assert.match(out, /action:"host", host:"gamma"/);
	assert.match(text(await c.tool("vm_manage", { action: "host_add", name: "delta", dest: "me@box", profile: "exe" })), /COMMAND:host add delta me@box --profile exe\n/);
	// Registers, then builds on the new host's profile (here an existing fixture so the stub can resolve it).
	assert.match(text(await c.tool("vm_manage", { action: "host_add", name: "alpha", dest: "local", backend: "lima", buildBase: true })), /PROFILE:alpha OVERRIDES::\nCOMMAND:build-base/);
	for (const bad of [{ name: "legacy", dest: "local" }, { name: "Bad", dest: "local" }, { name: "gamma", dest: "-oProxyCommand=x" }, { name: "gamma", dest: "a b" },
		{ name: "gamma", dest: "local", backend: "../x" }, { name: "gamma", dest: "local", profile: "-x" }, { name: "gamma" }, { name: "gamma", dest: "local", host: "beta" }])
		assert.equal((await c.tool("vm_manage", { action: "host_add", ...bad })).isError, true, JSON.stringify(bad));
	assert.match(text(await c.tool("vm_info", { action: "list" })), /host: beta/, "session host unchanged");
	// build-base on the call's host; host_rm forgets a registration against the registry root.
	assert.match(text(await c.tool("vm_manage", { action: "build-base", host: "alpha" })), /PROFILE:alpha OVERRIDES::\nCOMMAND:build-base$/);
	assert.match(text(await c.tool("vm_manage", { action: "host_rm", name: "gamma" })), /^PROFILE:home OVERRIDES::\nCOMMAND:host rm gamma$/);
	assert.match(text(await c.tool("vm_manage", { action: "host_rm", name: "beta" })), /COMMAND:host rm beta\nthis session still uses beta/);
	for (const bad of [{ name: "legacy" }, { name: "../x" }, {}, { name: "gamma", host: "beta" }])
		assert.equal((await c.tool("vm_manage", { action: "host_rm", ...bad })).isError, true, JSON.stringify(bad));
});

test("startup host failures, BOXERY_VM and alias replacement cannot inherit a different profile's VM", async () => {
	for (const args of [["--host"], ["--host", "unknown"], ["--host", "../alpha"]]) {
		const p = spawn(process.execPath, [SERVER, ...args], { env, stdio: "ignore" });
		assert.notEqual(await new Promise((resolve) => p.on("exit", resolve)), 0);
	}
	const c = client(["--host", "alpha"], { BOXERY_VM: "fakevm" });
	assert.match(text(await c.tool("vm_bash", { command: 'echo "$HOST_TAG"' })), /^alpha\n/);
	const pointer = path.join(dir, "home", "host-registry", "alpha");
	try {
		writeFileSync(pointer, `${profile("beta")}\n`);
		assert.equal((await c.tool("vm_bash", { host: "alpha", command: "true" })).isError, true);
		await c.tool("vm_manage", { action: "rm", host: "alpha", vm: "fakevm" });
		assert.match(text(await c.tool("vm_bash", { command: 'echo "$HOST_TAG"' })), /^alpha\n/, "resolved sessions retain their original profile");
	} finally { writeFileSync(pointer, `${profile("alpha")}\n`); }
});

test("concurrent duplicate VM calls, nested tools and screenshots remain host-isolated", async () => {
	const c = client(["--host", "alpha", "--vm", "fakevm"]);
	const slow = c.tool("vm_bash", { command: 'sleep 0.15; echo "$HOST_TAG"' });
	await c.tool("vm_manage", { action: "host", host: "beta" });
	assert.match(text(await slow), /^alpha\n/, "inflight host selection is snapshotted");
	await Promise.all(["alpha", "beta"].map(async (host) => {
		await c.tool("vm_write", { host, vm: "fakevm", path: "same-name.txt", content: host });
		const r = await c.tool("vm_read", { host, vm: "fakevm", path: "same-name.txt" });
		assert.equal(text(r), host);
		await c.tool("vm_screenshot", { host, vm: "fakevm" });
	}));
	for (const host of ["alpha", "beta"]) await c.tool("vm_click", { host, vm: "fakevm", x: 10, y: 20, screenshot: false });
	assert.match(calls("alpha"), /mousemove 20 40 click/);
	assert.match(calls("beta"), /mousemove 10 20 click/);
});

test("copy binds both hosts independently, supports local server paths and rejects unknown targets before writes", async () => {
	const c = client(["--host", "alpha", "--vm", "fakevm"]);
	await c.tool("vm_write", { path: "copy's.txt", content: "alpha-source" });
	let r = await c.tool("vm_copy", { from: "alpha/fakevm:copy's.txt", to: "beta/fakevm:received.txt" });
	assert.equal(r.isError, false, text(r));
	assert.equal(readFileSync(path.join(vmroot("beta"), "project/received.txt"), "utf8"), "alpha-source");
	const local = path.join(dir, "server-local's.txt");
	r = await c.tool("vm_copy", { from: "beta/fakevm:received.txt", to: `local:${local}` });
	assert.equal(r.isError, false, text(r));
	assert.equal(readFileSync(local, "utf8"), "alpha-source");
	r = await c.tool("vm_copy", { from: `local:${local}`, to: "fakevm:legacy-prefix.txt" });
	assert.equal(r.isError, false, text(r));
	assert.equal(readFileSync(path.join(vmroot("alpha"), "project/legacy-prefix.txt"), "utf8"), "alpha-source");
	assert.equal((await c.tool("vm_copy", { host: "beta", from: "bare-path", to: `local:${local}` })).isError, true, "do not inherit alpha's current VM");
	for (const endpoint of ["unknown/fakevm:/x", "bad host/fakevm:/x", "../fakevm:/x"])
		assert.equal((await c.tool("vm_copy", { from: `local:${local}`, to: endpoint })).isError, true);
	assert.equal(readFileSync(local, "utf8"), "alpha-source");
});

test("boxery cp runs vm_copy: same locations, --host and the default host route, bare paths are local", async () => {
	const cp = (...args) => new Promise((resolve) => {
		execFile(path.join(ROOT, "controller/boxery"), args, { env, cwd: dir }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr }));
	});
	writeFileSync(path.join(dir, "cli's bundle.git"), "cli-source");
	let r = await cp("cp", "cli's bundle.git", "fakevm:cli-one.git");
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /^copied local:.*cli's bundle\.git → alpha\/fakevm:\/home\/agent\/project\/cli-one\.git/);
	assert.equal(readFileSync(path.join(vmroot("alpha"), "project/cli-one.git"), "utf8"), "cli-source");
	r = await cp("--host", "beta", "cp", "local:cli's bundle.git", "fakevm:cli-beta.git");
	assert.equal(r.code, 0, r.stderr);
	assert.equal(readFileSync(path.join(vmroot("beta"), "project/cli-beta.git"), "utf8"), "cli-source");
	r = await cp("cp", "alpha/fakevm:cli-one.git", "beta/fakevm:cli-two.git");
	assert.equal(r.code, 0, r.stderr);
	assert.equal(readFileSync(path.join(vmroot("beta"), "project/cli-two.git"), "utf8"), "cli-source");
	r = await cp("cp", "beta/fakevm:cli-two.git", "./back.git");
	assert.equal(r.code, 0, r.stderr);
	assert.equal(readFileSync(path.join(dir, "back.git"), "utf8"), "cli-source");
	for (const args of [["cp", "only-one"], ["cp", "-r", "a", "b"], ["cp", "back.git", "unknown/fakevm:x"], ["cp", "back.git", "Bad:x"]]) {
		r = await cp(...args);
		assert.notEqual(r.code, 0, `boxery ${args.join(" ")} should fail`);
		assert.match(r.stderr, /^boxery: /);
	}
});

test("timeout cleanup stays on the snapshotted host after a concurrent session switch", async () => {
	// Previous copy calls also use cleanup commands; inspect only this timed-out call's traffic.
	const before = { alpha: calls("alpha").length, beta: calls("beta").length };
	const c = client(["--host", "alpha", "--vm", "fakevm"]);
	const pending = c.tool("vm_bash", { command: "sleep 30", timeout: 0.15 });
	await delay(70);
	await c.tool("vm_manage", { action: "host", host: "beta" });
	assert.match(text(await pending), /timed out/);
	await delay(150); // cleanup SSH starts asynchronously from the timer
	assert.match(calls("alpha").slice(before.alpha), /kill -TERM/);
	assert.doesNotMatch(calls("beta").slice(before.beta), /kill -TERM/);
});

test("HTTP startup defaults, overrides and sessions stay pinned across registry default changes", async () => {
	const defaultFile = path.join(dir, "home", "default-host");
	try {
		for (const startup of [
			{ args: [], host: "alpha", vm: null, changedDefault: "beta" },
			{ args: ["--host", "beta", "--vm", "fakevm"], host: "beta", vm: "fakevm", changedDefault: "legacy" },
		]) {
			writeFileSync(defaultFile, "alpha\n");
			const port = 20000 + Math.floor(Math.random() * 20000);
			const p = spawn(process.execPath, [SERVER, "--http", `127.0.0.1:${port}`, "--no-auth", ...startup.args], { env, stdio: "ignore" });
			clients.push({ close: () => p.kill() });
			const url = `http://127.0.0.1:${port}`;
			for (let i = 0; i < 50; i++) {
				try { if ((await fetch(`${url}/healthz`)).ok) break; } catch {}
				await delay(50);
			}
			let id = 0;
			const post = (method, params, sid) => fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
			const initialize = async () => {
				const response = await post("initialize", {});
				assert.equal(response.status, 200);
				const body = await response.json();
				assert.match(body.result.instructions, new RegExp(`Current host: ${startup.host}\\.`));
				return response.headers.get("mcp-session-id");
			};
			const tool = async (sid, name, args) => (await (await post("tools/call", { name, arguments: args }, sid)).json()).result;
			const assertStartup = async (sid) => {
				const listed = text(await tool(sid, "vm_info", { action: "list" }));
				assert.match(listed, new RegExp(`PROFILE:${startup.host} OVERRIDES::`));
				assert.ok(listed.includes(`current: ${startup.vm ?? "(none)"} (host: ${startup.host})`));
				const implicit = await tool(sid, "vm_bash", { command: 'echo "$HOST_TAG"' });
				if (startup.vm) assert.match(text(implicit), new RegExp(`^${startup.host}\\n`));
				else assert.equal(implicit.isError, true, "startup without --vm must not acquire a current VM");
				const explicitVm = await tool(sid, "vm_bash", { vm: "fakevm", command: 'echo "$HOST_TAG"' });
				assert.match(text(explicitVm), new RegExp(`^${startup.host}\\n`));
			};
			const first = await initialize();
			const second = await initialize();
			// No use/host mutation yet: prove registry default and explicit startup overrides directly.
			await Promise.all([first, second].map(assertStartup));
			writeFileSync(defaultFile, `${startup.changedDefault}\n`);
			const third = await initialize(); // New sessions also inherit this server's startup snapshot.
			await Promise.all([first, second, third].map(assertStartup));
			await Promise.all([[first, "alpha"], [second, "beta"]].map(([sid, host]) => tool(sid, "vm_manage", { action: "use", host, vm: "fakevm" })));
			const out = await Promise.all([first, second].map((sid) => tool(sid, "vm_bash", { command: 'sleep 0.1; echo "$HOST_TAG"' })));
			assert.match(text(out[0]), /^alpha\n/); assert.match(text(out[1]), /^beta\n/);
			await tool(first, "vm_manage", { action: "host", host: "beta" });
			assert.equal((await tool(first, "vm_bash", { command: "true" })).isError, true);
			assert.match(text(await tool(second, "vm_bash", { command: 'echo "$HOST_TAG"' })), /^beta\n/);
			await assertStartup(third); // Other sessions' mutations must not retarget its startup pair.
			const stopped = new Promise((resolve) => p.once("exit", resolve));
			p.kill();
			await stopped;
		}
	} finally { writeFileSync(defaultFile, "alpha\n"); }
});

test("vm_info hosts says where each host runs, its recorded backend, and which names are the same profile", async () => {
	const home = path.join(dir, "home");
	try {
		// As `boxery setup` writes it; the last assignment wins, as when the controller sources it.
		writeFileSync(path.join(profile("alpha"), "config"), "HOST='old@box'\nHOST_BIN='~/.local/bin/boxery-host'\nexport HOST=you@alpha-box # moved\n");
		writeFileSync(path.join(profile("alpha"), "backend"), "libvirt\n");
		writeFileSync(path.join(profile("beta"), "config"), 'HOST="$(whoami)@box"\n'); // needs execution: unknown, never run
		writeFileSync(path.join(profile("beta"), "backend"), "not a backend\n");
		writeFileSync(path.join(home, "config"), "HOST='local'\n");
		writeFileSync(path.join(home, "ssh_config"), "# fake SSH config\n");
		writeFileSync(path.join(home, "backend"), "lima\n");
		writeFileSync(path.join(home, "host-registry", "root"), `${home}\n`);
		const c = client(["--host", "alpha"]);
		await c.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } });
		const r = await c.tool("vm_info", { action: "hosts" });
		assert.equal(r.isError, false, text(r));
		const byName = Object.fromEntries(r.structuredContent.hosts.map((h) => [h.name, h]));
		assert.deepEqual(r.structuredContent.hosts.map((h) => h.name), ["legacy", "alpha", "beta", "root"]);
		// legacy routes through the ambient BOXERY_HOST override (as the controller does); named profiles never do.
		assert.deepEqual(byName.legacy, { name: "legacy", destination: "must-not-leak", backend: "lima", current: false, default: false, same_as: ["root"], dir: home });
		assert.deepEqual(byName.alpha, { name: "alpha", destination: "you@alpha-box", backend: "libvirt", current: true, default: true, same_as: [], dir: profile("alpha") });
		assert.deepEqual(byName.beta, { name: "beta", destination: null, backend: null, current: false, default: false, same_as: [], dir: profile("beta") });
		assert.deepEqual(byName.root, { name: "root", destination: "local", backend: "lima", current: false, default: false, same_as: ["legacy"], dir: home });
		const lines = text(r).split("\n");
		assert.equal(lines[0], "NAME\tDESTINATION\tBACKEND\tNOTES\tPROFILE");
		assert.equal(lines[2], `alpha *\tyou@alpha-box\tlibvirt\tdefault\t${profile("alpha")}`);
		assert.equal(lines[4], `root\tlocal\tlima\tsame host as legacy\t${home}`);
		const info = (await c.call("tools/list")).result.tools.find((t) => t.name === "vm_info");
		assert.deepEqual(Object.keys(info.outputSchema.properties.hosts.items.properties).sort(), Object.keys(byName.alpha).sort());
		assert.match(info.inputSchema.properties.host.description, /legacy.*root profile/);
	} finally {
		for (const h of ["alpha", "beta"]) {
			writeFileSync(path.join(profile(h), "config"), "# fake controller config\n");
			rmSync(path.join(profile(h), "backend"), { force: true });
		}
		for (const f of ["config", "ssh_config", "backend", "host-registry/root"]) rmSync(path.join(home, f), { force: true });
	}
});
