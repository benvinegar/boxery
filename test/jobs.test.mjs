// Exercise the actual CLI and MCP guest protocol; no VM, SSH server or tmux installation needed.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { MAX_BYTES } from "../core/boxery-core.mjs";
import { fakeTmux } from "./fake-tmux.mjs";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "controller/boxery");
let dir, env, bin, home;
const clients = [];
const text = (r) => r.content[0].text;
const vmhome = (profile = "home") => path.join(dir, `vm-${profile}`);
const jobdir = () => path.join(vmhome(), ".boxery/jobs");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

before(() => {
	dir = mkdtempSync(path.join(tmpdir(), "boxery-jobs-"));
	bin = path.join(dir, "bin"); home = path.join(dir, "home");
	mkdirSync(bin); mkdirSync(path.join(home, "host-registry"), { recursive: true });
	for (const name of ["home", "alpha", "beta"]) {
		const profile = name === "home" ? home : path.join(home, "profiles", name);
		mkdirSync(profile, { recursive: true });
		writeFileSync(path.join(profile, "config"), "HOST='local'\n");
		writeFileSync(path.join(profile, "ssh_config"), "# test\n");
		if (name !== "home") writeFileSync(path.join(home, "host-registry", name), `${profile}\n`);
		mkdirSync(path.join(vmhome(name), "project", "dir with space"), { recursive: true });
	}
	const stub = (name, content) => {
		writeFileSync(path.join(bin, name), content); chmodSync(path.join(bin, name), 0o755);
	};
	// Do not source the test machine's login profile (which can override HOME/PATH).
	stub("bash", '#!/bin/bash\ncase $1 in -l) case ${RUNNER_STARTUP:-} in fail) exit 1 ;; hang) sleep 30 ;; esac; shift ;; -lc) shift; set -- -c "$@" ;; esac\nexec /bin/bash "$@"\n');
	stub("ssh", `#!/bin/bash
conf=''; vm=''
while [ $# -gt 1 ]; do case $1 in -F) conf=$2; shift 2 ;; -o) shift 2 ;; -T) shift ;; *.boxery) vm=$1; shift ;; *) shift ;; esac; done
[ "$vm" = fakevm.boxery ] || { echo unreachable >&2; exit 255; }
profile=$(basename "$(dirname "$conf")")
export HOME=${JSON.stringify(dir)}/vm-$profile
export HOST_TAG=$profile
cd "$HOME"
if [ -n "\${WIRE_CAPTURE:-}" ]; then
 /bin/bash -c "$1" >"$WIRE_CAPTURE"; rc=$?; cat "$WIRE_CAPTURE"; exit "$rc"
fi
exec /bin/bash -c "$1"
`);
	stub("tmux", fakeTmux());
	env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BOXERY_HOME: home, BOXERY_HOST: "", BOXERY_VM: "", HOME: path.join(dir, "local-home") };
});
after(() => {
	for (const c of clients) c.p.kill();
	for (const name of ["home", "alpha", "beta"]) {
		const d = path.join(vmhome(name), ".test-tmux");
		if (existsSync(d)) for (const f of readdirSync(d)) {
			try {
				const pid = Number(readFileSync(path.join(d, f), "utf8"));
				if (Number.isInteger(pid) && pid > 1) process.kill(-pid, "SIGKILL");
			} catch {}
		}
	}
	rmSync(dir, { recursive: true, force: true });
});
async function cli(args, overrides = {}, executable = CLI) {
	try { const r = await exec(executable, args, { env: { ...env, ...overrides }, timeout: 15_000 }); return { ...r, code: 0 }; }
	catch (e) { return { stdout: e.stdout, stderr: e.stderr, code: e.code }; }
}
async function start(args, overrides) {
	const r = await cli(["run", "--bg", "fakevm", ...args], overrides);
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout.trim(), /^job-[A-Za-z0-9]{12}$/);
	return r.stdout.trim();
}
async function wait(id, code = 0) { const r = await cli(["wait", "fakevm", id]); assert.equal(r.code, code, r.stderr); }

function client(args = ["--vm", "fakevm"], overrides = {}) {
	const p = spawn(process.execPath, [path.join(ROOT, "mcp/boxery-mcp.mjs"), ...args], { env: { ...env, ...overrides }, stdio: ["pipe", "pipe", "pipe"] });
	let buf = "", id = 0;
	const waiting = new Map();
	p.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
			waiting.get(msg.id)?.(msg.result); waiting.delete(msg.id);
		}
	});
	p.on("exit", () => { for (const reject of waiting.values()) reject({ isError: true, content: [{ text: "server exited" }] }); });
	const request = (method, params) => {
		const requestId = ++id;
		return { id: requestId, result: new Promise((resolve) => { waiting.set(requestId, resolve); p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`); }) };
	};
	const c = { p, request, tool: async (args) => (await request("tools/call", { name: "vm_jobs", arguments: args }).result), cancel: (requestId) => p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } })}\n`) };
	clients.push(c); return c;
}

test("background run preserves argv, captures both streams and publishes the real exit (including 255)", async () => {
	const args = ["a  b", "$HOME", "it's", "", "x;y", "*", "line1\nline2", "~", '$(touch injected)'];
	const id = await start(["printf", "[%s]", ...args]);
	await wait(id);
	assert.equal((await cli(["logs", "fakevm", id])).stdout, args.map((s) => `[${s}]`).join(""));
	assert.equal(existsSync(path.join(vmhome(), "project/injected")), false);
	for (const code of [7, 255]) {
		const failed = await start(["bash", "-c", `echo stdout; echo stderr >&2; exit ${code}`]);
		await wait(failed, code);
		assert.equal((await cli(["logs", "fakevm", failed])).stdout, "stdout\nstderr\n");
	}
	const missing = await start(["no-such-command"]); await wait(missing, 127);
});

test("background commands preserve shell builtins as well as exact argv", async () => {
	for (const args of [["exit", "9"], ["printf", "-v", "saved", "%s", "a b"]]) {
		const foreground = await cli(["run", "fakevm", ...args]);
		const id = await start(args);
		await wait(id, foreground.code);
		assert.equal((await cli(["logs", "fakevm", id])).stdout, foreground.stdout);
	}
	const signalled = await start(["bash", "-c", "kill -TERM $$"]);
	await wait(signalled, 143);
});

async function until(check, message, timeout = 4000) {
	const end = Date.now() + timeout;
	while (!check()) {
		assert.ok(Date.now() < end, message);
		await delay(20);
	}
}

test("runner publishes discoverable metadata after launcher disconnects before tmux returns", async () => {
	const launched = path.join(dir, "launched");
	const release = path.join(dir, "disconnect-release");
	const p = spawn(CLI, ["run", "--bg", "fakevm", "bash", "-c", `echo survived; while [ ! -f '${release}' ]; do sleep 0.05; done; exit 19`], {
		env: { ...env, TMUX_LAUNCHED: launched, TMUX_RUNNER_DELAY: "0.4" }, detached: true, stdio: "ignore",
	});
	const closed = new Promise((resolve) => p.on("close", resolve));
	let id;
	try {
		await until(() => existsSync(launched), "tmux did not launch");
		id = readFileSync(launched, "utf8");
		assert.equal(existsSync(path.join(jobdir(), `${id}.meta`)), false, "runner is not ready yet");
		process.kill(-p.pid, "SIGHUP");
		await closed;
		await until(() => existsSync(path.join(jobdir(), `${id}.meta`)), "detached runner did not publish metadata");
		const jobs = JSON.parse((await cli(["jobs", "fakevm", "--json"])).stdout);
		assert.equal(jobs.find((j) => j.id === id)?.state, "running");
		assert.equal((await cli(["logs", "fakevm", id])).stdout, "survived\n");
	} finally {
		try { process.kill(-p.pid, "SIGKILL"); } catch {}
		writeFileSync(release, "");
	}
	await wait(id, 19);
});

test("failed or stuck login setup fails startup and cleans its reservation/session", async () => {
	for (const mode of ["fail", "hang"]) {
		const beforeFiles = readdirSync(jobdir()).sort();
		const r = await cli(["run", "--bg", "fakevm", "true"], { RUNNER_STARTUP: mode });
		assert.equal(r.code, 1, `${mode}: ${r.stderr}`);
		assert.match(r.stderr, /runner did not become ready/);
		assert.deepEqual(readdirSync(jobdir()).sort(), beforeFiles);
	}
});

test("background cwd matches run; NAME --bg also works; missing cwd is a recorded failure", async () => {
	for (const [cwd, expected] of [["dir with space", "project/dir with space"], ["~", ""], ["~/project", "project"], [vmhome(), ""]]) {
		const r = await cli(["run", "fakevm", "--bg", "--cwd", cwd, "pwd"]);
		assert.equal(r.code, 0, r.stderr); const id = r.stdout.trim(); await wait(id);
		assert.equal((await cli(["logs", "fakevm", id])).stdout.trim(), path.join(vmhome(), expected));
	}
	const id = await start(["--cwd", "no-such-dir", "touch", "should-not-exist"]);
	assert.notEqual((await cli(["wait", "fakevm", id])).code, 0);
	assert.equal(existsSync(path.join(vmhome(), "project/should-not-exist")), false);
});

test("concurrent launches have unique IDs; jobs lists running/completed with numeric timestamps", async () => {
	const ids = await Promise.all(Array.from({ length: 4 }, () => start(["bash", "-c", "sleep 2; exit 3"])));
	assert.equal(new Set(ids).size, ids.length);
	let jobs = JSON.parse((await cli(["jobs", "fakevm", "--json"])).stdout);
	for (const id of ids) {
		const j = jobs.find((j) => j.id === id);
		assert.equal(j.state, "running"); assert.equal(j.exit_code, null); assert.equal(typeof j.started_at, "number");
	}
	await Promise.all(ids.map((id) => wait(id, 3)));
	jobs = JSON.parse((await cli(["jobs", "fakevm", "--json"])).stdout);
	assert.ok(ids.every((id) => jobs.some((j) => j.id === id && j.state === "completed" && j.exit_code === 3)));
	const fast = await Promise.all(Array.from({ length: 6 }, () => start(["true"])));
	assert.equal(new Set(fast).size, fast.length);
	await Promise.all(fast.map((id) => wait(id)));
});

test("logs tails/follows through completion, strips ANSI, and wait timeout never stops a job", async () => {
	const id = await start(["bash", "-c", "printf '\\033[31mred\\033[0m\\n\\033]8;;https://example.com\\033\\\\link\\033]8;;\\033\\\\\\n'; sleep 2; echo final"]);
	assert.equal((await cli(["wait", "fakevm", id, "--timeout", "1"])).code, 124);
	const logs = await cli(["logs", "fakevm", id, "-f", "--strip-ansi"]);
	assert.equal(logs.code, 0, logs.stderr); assert.equal(logs.stdout, "red\nlink\nfinal\n");
	assert.equal((await cli(["logs", "fakevm", id, "--lines", "1"])).stdout, "final\n");
	await wait(id);
});

test("ANSI-filtered follow delivers newline-free CR progress before the command completes", async () => {
	const release = path.join(dir, "stream-release");
	const id = await start(["bash", "-c", `sleep 0.3; printf '\\033[32mprogress 50%%\\033[0m\\r'; while [ ! -f '${release}' ]; do sleep 0.05; done; echo done`]);
	const p = spawn(CLI, ["logs", "fakevm", id, "-f", "--strip-ansi"], { env });
	let output = "", error = "";
	p.stdout.on("data", (d) => { output += d; });
	p.stderr.on("data", (d) => { error += d; });
	const closed = new Promise((resolve) => p.on("close", resolve));
	try {
		await until(() => output.includes("progress 50%\r"), "newline-free ANSI-filtered update was buffered until completion");
		assert.equal(existsSync(path.join(jobdir(), `${id}.exit`)), false);
		assert.equal(output, "progress 50%\r");
	} finally { writeFileSync(release, ""); }
	assert.equal(await closed, 0, error);
	assert.equal(output, "progress 50%\rdone\n");
	await wait(id);
});

test("ANSI-filtered follow retains escape state across writes without buffering OSC content", async () => {
	const gates = Array.from({ length: 4 }, (_, i) => path.join(dir, `escape-release-${i}`));
	const gate = (i) => `while [ ! -f '${gates[i]}' ]; do sleep 0.05; done`;
	const id = await start(["bash", "-c", `printf 'ready\\r\\033'; ${gate(0)};
		printf '[32mprogress\\r\\033[0m\\033]8;;'; head -c 65536 /dev/zero | tr '\\000' x;
		${gate(1)}; printf '\\033'; sleep 0.4; printf '\\\\link\\033]8;;\\007';
		${gate(2)}; printf '\\033'; sleep 0.4; printf 'Mend\\r'; ${gate(3)}; echo done`]);
	const p = spawn(CLI, ["logs", "fakevm", id, "-f", "--strip-ansi"], { env });
	let output = "", error = "";
	p.stdout.on("data", (d) => { output += d; });
	p.stderr.on("data", (d) => { error += d; });
	const closed = new Promise((resolve) => p.on("close", resolve));
	try {
		await until(() => output === "ready\r", "prefix before split CSI was not delivered");
		writeFileSync(gates[0], "");
		await until(() => output.includes("progress\r"), "split CSI did not finish");
		await delay(400); // Let the unterminated OSC cross multiple filter reads.
		assert.equal(output, "ready\rprogress\r");
		writeFileSync(gates[1], "");
		await until(() => output.endsWith("link"), "split OSC terminator did not finish");
		writeFileSync(gates[2], "");
		await until(() => output.endsWith("end\r"), "split two-byte escape did not finish");
		assert.equal(output, "ready\rprogress\rlinkend\r");
		assert.equal(existsSync(path.join(jobdir(), `${id}.exit`)), false);
	} finally { for (const f of gates) writeFileSync(f, ""); }
	assert.equal(await closed, 0, error);
	assert.equal(output, "ready\rprogress\rlinkend\rdone\n");
	await wait(id);
});

test("invalid requests, launch failure and lost jobs fail safely", async () => {
	for (const args of [["run", "--bg", "fakevm"], ["jobs", "bad;vm"], ["logs", "fakevm", "../escape"], ["wait", "fakevm", "job-AAAAAAAAAAAA"], ["jobs", "fakevm", "--bogus"]]) {
		assert.notEqual((await cli(args)).code, 0, args.join(" "));
	}
	const beforeFiles = readdirSync(jobdir()).sort();
	assert.notEqual((await cli(["run", "--bg", "fakevm", "true"], { TMUX_FAIL: "1" })).code, 0);
	assert.deepEqual(readdirSync(jobdir()).sort(), beforeFiles);
	const id = await start(["sleep", "20"]);
	const session = path.join(vmhome(), ".test-tmux", id);
	process.kill(-Number(readFileSync(session, "utf8")), "SIGKILL"); rmSync(session, { force: true });
	const r = await cli(["wait", "fakevm", id]); assert.notEqual(r.code, 0); assert.match(r.stderr, /lost/);
	assert.ok(JSON.parse((await cli(["jobs", "fakevm", "--json"])).stdout).some((j) => j.id === id && j.state === "lost" && j.exit_code === null));
});

test("MCP vm_jobs starts, polls, logs and waits; validation and cancellation leave jobs intact", async () => {
	const c = client();
	const schema = (await c.request("tools/list", {}).result).tools.find((t) => t.name === "vm_jobs");
	assert.ok(schema.inputSchema.properties.host); assert.ok(schema.inputSchema.properties.vm);
	const started = await c.tool({ action: "start", command: "echo begin; sleep 3; echo end; exit 9" });
	assert.equal(started.isError, false, text(started)); const id = JSON.parse(text(started)).id;
	const timed = JSON.parse(text(await c.tool({ action: "wait", job: id, timeout: 1 })));
	assert.equal(timed.timed_out, true); assert.equal(timed.state, "running");
	const pending = c.request("tools/call", { name: "vm_jobs", arguments: { action: "wait", job: id } });
	await delay(100); c.cancel(pending.id);
	assert.match(text(await pending.result), /aborted/);
	const done = await c.tool({ action: "wait", job: id });
	assert.equal(done.isError, true); assert.equal(JSON.parse(text(done)).exit_code, 9);
	assert.equal(text(await c.tool({ action: "logs", job: id })), "begin\nend\n");
	assert.ok(JSON.parse(text(await c.tool({ action: "list" }))).some((j) => j.id === id));
	for (const args of [{ action: "bogus" }, { action: "start" }, { action: "logs", job: "../bad" }, { action: "wait", job: id, timeout: 0 }, { action: "logs", job: id, lines: -1 }]) assert.equal((await c.tool(args)).isError, true);
	const noVm = client([]); assert.match(text(await noVm.tool({ action: "list" })), /No VM/);
});

test("MCP logs bound long lines, unknown jobs report errors, and npm bin symlinks find the helper", async () => {
	const linked = path.join(bin, "boxery-linked");
	symlinkSync(CLI, linked);
	const r = await cli(["run", "--bg", "fakevm", "bash", "-c", 'head -c 200000 /dev/zero | tr "\\\\0" x; echo END'], {}, linked);
	assert.equal(r.code, 0, r.stderr); const id = r.stdout.trim(); await wait(id);
	const c = client(); const logs = await c.tool({ action: "logs", job: id });
	assert.equal(logs.isError, false, text(logs));
	assert.ok(Buffer.byteLength(text(logs)) < 52_000); assert.match(text(logs), /truncated/);
	assert.match(text(logs), /x+END\n$/);
	assert.equal((await cli(["logs", "fakevm", id])).stdout, `${"x".repeat(200000)}END\n`, "CLI logs stay byte-unrestricted by default");
	assert.match(text(await c.tool({ action: "logs", job: "job-AAAAAAAAAAAA" })), /unknown job/);
});

test("MCP bounds guest wire output before line/ANSI processing and keeps huge-line suffixes", async () => {
	const id = await start(["true"]); await wait(id);
	// Build a 64 MiB newline-free log without asking a command/transport to buffer it.
	const log = path.join(jobdir(), `${id}.log`);
	const { openSync, writeSync, closeSync } = await import("node:fs");
	const fd = openSync(log, "w");
	const block = Buffer.alloc(1024 * 1024, "x");
	try { for (let i = 0; i < 64; i++) writeSync(fd, block); writeSync(fd, "END"); }
	finally { closeSync(fd); }
	const wire = path.join(dir, "wire-output");
	const c = client(undefined, { WIRE_CAPTURE: wire });
	for (const stripAnsi of [false, true]) {
		const r = await c.tool({ action: "logs", job: id, stripAnsi });
		assert.equal(r.isError, false, text(r));
		const transmitted = readFileSync(wire);
		assert.ok(transmitted.length <= 50 * 1024, `${transmitted.length} bytes crossed the guest boundary`);
		assert.match(transmitted.toString(), /x+END$/);
		assert.match(text(r), /^\[output truncated\]\nx+END$/);
	}
	assert.equal((await cli(["logs", "fakevm", id, "--bytes", "8"])).stdout, "xxxxxEND");
	for (const option of [[], ["0"], ["-1"], ["abc"]]) {
		assert.notEqual((await cli(["logs", "fakevm", id, "--bytes", ...option])).code, 0);
	}
	// An incomplete leading UTF-8 code point is dropped, not replaced or expanded.
	writeFileSync(log, `${"€".repeat(18000)}END`);
	const utf = await c.tool({ action: "logs", job: id });
	assert.match(text(utf), /€+END$/); assert.ok(!text(utf).includes("�"));
	assert.ok(Buffer.byteLength(text(utf).replace(/^\[output truncated\]\n/, "")) <= MAX_BYTES);
	writeFileSync(log, "one\ntwo\nthree\n");
	const short = await c.tool({ action: "logs", job: id, lines: 1 });
	assert.equal(text(short), "three\n");
	assert.equal(text(await c.tool({ action: "logs", job: id, lines: 0 })), "(no output)");
});

test("MCP caps the decoded UTF-8 body even when invalid bytes expand", async () => {
	const id = await start(["true"]); await wait(id);
	const log = path.join(jobdir(), `${id}.log`);
	const c = client();
	for (const stripAnsi of [false, true]) {
		for (const size of [64 * 1024, 20 * 1024]) {
			writeFileSync(log, Buffer.concat([Buffer.from([0x80, 0xbf]), Buffer.alloc(size, 0xff), Buffer.from("END")]));
			const r = await c.tool({ action: "logs", job: id, stripAnsi });
			assert.equal(r.isError, false, text(r));
			assert.match(text(r), /^\[output truncated\]\n�+END$/);
			const body = text(r).replace(/^\[output truncated\]\n/, "");
			assert.ok(Buffer.byteLength(body) <= MAX_BYTES, `${Buffer.byteLength(body)} decoded bytes`);
			assert.ok(Buffer.byteLength(body) >= MAX_BYTES - 2, "keep the useful suffix, not whole lines");
		}
		writeFileSync(log, Buffer.concat([Buffer.from([0x80, 0xbf, 0xff]), Buffer.from("prefix END")]));
		assert.equal(text(await c.tool({ action: "logs", job: id, stripAnsi })), "�prefix END");
	}
});

test("real tmux launches the runner and records completion before its session disappears", async (t) => {
	let tmux;
	try { tmux = (await exec("sh", ["-c", "command -v tmux"])).stdout.trim(); }
	catch { t.skip("tmux not installed; detached protocol is covered by the stub tests"); return; }
	const realbin = path.join(dir, "real-bin"); mkdirSync(realbin);
	const socket = path.join(dir, "tmux.sock");
	const wrapper = path.join(realbin, "tmux");
	writeFileSync(wrapper, `#!/bin/bash\nexec ${JSON.stringify(tmux)} -S ${JSON.stringify(socket)} -f /dev/null "$@"\n`); chmodSync(wrapper, 0o755);
	const overrides = { PATH: `${realbin}:${env.PATH}`, TMUX: "" };
	try {
		const id = await start(["bash", "-c", "echo real-tmux; sleep 1; exit 17"], overrides);
		const r = await cli(["wait", "fakevm", id], overrides);
		assert.equal(r.code, 17, `${r.stderr}\n${readFileSync(path.join(jobdir(), `${id}.log`), "utf8")}`);
		assert.equal((await cli(["logs", "fakevm", id, "-f"], overrides)).stdout, "real-tmux\n");
		assert.ok(JSON.parse((await cli(["jobs", "fakevm", "--json"], overrides)).stdout).some((j) => j.id === id && j.exit_code === 17));
		for (let i = 0; i < 3; i++) {
			const fast = await start(["true"], overrides);
			assert.equal((await cli(["wait", "fakevm", fast], overrides)).code, 0);
		}
	} finally { await exec(tmux, ["-S", socket, "kill-server"]).catch(() => {}); }
});

test("real tmux termination loses the runner without publishing successful completion", async (t) => {
	let tmux;
	try { tmux = (await exec("sh", ["-c", "command -v tmux"])).stdout.trim(); }
	catch { t.skip("tmux not installed; real session termination requires tmux"); return; }
	const realbin = path.join(dir, "signal-bin"); mkdirSync(realbin);
	const socket = path.join(dir, "signal-tmux.sock");
	const wrapper = path.join(realbin, "tmux");
	writeFileSync(wrapper, `#!/bin/bash\nexec ${JSON.stringify(tmux)} -S ${JSON.stringify(socket)} -f /dev/null "$@"\n`); chmodSync(wrapper, 0o755);
	const overrides = { PATH: `${realbin}:${env.PATH}`, TMUX: "" };
	try {
		const id = await start(["bash", "-c", "echo begun; sleep 30; echo done; exit 17"], overrides);
		const log = path.join(jobdir(), `${id}.log`);
		await until(() => readFileSync(log, "utf8").includes("begun\n"), "real command never started");
		await exec(tmux, ["-S", socket, "kill-session", "-t", `=${id}`]);
		const r = await cli(["wait", "fakevm", id], overrides);
		assert.notEqual(r.code, 0, r.stderr);
		assert.match(r.stderr, /lost/);
		assert.equal((await cli(["logs", "fakevm", id], overrides)).stdout, "begun\n");
		assert.equal(existsSync(path.join(jobdir(), `${id}.exit`)), false);
		const jobs = JSON.parse((await cli(["jobs", "fakevm", "--json"], overrides)).stdout);
		assert.ok(jobs.some((j) => j.id === id && j.state === "lost" && j.exit_code === null));
		// A signal to only the command is a real completed failure, not a lost runner.
		const child = await start(["bash", "-c", "kill -TERM $$"], overrides);
		assert.equal((await cli(["wait", "fakevm", child], overrides)).code, 143);
		const record = JSON.parse((await cli(["jobs", "fakevm", "--json"], overrides)).stdout).find((j) => j.id === child);
		assert.equal(record.state, "completed"); assert.equal(record.exit_code, 143);
	} finally { await exec(tmux, ["-S", socket, "kill-server"]).catch(() => {}); }
});

test("MCP jobs stay on the selected host and explicit host cannot inherit another host's VM", async () => {
	const c = client(["--host", "alpha", "--vm", "fakevm"]);
	assert.equal((await c.tool({ host: "beta", action: "list" })).isError, true);
	for (const host of ["alpha", "beta"]) {
		const r = await c.tool({ host, vm: "fakevm", action: "start", command: 'echo "$HOST_TAG"' });
		assert.equal(r.isError, false, text(r)); const id = JSON.parse(text(r)).id;
		assert.equal((await c.tool({ host, vm: "fakevm", action: "wait", job: id })).isError, false);
		assert.equal(text(await c.tool({ host, vm: "fakevm", action: "logs", job: id })), `${host}\n`);
	}
});
