// Background jobs through the real CLI and MCP server, with core/boxery-jobs.ts run exactly as in a VM
// (piped to node with type stripping). No VM, ssh server or tmux needed: stubs stand in for them.
// Needs Node >= 22.18 (what VM images ship); skipped on older Node.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { MAX_BYTES } from "../core/boxery-core.mjs";
import { fakeTmux } from "./fake-tmux.mjs";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "controller/boxery");
const HELPER = readFileSync(path.join(ROOT, "core/boxery-jobs.ts"));
const NODE_TS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module-typescript"];
const skip = spawnSync(process.execPath, [...NODE_TS, "-e", ""]).status === 0 ? false : "needs Node >= 22.18 (type stripping)";
const ID = /^job-\d{8}-\d{6}-[0-9a-f]{6}$/;
let dir, env, bin, home;
const clients = [];
const text = (r) => r.content[0].text;
const vmhome = (profile = "home") => path.join(dir, `vm-${profile}`);
const jobdir = () => path.join(vmhome(), ".boxery/jobs");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, message, timeout = 5000) {
	const end = Date.now() + timeout;
	while (!check()) {
		assert.ok(Date.now() < end, message);
		await delay(20);
	}
}

before(() => {
	if (skip) return;
	dir = mkdtempSync(path.join(tmpdir(), "boxery-jobs-"));
	bin = path.join(dir, "bin");
	home = path.join(dir, "home");
	mkdirSync(bin);
	mkdirSync(path.join(home, "host-registry"), { recursive: true });
	writeFileSync(path.join(home, "default-host"), "home\n");
	for (const name of ["home", "alpha", "beta"]) {
		const profile = name === "home" ? home : path.join(home, "profiles", name);
		mkdirSync(profile, { recursive: true });
		writeFileSync(path.join(profile, "config"), "HOST='local'\n");
		writeFileSync(path.join(profile, "ssh_config"), "# test\n");
		writeFileSync(path.join(home, "host-registry", name), `${profile}\n`);
		mkdirSync(path.join(vmhome(name), "project", "dir with space"), { recursive: true });
	}
	const stub = (name, content) => {
		writeFileSync(path.join(bin, name), content);
		chmodSync(path.join(bin, name), 0o755);
	};
	// Login shells must not read the test machine's profile; RUNNER_STARTUP fakes a broken or slow one.
	stub("bash", '#!/bin/bash\nif [ "${1:-}" = -l ]; then case ${RUNNER_STARTUP:-} in fail) exit 1 ;; hang) sleep 30 ;; esac; shift; fi\nexec /bin/bash "$@"\n');
	// ssh: run the remote command in the fake VM of the selected profile. Like sshd on a shared
	// (ControlMaster) connection, a separate process ("sshd") runs it: the client dying only closes pipes.
	stub("ssh", `#!/bin/bash
client=$$; own=''; case " $* " in *ControlPath=none*) own=1 ;; esac
conf=''; vm=''
while [ $# -gt 1 ]; do case $1 in -F) conf=$2; shift 2 ;; -o) shift 2 ;; -T) shift ;; *.boxery) vm=$1; shift ;; *) shift ;; esac; done
[ "$vm" = fakevm.boxery ] || { echo unreachable >&2; exit 255; }
profile=$(basename "$(dirname "$conf")")
export HOME=${JSON.stringify(dir)}/vm-$profile HOST_TAG=$profile
cd "$HOME"
if [ -n "\${WIRE_CAPTURE:-}" ]; then /bin/bash -c "$1" >"$WIRE_CAPTURE"; rc=$?; cat "$WIRE_CAPTURE"; exit "$rc"; fi
exec 3<&0
# The remote side runs in a session of its own ("sshd"). On a shared (ControlMaster) connection it
# outlives this client: killing the client, even its whole process group, only closes the pipes. On a
# dedicated connection (ControlPath=none) sshd goes away with the client, leaving the command orphaned.
# sshd learns the client is gone from a pipe only the client holds open (EOF when it dies), not by
# polling its pid: deterministic, whatever reaps the client.
if [ -z "$own" ]; then
	setsid /bin/bash -c '/bin/bash -c "$1" <&3 3<&- & wait $!' sshd "$1" <&3 &
	wait $!; exit $?
fi
fifo=$(mktemp -u); mkfifo "$fifo"
setsid /bin/bash -c '
/bin/bash -c "$1" <&3 3<&- 5<&- & c=$!
# A blocking read returns only at EOF (the client holds the only writer and never writes): no timeouts,
# whose exit status differs between bash 3.2 and 5. The watcher then ends the session like sshd would.
( read -r -u 5 _; kill -0 "$c" 2>/dev/null && kill -TERM $$ ) 5<&5 &
trap "exit 255" TERM
wait "$c"' sshd "$1" <&3 5<"$fifo" &
s=$!
exec 5>"$fifo"; rm -f "$fifo"
wait $s
`);
	stub("tmux", fakeTmux()); // shared fake: test/fake-tmux.mjs
	// macOS has no setsid: emulate it with perl (new session, then exec).
	if (spawnSync("sh", ["-c", "command -v setsid"]).status !== 0) stub("setsid", "#!/bin/bash\nexec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die' -- \"$@\"\n");
	env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BOXERY_HOME: home, BOXERY_VM: "", HOME: path.join(dir, "local-home") };
});

after(async () => {
	if (skip) return;
	for (const c of clients) c.p.kill();
	for (const name of ["home", "alpha", "beta"]) {
		const jd = path.join(vmhome(name), ".boxery/jobs");
		for (const d of [path.join(vmhome(name), ".test-tmux"), jd]) {
			if (!existsSync(d)) continue;
			for (const f of readdirSync(d)) {
				if (d === jd && !/\.(pid|runner)$/.test(f)) continue;
				try {
					const pid = Number(readFileSync(path.join(d, f), "utf8").trim().split(" ")[0]);
					if (Number.isInteger(pid) && pid > 1) process.kill(-pid, "SIGKILL");
				} catch {}
			}
		}
	}
	await delay(300);
	rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function cli(args, overrides = {}, executable = CLI) {
	try {
		const r = await exec(executable, args, { env: { ...env, ...overrides }, timeout: 30_000 });
		return { ...r, code: 0 };
	} catch (e) {
		return { stdout: e.stdout, stderr: e.stderr, code: e.code };
	}
}
async function start(args, overrides) {
	const r = await cli(["run", "--bg", "fakevm", ...args], overrides);
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout.trim(), ID);
	return r.stdout.trim();
}
async function wait(id, code = 0, overrides) {
	const r = await cli(["wait", "fakevm", id], overrides);
	assert.equal(r.code, code, r.stderr);
	return r;
}
const jobs = async (overrides) => JSON.parse((await cli(["jobs", "fakevm", "--json"], overrides)).stdout);
const pgid = (id) => Number(readFileSync(path.join(jobdir(), `${id}.pid`), "utf8").trim().split(" ")[0]); // "PID STARTTIME"
const groupAlive = (g) => {
	try {
		process.kill(-g, 0);
		return true;
	} catch {
		return false;
	}
};
const helpersRunning = (action, id) =>
	spawnSync("sh", ["-c", `ps -eo args | grep "^[^ ]*node .*module-typescript - ${action} ${id}" | grep -vc grep || true`], { encoding: "utf8" }).stdout.trim();

function client(args = ["--vm", "fakevm"], overrides = {}) {
	const p = spawn(process.execPath, [path.join(ROOT, "mcp/boxery-mcp.mjs"), ...args], { env: { ...env, ...overrides }, stdio: ["pipe", "pipe", "pipe"] });
	let buf = "";
	let id = 0;
	const waiting = new Map();
	p.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const msg = JSON.parse(buf.slice(0, i));
			buf = buf.slice(i + 1);
			waiting.get(msg.id)?.(msg.result);
			waiting.delete(msg.id);
		}
	});
	p.on("exit", () => {
		for (const resolve of waiting.values()) resolve({ isError: true, content: [{ text: "server exited" }] });
	});
	const request = (method, params) => {
		const requestId = ++id;
		return {
			id: requestId,
			result: new Promise((resolve) => {
				waiting.set(requestId, resolve);
				p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
			}),
		};
	};
	const c = {
		p,
		request,
		tool: async (a) => await request("tools/call", { name: "vm_jobs", arguments: a }).result,
		cancel: (requestId) => p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } })}\n`),
	};
	// Like a real client (structuredContent is only for protocol 2025-06-18 and later).
	request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jobs-test", version: "0" } });
	clients.push(c);
	return c;
}
const record = (r) => JSON.parse(text(r).split("\n")[0]);

describe("background jobs", { skip }, () => {
	// ------------------------------------------------------------ CLI: starting and exit codes

	test("run --bg preserves argv, captures both streams and returns the real exit code (incl. 255)", async () => {
		const args = ["a  b", "$HOME", "it's", "", "x;y", "*", "line1\nline2", "~", "$(touch injected)"];
		const id = await start(["printf", "[%s]", ...args]);
		await wait(id);
		assert.equal((await cli(["logs", "fakevm", id])).stdout, args.map((s) => `[${s}]`).join(""));
		assert.equal(existsSync(path.join(vmhome(), "project/injected")), false);
		for (const code of [7, 255]) {
			const failed = await start(["bash", "-c", `echo stdout; echo stderr >&2; false | tee /dev/null; exit ${code}`]);
			const r = await wait(failed, code);
			assert.doesNotMatch(r.stderr, /reconnect/, "255 from the job is not an ssh failure");
			assert.equal((await cli(["logs", "fakevm", failed])).stdout, "stdout\nstderr\n");
		}
		await wait(await start(["no-such-command"]), 127);
	});

	test("builtins behave as in foreground run; a command starting with - is a command", async () => {
		for (const args of [["exit", "9"], ["printf", "-v", "saved", "%s", "a b"]]) {
			const foreground = await cli(["run", "fakevm", ...args]);
			const id = await start(args);
			await wait(id, foreground.code);
			assert.equal((await cli(["logs", "fakevm", id])).stdout, foreground.stdout);
		}
		await wait(await start(["bash", "-c", "kill -TERM $$"]), 143);
		await wait(await start(["--", "-x"]), 127);
	});

	test("--cwd matches run; NAME --bg also works; a missing cwd is a recorded failure", async () => {
		for (const [cwd, expected] of [["dir with space", "project/dir with space"], ["~", ""], ["~/project", "project"], [vmhome(), ""]]) {
			const r = await cli(["run", "fakevm", "--bg", "--cwd", cwd, "pwd"]);
			assert.equal(r.code, 0, r.stderr);
			const id = r.stdout.trim();
			await wait(id);
			assert.equal((await cli(["logs", "fakevm", id])).stdout.trim(), path.join(vmhome(), expected));
		}
		const id = await start(["--cwd", "no-such-dir", "touch", "should-not-exist"]);
		assert.notEqual((await cli(["wait", "fakevm", id])).code, 0);
		assert.equal(existsSync(path.join(vmhome(), "project/should-not-exist")), false);
	});

	test("a tmux server with a different HOME still runs the job in the right place", async () => {
		const id = await start(["pwd"], { TMUX_SERVER_HOME: path.join(dir, "elsewhere") });
		await wait(id);
		assert.equal((await cli(["logs", "fakevm", id])).stdout, `${path.join(vmhome(), "project")}\n`);
	});

	test("jobs run in a login shell without the ssh agent, and their files are private", async () => {
		const id = await start(["bash", "-c", 'shopt -q login_shell; echo "login=$? agent=${SSH_AUTH_SOCK:-none} umask=$(umask)"'], { SSH_AUTH_SOCK: "/tmp/agent.sock" });
		await wait(id);
		assert.match((await cli(["logs", "fakevm", id])).stdout, /agent=none umask=0022/);
		const mode = (p) => spawnSync("stat", ["-c", "%a", p]).stdout?.toString().trim() || spawnSync("stat", ["-f", "%Lp", p]).stdout.toString().trim();
		assert.equal(mode(jobdir()), "700");
		for (const ext of ["log", "json", "argv", "exit"]) assert.equal(mode(path.join(jobdir(), `${id}.${ext}`)), "600", ext);
	});

	test("the launcher can disconnect before tmux returns; the job still starts and is listed", async () => {
		const launched = path.join(dir, "launched");
		const release = path.join(dir, "disconnect-release");
		const p = spawn(CLI, ["run", "--bg", "fakevm", "bash", "-c", `echo survived; while [ ! -f '${release}' ]; do sleep 0.05; done; exit 19`], {
			env: { ...env, TMUX_LAUNCHED: launched, TMUX_RUNNER_DELAY: "0.4" },
			detached: true,
			stdio: "ignore",
		});
		const closed = new Promise((resolve) => p.on("close", resolve));
		let id;
		try {
			await until(() => existsSync(launched), "tmux did not launch");
			id = readFileSync(launched, "utf8");
			process.kill(-/** @type {number} */ (p.pid), "SIGHUP");
			await closed;
			await until(() => existsSync(path.join(jobdir(), `${id}.pid`)), "the detached runner did not start the command");
			assert.equal((await jobs()).find((j) => j.id === id)?.state, "running");
			await until(() => readFileSync(path.join(jobdir(), `${id}.log`), "utf8") === "survived\n", "no output");
		} finally {
			try {
				process.kill(-/** @type {number} */ (p.pid), "SIGKILL");
			} catch {}
			writeFileSync(release, "");
		}
		await wait(id, 19);
	});

	test("a failed or stuck login shell fails startup, cleans up, and never runs the command later", async () => {
		for (const mode of ["fail", "hang"]) {
			const beforeFiles = readdirSync(jobdir()).sort();
			const marker = path.join(dir, `late-${mode}`);
			const r = await cli(["run", "--bg", "fakevm", "touch", marker], { RUNNER_STARTUP: mode });
			assert.equal(r.code, 1, `${mode}: ${r.stderr}`);
			assert.match(r.stderr, /runner did not become ready.*nothing is running/);
			assert.deepEqual(readdirSync(jobdir()).sort(), beforeFiles);
			await delay(mode === "hang" ? 500 : 0);
			assert.equal(existsSync(marker), false);
		}
		const beforeFiles = readdirSync(jobdir()).sort();
		assert.notEqual((await cli(["run", "--bg", "fakevm", "true"], { TMUX_FAIL: "1" })).code, 0);
		assert.deepEqual(readdirSync(jobdir()).sort(), beforeFiles);
	});

	test("concurrent launches have unique IDs; jobs lists running and finished jobs", async () => {
		// Held open by a gate file rather than a sleep, so a loaded machine can't end them early.
		const gate = path.join(dir, "concurrent-release");
		const cmd = `while [ ! -f '${gate}' ]; do sleep 0.05; done; exit 3`;
		const ids = await Promise.all(Array.from({ length: 4 }, () => start(["bash", "-c", cmd])));
		assert.equal(new Set(ids).size, ids.length);
		let list = await jobs();
		for (const id of ids) {
			const j = list.find((x) => x.id === id);
			assert.deepEqual([j.state, j.exit_code, j.ended_at, typeof j.started_at], ["running", null, null, "number"]);
			assert.deepEqual(j.argv, ["bash", "-c", cmd]);
			assert.equal(j.command, `bash -c '${cmd.replace(/'/g, "'\\''")}'`);
		}
		writeFileSync(gate, "");
		await Promise.all(ids.map((id) => wait(id, 3)));
		list = await jobs();
		assert.ok(ids.every((id) => list.some((j) => j.id === id && j.state === "exited" && j.exit_code === 3 && j.ended_at >= j.started_at)));
		const keys = ["id", "state", "command", "argv", "cwd", "started_at", "ended_at", "exit_code", "killed", "leftover", "log"];
		for (const j of list) assert.deepEqual(Object.keys(j), keys);
		const t = list.map((j) => j.started_at);
		assert.deepEqual(t, [...t].sort((a, b) => a - b), "oldest first");
		assert.match((await cli(["jobs", "fakevm"])).stdout, /^JOB +STATE +EXIT +STARTED +TOOK +COMMAND\n/);
		const esc = await start(["printf", "\x1b]0;pwned\x07"]);
		await wait(esc);
		assert.ok(!(await cli(["jobs", "fakevm"])).stdout.includes("\x1b"), "no terminal escapes from a command in the table");
		const fast = await Promise.all(Array.from({ length: 6 }, () => start(["true"])));
		assert.equal(new Set(fast).size, fast.length);
		await Promise.all(fast.map((id) => wait(id)));
	});

	// ------------------------------------------------------------ CLI: logs

	test("logs tails and follows through completion, strips ANSI; wait --timeout never stops a job", async () => {
		const gate = path.join(dir, "tail-release");
		const id = await start(["bash", "-c", `printf '\\033[31mred\\033[0m\\n\\033]8;;https://example.com\\033\\\\link\\033]8;;\\033\\\\\\n'; while [ ! -f '${gate}' ]; do sleep 0.05; done; echo final`]);
		const w = await cli(["wait", "fakevm", id, "--timeout", "1"]);
		assert.equal(w.code, 124);
		assert.match(w.stderr, /still running/);
		const follow = cli(["logs", "fakevm", id, "-f", "--strip-ansi"]);
		await delay(300);
		writeFileSync(gate, "");
		const logs = await follow;
		assert.equal(logs.code, 0, logs.stderr);
		assert.equal(logs.stdout, "red\nlink\nfinal\n");
		assert.equal((await cli(["logs", "fakevm", id, "--lines", "1"])).stdout, "final\n");
		await wait(id);
	});

	test("--strip-ansi --follow passes on newline-free progress at once, keeping escape state across reads", async () => {
		const gates = Array.from({ length: 4 }, (_, i) => path.join(dir, `escape-release-${i}`));
		const gate = (i) => `while [ ! -f '${gates[i]}' ]; do sleep 0.05; done`;
		const id = await start([
			"bash",
			"-c",
			`printf 'ready\\r\\033'; ${gate(0)};
			printf '[32mprogress\\r\\033[0m\\033]8;;'; head -c 65536 /dev/zero | tr '\\000' x;
			${gate(1)}; printf '\\033'; sleep 0.4; printf '\\\\link\\033]8;;\\007';
			${gate(2)}; printf '\\033'; sleep 0.4; printf 'Mend\\r'; ${gate(3)}; echo done`,
		]);
		const p = spawn(CLI, ["logs", "fakevm", id, "-f", "--strip-ansi"], { env });
		let output = "";
		let error = "";
		p.stdout.on("data", (d) => {
			output += d;
		});
		p.stderr.on("data", (d) => {
			error += d;
		});
		const closed = new Promise((resolve) => p.on("close", resolve));
		try {
			await until(() => output === "ready\r", "prefix before a split CSI was not delivered");
			writeFileSync(gates[0], "");
			await until(() => output.includes("progress\r"), "split CSI did not finish");
			await delay(400); // let the unterminated OSC cross several reads
			assert.equal(output, "ready\rprogress\r");
			writeFileSync(gates[1], "");
			await until(() => output.endsWith("link"), "split OSC terminator did not finish");
			writeFileSync(gates[2], "");
			await until(() => output.endsWith("end\r"), "split two-byte escape did not finish");
			assert.equal(output, "ready\rprogress\rlinkend\r");
		} finally {
			for (const f of gates) writeFileSync(f, "");
		}
		assert.equal(await closed, 0, error);
		assert.equal(output, "ready\rprogress\rlinkend\rdone\n");
		await wait(id);
	});

	test("logs --bytes clips before line selection; CLI logs are otherwise unbounded", async () => {
		const id = await start(["bash", "-c", 'head -c 200000 /dev/zero | tr "\\\\0" x; echo END']);
		await wait(id);
		assert.equal((await cli(["logs", "fakevm", id])).stdout, `${"x".repeat(200000)}END\n`);
		const clipped = await cli(["logs", "fakevm", id, "--bytes", "8"]);
		assert.equal(clipped.stdout, "xxxxEND\n");
		assert.match(clipped.stderr, /byte-truncated/);
		for (const option of [[], ["0"], ["-1"], ["abc"]]) assert.notEqual((await cli(["logs", "fakevm", id, "--bytes", ...option])).code, 0);
	});

	// ------------------------------------------------------------ CLI: kill, lost, prune, errors

	test("kill stops the whole process group: TERM first, KILL after the grace period, children too", async () => {
		const ready = path.join(dir, "ready1");
		const id = await start(["bash", "-c", `trap 'echo got TERM; exit 9' TERM; touch ${ready}; sleep 300 & wait`]);
		await until(() => existsSync(ready), "not ready");
		const g = pgid(id);
		const k = await cli(["kill", "fakevm", id, "--json"]);
		assert.deepEqual(((j) => [j.state, j.killed, j.exit_code])(JSON.parse(k.stdout)), ["exited", true, 9]);
		assert.match((await cli(["logs", "fakevm", id])).stdout, /got TERM/);
		await until(() => !groupAlive(g), "the background sleep survived");

		const ready2 = path.join(dir, "ready2");
		const stubborn = await start(["bash", "-c", `trap '' TERM; touch ${ready2}; sleep 300`]);
		await until(() => existsSync(ready2), "not ready");
		assert.match((await cli(["kill", "fakevm", stubborn, "--grace", "1"])).stdout, /^killed .* \(exit 137\)/);

		const ready3 = path.join(dir, "ready3");
		const child = await start(["bash", "-c", `(trap '' TERM; touch ${ready3}; exec sleep 300) & wait`]);
		await until(() => existsSync(ready3), "not ready");
		const cg = pgid(child);
		await cli(["kill", "fakevm", child, "--grace", "1"]);
		await until(() => !groupAlive(cg), "a TERM-ignoring child survived kill");
		assert.match((await cli(["kill", "fakevm", child])).stdout, /killed|already finished/);
	});

	test("processes a job leaves running are reported, kept by prune, and stopped by kill", async () => {
		const ready = path.join(dir, "leftover-ready");
		const id = await start(["bash", "-c", `sleep 300 & touch ${ready}; exit 0`]);
		await until(() => existsSync(ready), "not ready");
		await wait(id, 0);
		const g = pgid(id);
		assert.ok(groupAlive(g), "the background sleep outlived the job");
		const rec = (await jobs()).find((j) => j.id === id);
		assert.deepEqual([rec.state, rec.exit_code, rec.leftover], ["exited", 0, true]);
		assert.match((await cli(["jobs", "fakevm"])).stdout, new RegExp(`^${id} +exited\\+ `, "m"));
		const pruned = JSON.parse((await cli(["jobs", "fakevm", "--prune", "--json"])).stdout);
		assert.ok(!pruned.includes(id), "prune keeps a job whose processes still run (kill needs its files)");
		const k = await cli(["kill", "fakevm", id, "--grace", "1"]);
		assert.equal(k.code, 0, k.stderr);
		assert.match(k.stdout, /^stopped processes left running by /);
		await until(() => !groupAlive(g), "kill did not stop what the job left running");
		assert.equal((await jobs()).find((j) => j.id === id).leftover, false);
		assert.ok(JSON.parse((await cli(["jobs", "fakevm", "--prune", "--json"])).stdout).includes(id), "now prune removes it");
	});

	test("a reused pid is never taken for the job (start time recorded), so kill can't hit another process", async (t) => {
		if (!existsSync("/proc/self/stat")) return t.skip("needs /proc (start times)");
		const id = await start(["sleep", "300"]);
		const pidFile = path.join(jobdir(), `${id}.pid`);
		const [g, startTime] = readFileSync(pidFile, "utf8").trim().split(" ");
		assert.match(startTime, /^\d+$/, "the runner records the start time");
		const [w] = readFileSync(path.join(jobdir(), `${id}.runner`), "utf8").trim().split(" ");
		for (const target of [-Number(g), Number(w)]) {
			try {
				process.kill(target, "SIGKILL");
			} catch {} // may already be gone
		}
		await until(() => !groupAlive(Number(g)), "job not dead");
		// Another session leader now owns a pid we recorded (simulated by writing its pid with our start time).
		// detached: a new session, so the victim is a process-group leader (like a daemon, or another job).
		const victim = spawn("sleep", ["300"], { stdio: "ignore", detached: true });
		await until(() => existsSync(`/proc/${victim.pid}/stat`), "victim not started");
		const vpgid = /** @type {number} */ (victim.pid);
		writeFileSync(pidFile, `${vpgid} ${startTime}\n`);
		writeFileSync(path.join(jobdir(), `${id}.runner`), `${vpgid} ${startTime}\n`);
		try {
			assert.equal((await jobs()).find((j) => j.id === id).state, "lost", "a stranger's process is not the job");
			await cli(["kill", "fakevm", id, "--grace", "0"]);
			await delay(300);
			assert.ok(groupAlive(vpgid), "kill left the other process alone");
		} finally {
			try {
				process.kill(-vpgid, "SIGKILL");
			} catch {}
		}
	});

	test("arguments and --cwd that aren't UTF-8 are passed through byte for byte", async () => {
		// Node encodes spawn arguments as UTF-8, so the raw bytes are made by bash ($'\xNN').
		const dirName = Buffer.from([0x64, 0xff, 0x72]); // "d\xffr"
		let rawDir = true; // macOS (APFS) refuses names that aren't UTF-8: test the argument bytes alone there
		try {
			mkdirSync(Buffer.concat([Buffer.from(`${vmhome()}/project/`), dirName]), { recursive: true });
		} catch {
			rawDir = false;
		}
		const cwdArg = rawDir ? `--cwd $'d\\xffr'` : "";
		const r = spawnSync("bash", ["-c", `exec "$0" run --bg fakevm ${cwdArg} bash -c 'printf %s "$1" | od -An -v -tx1 | tr -d " \\n"; echo; pwd | tr -d "\\n" | od -An -v -tx1 | tr -d " \\n"; echo' x $'\\xe9t\\xe9'`, CLI], {
			env,
			encoding: "latin1",
		});
		assert.equal(r.status, 0, r.stderr);
		const id = r.stdout.trim();
		const w = await cli(["wait", "fakevm", id]);
		assert.equal(w.code, 0, `${w.stderr}\n${(await cli(["logs", "fakevm", id])).stdout}`);
		// One line of hex per value (od wraps differently across platforms, so the spaces and newlines go).
		const [arg, cwd] = (await cli(["logs", "fakevm", id])).stdout.trim().split("\n");
		assert.equal(arg, "e974e9", "argument bytes unchanged");
		if (rawDir) assert.match(cwd, /2f64ff72$/, "cwd bytes unchanged");
	});

	test("wait --timeout on an unreachable VM fails at once, not after minutes of retries", async () => {
		const t0 = Date.now();
		const r = await cli(["wait", "nosuchvm", "job-20260101-000000-aaaaaa", "--timeout", "10"]);
		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /cannot reach nosuchvm/);
		assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
	});

	test("a job outlives its tmux session; it still counts as running and can be killed", async () => {
		const id = await start(["sleep", "300"]);
		await cli(["run", "fakevm", "tmux", "kill-session", "-t", `=${id}`]);
		await delay(300);
		assert.ok(groupAlive(pgid(id)), "the command is still running");
		assert.equal((await jobs()).find((j) => j.id === id).state, "running");
		assert.equal(JSON.parse((await cli(["kill", "fakevm", id, "--grace", "1", "--json"])).stdout).exit_code, 143);
	});

	test("lost: no exit code and nothing alive (killed outside boxery, or the VM restarted)", async () => {
		const id = await start(["sleep", "300"]);
		for (const ext of ["pid", "runner"]) {
			try {
				process.kill(-Number(readFileSync(path.join(jobdir(), `${id}.${ext}`), "utf8").trim().split(" ")[0]), "SIGKILL");
			} catch {}
		}
		await until(() => !groupAlive(pgid(id)), "not dead yet");
		let r;
		for (const end = Date.now() + 5000; ; await delay(100)) {
			r = await cli(["wait", "fakevm", id]); // the waiter may still be exiting: poll until lost
			if (r.code === 125 || Date.now() > end) break;
		}
		assert.equal(r.code, 125);
		assert.match(r.stderr, /lost/);
		assert.ok((await jobs()).some((j) => j.id === id && j.state === "lost" && j.exit_code === null));
		const rebooted = await start(["sleep", "300"]);
		const meta = path.join(jobdir(), `${rebooted}.json`);
		const m = JSON.parse(readFileSync(meta, "utf8"));
		if (m.boot_id) {
			writeFileSync(meta, JSON.stringify({ ...m, boot_id: "an-earlier-boot" }));
			assert.equal((await jobs()).find((j) => j.id === rebooted).state, "lost");
		}
		// Cleanup only; the group may already be gone (macOS reaps the fake session quickly).
		try {
			process.kill(-pgid(rebooted), "SIGKILL");
		} catch {}
	});

	test("an abandoned wait or logs -f stops in the VM (no polling until the job ends)", async () => {
		const id = await start(["sleep", "60"]);
		for (const [action, args] of [["wait", []], ["logs", ["-f"]]]) {
			const p = spawn(CLI, [action, "fakevm", id, ...args], { env, stdio: "ignore", detached: true });
			await until(() => helpersRunning(action, id) === "1", `${action}: helper never started`, 10_000);
			process.kill(-/** @type {number} */ (p.pid), "SIGKILL"); // the client's whole group; the fake sshd lives on
			// Only the helper's own checks can end it now: the heartbeat (wait), or for logs -f its own
			// connection (in this fake, its sshd parent exits when the client's pipe closes).
			await until(() => helpersRunning(action, id) === "0", `${action}: helper still running in the VM`, 10_000);
		}
		assert.equal((await jobs()).find((j) => j.id === id).state, "running", "the job itself is untouched");
		await cli(["kill", "fakevm", id, "--grace", "0"]);
	});

	test("jobs --prune deletes finished jobs (all their files) and keeps running ones", async () => {
		const running = await start(["sleep", "300"]);
		const done = await start(["true"]);
		await wait(done);
		assert.match((await cli(["jobs", "fakevm", "--prune", "--older-than", "1d"])).stdout, /^removed 0 jobs/);
		const removed = JSON.parse((await cli(["jobs", "fakevm", "--prune", "--json"])).stdout);
		assert.ok(removed.includes(done) && !removed.includes(running));
		assert.ok(!readdirSync(jobdir()).some((f) => f.startsWith(done)));
		const left = (await jobs()).map((j) => j.id);
		assert.ok(left.includes(running) && !left.includes(done));
		await cli(["kill", "fakevm", running, "--grace", "0"]);
		await cli(["jobs", "fakevm", "--prune"]);
	});

	test("invalid requests fail with nothing on stdout", async () => {
		for (const args of [
			["run", "--bg", "fakevm"],
			["jobs", "bad;vm"],
			["logs", "fakevm", "../escape"],
			["wait", "fakevm", "job-nope"],
			["jobs", "fakevm", "--bogus"],
			["kill", "fakevm", "job-x;rm"],
			["wait", "fakevm", "job-nope", "--timeout", "soon"],
			["jobs", "fakevm", "--prune", "--older-than", "xd"],
		]) {
			const r = await cli(args);
			assert.notEqual(r.code, 0, args.join(" "));
			assert.equal(r.stdout, "", args.join(" "));
		}
		assert.equal((await cli(["wait", "fakevm", "job-nope"])).code, 3);
		const r = await cli(["wait", "fakevm", (await start(["true"])), "--timeout", "08"]);
		assert.equal(r.code, 0, "leading zeros are decimal");
	});

	test("the helper is found through symlinks (npm bin), with one clear error when it's missing", async () => {
		const linked = path.join(bin, "boxery-linked");
		symlinkSync(CLI, linked);
		const r = await cli(["run", "--bg", "fakevm", "true"], {}, linked);
		assert.equal(r.code, 0, r.stderr);
		const lonely = path.join(dir, "lonely-boxery");
		writeFileSync(lonely, readFileSync(CLI));
		chmodSync(lonely, 0o755);
		const missing = await cli(["wait", "fakevm", r.stdout.trim()], {}, lonely);
		assert.equal(missing.code, 1);
		assert.equal(missing.stderr.trim().split("\n").length, 1, missing.stderr);
		assert.match(missing.stderr, /profile\.sh/);
	});

	// ------------------------------------------------------------ MCP

	test("MCP vm_jobs: start, wait (timeout and done), logs, list, kill; cancellation leaves the job alone", async () => {
		const c = client();
		const schema = (await c.request("tools/list", {}).result).tools.find((t) => t.name === "vm_jobs");
		assert.ok(schema.inputSchema.properties.host && schema.inputSchema.properties.vm);
		assert.deepEqual(schema.inputSchema.properties.action.enum, ["start", "list", "logs", "wait", "kill"]);
		const gate = path.join(dir, "mcp-release");
		const command = `echo begin; while [ ! -f '${gate}' ]; do sleep 0.05; done; echo end; exit 9`;
		const started = await c.tool({ action: "start", command });
		assert.equal(started.isError, false, text(started));
		const { id } = JSON.parse(text(started));
		assert.match(id, ID);
		assert.deepEqual(started.structuredContent, JSON.parse(text(started)), "structured output matches the text");
		const timed = await c.tool({ action: "wait", job: id, timeout: 1 });
		assert.equal(timed.isError, false);
		assert.deepEqual(((r) => [r.state, r.timed_out])(record(timed)), ["running", true]);
		const pending = c.request("tools/call", { name: "vm_jobs", arguments: { action: "wait", job: id } });
		await delay(300);
		c.cancel(pending.id);
		await pending.result;
		assert.equal(record(await c.tool({ action: "wait", job: id, timeout: 0 })).state, "running", "cancelling didn't stop the job");
		writeFileSync(gate, "");
		const done = await c.tool({ action: "wait", job: id });
		assert.equal(done.isError, true, "a non-zero exit is a tool error");
		assert.equal(record(done).exit_code, 9);
		assert.deepEqual([done.structuredContent.state, done.structuredContent.exit_code, done.structuredContent.output], ["exited", 9, "begin\nend"]);
		assert.match(text(done), /--- last 20 lines ---\nbegin\nend$/);
		assert.equal(text(await c.tool({ action: "logs", job: id })), "begin\nend\n");
		const listed = await c.tool({ action: "list" });
		assert.deepEqual(listed.structuredContent.jobs, JSON.parse(text(listed)));
		const list = JSON.parse(text(listed));
		assert.ok(list.some((j) => j.id === id && j.command === `bash -c '${command.replace(/'/g, "'\\''")}'`));
		const k = JSON.parse(text(await c.tool({ action: "start", command: "sleep 300", cwd: "dir with space" })));
		assert.equal(k.cwd, path.join(vmhome(), "project/dir with space"));
		const killed = JSON.parse(text(await c.tool({ action: "kill", job: k.id, grace: 1 })));
		assert.deepEqual([killed.state, killed.killed, killed.exit_code], ["exited", true, 143]);
		for (const a of [{ action: "bogus" }, { action: "start" }, { action: "logs", job: "../bad" }, { action: "wait", job: id, timeout: -1 }, { action: "logs", job: id, lines: -1 }, { action: "kill", job: id, grace: 99 }]) {
			assert.equal((await c.tool(a)).isError, true, JSON.stringify(a));
		}
		assert.match(text(await c.tool({ action: "logs", job: "job-20260101-000000-aaaaaa" })), /unknown job/);
		assert.match(text(await client([]).tool({ action: "list" })), /No VM/);
	});

	test("MCP: a job exiting 255 is reported, not taken for an unreachable VM", async () => {
		const c = client();
		const { id } = JSON.parse(text(await c.tool({ action: "start", command: "exit 255" })));
		assert.equal(record(await c.tool({ action: "wait", job: id, timeout: 10 })).exit_code, 255);
	});

	test("MCP: cancelling a wait stops the helper in the VM within a heartbeat", async () => {
		const c = client();
		const { id } = JSON.parse(text(await c.tool({ action: "start", command: "sleep 60" })));
		const pending = c.request("tools/call", { name: "vm_jobs", arguments: { action: "wait", job: id, timeout: 600 } });
		await until(() => helpersRunning("wait", id) === "1", "the helper never started waiting", 10_000);
		c.cancel(pending.id);
		await pending.result;
		await until(() => helpersRunning("wait", id) === "0", "the helper is still polling in the VM", 10_000);
		await c.tool({ action: "kill", job: id, grace: 0 });
	});

	test("MCP logs: the VM clips raw bytes first, huge-line suffixes survive, UTF-8 stays valid", async () => {
		const id = await start(["true"]);
		await wait(id);
		const log = path.join(jobdir(), `${id}.log`);
		const fd = openSync(log, "w");
		const block = Buffer.alloc(1024 * 1024, "x");
		try {
			for (let i = 0; i < 64; i++) writeSync(fd, block);
			writeSync(fd, "END");
		} finally {
			closeSync(fd);
		}
		const wire = path.join(dir, "wire-output");
		const c = client(undefined, { WIRE_CAPTURE: wire });
		for (const stripAnsi of [false, true]) {
			const r = await c.tool({ action: "logs", job: id, stripAnsi });
			assert.equal(r.isError, false, text(r));
			assert.ok(readFileSync(wire).length <= MAX_BYTES, `${readFileSync(wire).length} bytes crossed the wire`);
			assert.match(text(r), /^\[output truncated\]\nx+END$/);
		}
		writeFileSync(log, `${"€".repeat(18000)}END`);
		const utf = await c.tool({ action: "logs", job: id });
		assert.match(text(utf), /€+END$/);
		assert.ok(!text(utf).includes("�"));
		writeFileSync(log, Buffer.concat([Buffer.from([0x80, 0xbf]), Buffer.alloc(64 * 1024, 0xff), Buffer.from("END")]));
		const bad = text(await c.tool({ action: "logs", job: id }));
		assert.ok(Buffer.byteLength(bad.replace(/^\[output truncated\]\n/, "")) <= MAX_BYTES);
		writeFileSync(log, "one\ntwo\nthree\n");
		assert.equal(text(await c.tool({ action: "logs", job: id, lines: 1 })), "three\n");
		assert.equal(text(await c.tool({ action: "logs", job: id, lines: 0 })), "(no output)");
	});

	test("MCP jobs stay on the selected host; an explicit host can't inherit another host's VM", async () => {
		const c = client(["--host", "alpha", "--vm", "fakevm"]);
		assert.equal((await c.tool({ host: "beta", action: "list" })).isError, true);
		for (const host of ["alpha", "beta"]) {
			const r = await c.tool({ host, vm: "fakevm", action: "start", command: 'echo "$HOST_TAG"' });
			assert.equal(r.isError, false, text(r));
			const { id } = JSON.parse(text(r));
			assert.equal((await c.tool({ host, vm: "fakevm", action: "wait", job: id })).isError, false);
			assert.equal(text(await c.tool({ host, vm: "fakevm", action: "logs", job: id })), `${host}\n`);
		}
	});

	// ------------------------------------------------------------ real tmux

	const realTmux = (t, name) => {
		const found = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
		if (!found) {
			t.skip("tmux not installed; the stub tests cover the protocol");
			return null;
		}
		const realbin = path.join(dir, name);
		mkdirSync(realbin);
		const socket = path.join(dir, `${name}.sock`);
		writeFileSync(path.join(realbin, "tmux"), `#!/bin/bash\nexec ${JSON.stringify(found)} -S ${JSON.stringify(socket)} -f /dev/null "$@"\n`);
		chmodSync(path.join(realbin, "tmux"), 0o755);
		return { overrides: { PATH: `${realbin}:${env.PATH}`, TMUX: "" }, stop: () => exec(found, ["-S", socket, "kill-server"]).catch(() => {}) };
	};

	test("real tmux: runs the job and records completion", async (t) => {
		const tm = realTmux(t, "real-bin");
		if (!tm) return;
		try {
			const id = await start(["bash", "-c", "echo real-tmux; sleep 1; exit 17"], tm.overrides);
			await wait(id, 17, tm.overrides);
			assert.equal((await cli(["logs", "fakevm", id, "-f"], tm.overrides)).stdout, "real-tmux\n");
			for (let i = 0; i < 3; i++) await wait(await start(["true"], tm.overrides), 0, tm.overrides);
		} finally {
			await tm.stop();
		}
	});

	test("real tmux: killing the session or the server doesn't stop the job", async (t) => {
		const tm = realTmux(t, "signal-bin");
		if (!tm) return;
		try {
			const gate = path.join(dir, "real-release");
			const id = await start(["bash", "-c", `echo begun; while [ ! -f '${gate}' ]; do sleep 0.05; done; echo done; exit 17`], tm.overrides);
			const log = path.join(jobdir(), `${id}.log`);
			await until(() => readFileSync(log, "utf8").includes("begun\n"), "the command never started");
			await tm.stop();
			assert.equal((await jobs(tm.overrides)).find((j) => j.id === id).state, "running");
			writeFileSync(gate, "");
			await wait(id, 17, tm.overrides);
			assert.equal(readFileSync(log, "utf8"), "begun\ndone\n");
		} finally {
			await tm.stop();
		}
	});
});
