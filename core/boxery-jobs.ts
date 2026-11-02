// boxery-jobs: background jobs for commands, run INSIDE a VM.
//
// Never installed: the controller and the MCP/pi core pipe this file over ssh on every call, so a VM
// always runs the caller's version. Executed by the VM's Node with built-in type stripping:
//
//   node --experimental-strip-types --input-type=module-typescript - ACTION [ARGS]
//
// Keep to erasable TypeScript (types, interfaces, `as`); no enums, namespaces or parameter properties.
// `npm run typecheck` enforces that.
//
//   start ARGV CWD RUNNER [--text]  run a command (exact argv, like `boxery run`) → job JSON (--text: the id)
//                                ARGV: base64 of NUL-terminated arguments. CWD: base64, or - for ~/project.
//                                RUNNER: base64 of core/boxery-job-runner.sh
//   list [--text]                all jobs, oldest first → JSON array (--text: a table)
//   logs ID [--lines N] [--bytes N] [--follow] [--strip-ansi]
//                                raw output (not JSON). --bytes clips each read to its last N bytes first
//                                (notice on stderr). --follow ends when the job does
//   wait ID [--timeout S] [--output N] [--exit0]
//                                job JSON + timed_out (+ output: last N lines, cleaned). Exit status: the
//                                job's code, 124 still running, 125 lost; --exit0: always 0 once answered
//   kill ID [--grace S] [--text] SIGTERM the job's process group, SIGKILL after S s → job JSON
//   prune [--older-than S] [--text]  delete jobs that ended over S s ago (default 0) → removed ids
//
// Errors go to stderr with nothing on stdout: JSON on stdout means "the helper answered". While
// `wait` blocks, it writes a newline every 2 s (see callerGone); JSON parsers skip it.
//
// Layout, in ~/.boxery/jobs (0700, files 0600):
//   ID.json    {id, argv, cwd, started_at, boot_id}         written once by start
//   ID.argv    the arguments, NUL-terminated                 read by the runner
//   ID.log     stdout + stderr (no tee, so the exit code is the command's own)
//   ID.runner  pid of the waiter (records the exit code)
//   ID.pid     pid = process group of the command            liveness + kill target
//   ID.exit    "CODE ENDED_EPOCH"                            written last, atomically: means "finished"
//   ID.killed  present if `kill` signalled it
//   runner.sh  core/boxery-job-runner.sh, as sent by the caller (replaced atomically: running jobs keep theirs)
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";

type State = "running" | "exited" | "lost";

interface Meta {
	id: string;
	argv: string[];
	cwd: string;
	started_at: number;
	boot_id: string | null;
}

interface Job {
	id: string;
	state: State;
	command: string;
	argv: string[];
	cwd: string;
	started_at: number;
	ended_at: number | null;
	exit_code: number | null;
	killed: boolean;
	/** Processes the job started are still running in its process group after it exited. */
	leftover: boolean;
	log: string;
}

const HOME = process.env.HOME ?? "/home/agent";
const JD = path.join(HOME, ".boxery", "jobs");
const VALID_ID = /^job-[a-z0-9-]{1,36}$/;
// The caller's process (sshd's session), from the remote command line: process.ppid at load time isn't
// enough, because if ssh dies while node is still starting we're already reparented by then.
const PPID = Number(process.env.BOXERY_CALLER) || process.ppid;
delete process.env.BOXERY_CALLER; // not for tmux or the jobs it starts
const TAIL_CAP = 1024 * 1024; // most bytes read back for a line tail (a log without newlines can't make us read it all)
const START_WAIT = 10_000; // ms for the login shell to come up before start gives up

// The runner (core/boxery-job-runner.sh) is plain bash: callers send it with `start`, base64-encoded,
// and the helper writes it to runner.sh. It keeps the job alive and records its exit code; see its header.

class UsageError extends Error {}
class UnknownJob extends Error {}

const now = (): number => Math.floor(Date.now() / 1000);
const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const file = (id: string, ext: string): string => path.join(JD, `${id}.${ext}`);
const readText = (f: string): string | null => {
	try {
		return readFileSync(f, "utf8");
	} catch {
		return null;
	}
};
const bootId = (): string | null => {
	const boot = readText("/proc/sys/kernel/random/boot_id")?.trim();
	if (!boot) return null;
	// RAM templates resume the same kernel boot. A host-assigned incarnation also fences jobs
	// after a restore/reset; ordinary cold-boot guests without this marker retain the old format.
	const incarnation = readText("/run/boxery/incarnation")?.trim();
	return incarnation ? `${boot}:${incarnation}` : boot;
};
const shellQuote = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function out(s: string | Buffer): void {
	const b = typeof s === "string" ? Buffer.from(s) : s;
	for (let off = 0; off < b.length; ) {
		try {
			off += writeSync(1, b, off);
		} catch (e: any) {
			if (e.code === "EAGAIN") sleep(10);
			else if (e.code === "EPIPE") process.exit(0);
			else throw e;
		}
	}
}
const json = (v: unknown): void => out(`${JSON.stringify(v)}\n`);
let noticed = false;
const truncatedNotice = (): void => {
	if (!noticed) process.stderr.write("boxery jobs: output byte-truncated\n");
	noticed = true;
};

/**
 * The caller went away (Ctrl-C, or the tool call was cancelled): stop polling instead of running until
 * the job ends. If our parent exits we're reparented. But over a shared (ControlMaster) connection sshd
 * lives on and only closes our stdout, which only a real write notices (EPIPE). So with `heartbeat`,
 * `wait` writes a newline every 2 s. `logs --follow` can't add bytes to the log: it relies on its own
 * output writes, and the CLI runs it over a dedicated connection (so the parent check works).
 * This catches a connection that is closed. One that dies silently (laptop asleep, network gone) looks
 * open until ssh's keepalive gives up; until then writes still succeed.
 */
let lastBeat = Date.now();
function callerGone(heartbeat = false): boolean {
	if (process.ppid !== PPID) return true;
	if (!heartbeat || Date.now() - lastBeat < 2000) return false;
	lastBeat = Date.now();
	try {
		writeSync(1, "\n");
	} catch (e: any) {
		return e.code === "EPIPE";
	}
	return false;
}

function writeAtomic(f: string, data: string, mode = 0o600): void {
	const tmp = `${f}.tmp.${process.pid}`;
	writeFileSync(tmp, data, { mode });
	renameSync(tmp, f);
}

function assertId(id: string | undefined): string {
	if (!id || !VALID_ID.test(id)) throw new UsageError(`invalid job id: ${id ?? ""}`);
	return id;
}

function meta(id: string): Meta {
	const raw = readText(file(id, "json"));
	if (raw == null) throw new UnknownJob(`unknown job: ${id}`);
	return JSON.parse(raw) as Meta;
}

/** A recorded process: its pid and, where /proc exists, its start time (to tell it from a reused pid). */
interface Proc {
	pid: number;
	start: string | null;
}

/** ID.runner / ID.pid: "PID STARTTIME" (start time empty without /proc). */
function procFrom(f: string): Proc | null {
	const [p, start] = (readText(f) ?? "").trim().split(/\s+/);
	const pid = Number(p);
	return Number.isInteger(pid) && pid > 1 ? { pid, start: start || null } : null;
}
const pidFrom = (f: string): number | null => procFrom(f)?.pid ?? null;

/** Fields of /proc/PID/stat after the command name (which may contain spaces and parens), or null. */
function statFields(pid: number): string[] | null {
	const stat = readText(`/proc/${pid}/stat`);
	return stat == null ? null : stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

/** Our own processes only: kill(0) also "succeeds" (EPERM) for another user's process. */
function exists(target: number): boolean {
	try {
		process.kill(target, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Is the recorded process (group: or any process still in its process group) alive? A pid can be
 * reused once its process is gone, so where /proc exists the start time must match: a different
 * process with that pid (or a new session that took it as its group id) is not ours.
 */
function alive(p: Proc, group: boolean): boolean {
	if (!exists(group ? -p.pid : p.pid)) return false;
	if (!existsSync("/proc/self/stat")) return true; // no /proc (macOS): kill(0) is all we have
	const f = statFields(p.pid);
	if (f != null) {
		if (p.start && f[19] !== p.start) return false; // the pid now belongs to another process
		if (f[0] !== "Z") return true;
		if (!group) return false; // a zombie is gone
	}
	// The leader is gone or a zombie. Linux doesn't reuse a pid while a process group still has that
	// id, so live members of group pid are what the job left behind.
	return groupMembers(p.pid) > 0;
}

/** Live (non-zombie) processes in process group pgid, from /proc. */
function groupMembers(pgid: number): number {
	let n = 0;
	for (const d of readdirSync("/proc")) {
		if (!/^\d+$/.test(d)) continue;
		const f = statFields(Number(d));
		if (f && Number(f[2]) === pgid && f[0] !== "Z") n++;
	}
	return n;
}

/** Any process left in the job's process group (the command, or something it started), or null. */
function groupLeft(m: Meta): Proc | null {
	const g = procFrom(file(m.id, "pid"));
	return g && alive(g, true) && sameBoot(m) ? g : null;
}

const groupLeftById = (id: string): boolean => {
	try {
		return groupLeft(meta(id)) != null;
	} catch {
		return false;
	}
};

function sameBoot(m: Meta): boolean {
	const boot = bootId();
	return !(m.boot_id && boot && m.boot_id !== boot); // after a VM restart, none of the pids are ours
}

/** Process state letter (R, S, Z, …), or null if unknown. */
const processState = (pid: number): string | null => statFields(pid)?.[0] ?? null;

function exitInfo(id: string): { code: number; ended: number } | null {
	const raw = readText(file(id, "exit"));
	if (raw == null) return null;
	const [code, ended] = raw.trim().split(/\s+/).map(Number);
	return Number.isInteger(code) ? { code, ended } : null;
}

/** Whether any part of the job is still alive: its waiter, or its command's process group. */
function live(m: Meta): boolean {
	if (!sameBoot(m)) return false;
	const runner = procFrom(file(m.id, "runner"));
	const pgid = procFrom(file(m.id, "pid"));
	if (runner == null && pgid == null) return now() - m.started_at < START_WAIT / 1000 + 5; // still starting
	return (runner != null && alive(runner, false)) || (pgid != null && alive(pgid, true));
}

function stateOf(m: Meta): State {
	if (exitInfo(m.id)) return "exited";
	if (live(m)) return "running";
	return exitInfo(m.id) ? "exited" : "lost"; // it may have finished between the two checks
}

function job(m: Meta): Job {
	const state = stateOf(m);
	const x = state === "exited" ? exitInfo(m.id) : null;
	return {
		id: m.id,
		state,
		command: m.argv.map(shellQuote).join(" "),
		argv: m.argv,
		cwd: m.cwd,
		started_at: m.started_at,
		ended_at: x?.ended ?? null,
		exit_code: x?.code ?? null,
		killed: existsSync(file(m.id, "killed")),
		leftover: state === "exited" && groupLeft(m) != null,
		log: file(m.id, "log"),
	};
}

function allJobs(): Job[] {
	let names: string[] = [];
	try {
		names = readdirSync(JD);
	} catch {}
	const metas: Meta[] = [];
	for (const n of names) {
		const id = n.endsWith(".json") ? n.slice(0, -5) : "";
		if (!VALID_ID.test(id)) continue;
		try {
			metas.push(meta(id));
		} catch {}
	}
	metas.sort((a, b) => a.started_at - b.started_at || a.id.localeCompare(b.id));
	return metas.map(job);
}

// ---------------------------------------------------------------- output helpers

/**
 * Removes terminal escapes from a byte stream: CSI (colours, cursor), OSC (titles, links), charset
 * selects and other two-byte escapes. Only the parser state survives between chunks, never text, so
 * newline-free progress output is passed on as soon as it is read. Works on bytes: ESC and the escape
 * bytes are ASCII, which never occur inside a multi-byte UTF-8 character.
 */
class AnsiStripper {
	state: "text" | "esc" | "csi" | "osc" | "osc_esc" | "charset" = "text";
	push(b: Buffer): Buffer {
		const o = Buffer.alloc(b.length);
		let n = 0;
		for (const c of b) {
			switch (this.state) {
				case "text":
					if (c === 0x1b) this.state = "esc";
					else o[n++] = c;
					break;
				case "esc":
					if (c === 0x5b) this.state = "csi"; // [
					else if (c === 0x5d) this.state = "osc"; // ]
					else if (c === 0x28 || c === 0x29) this.state = "charset"; // ( )
					else this.state = "text"; // two-byte escape (ESC M, ESC 7, ESC =, …): dropped
					break;
				case "csi":
					if (c >= 0x40 && c <= 0x7e) this.state = "text"; // final byte
					else if (c < 0x20 || c > 0x3f) this.state = "text"; // malformed: drop and resync
					break;
				case "osc":
					if (c === 0x07) this.state = "text";
					else if (c === 0x1b) this.state = "osc_esc";
					break;
				case "osc_esc":
					if (c === 0x5c || c === 0x07) this.state = "text";
					else if (c !== 0x1b) this.state = "osc";
					break;
				case "charset":
					this.state = "text";
					break;
			}
		}
		return o.subarray(0, n);
	}
}

/** One line as a terminal shows it: only the text after the last \r (progress bars), escapes gone. */
const lastFrame = (line: string): string => {
	const s = line.replace(/\r+$/, "");
	return s.slice(s.lastIndexOf("\r") + 1);
};

/** Byte offset where the last n lines start, looking back no further than floor. */
function tailOffset(fd: number, size: number, n: number, floor: number): number {
	if (n <= 0) return size;
	const buf = Buffer.alloc(64 * 1024);
	let pos = size;
	let seen = 0;
	let skipFinal = true; // a final newline ends the last line; it doesn't start another one
	while (pos > floor) {
		const len = Math.min(buf.length, pos - floor);
		pos -= len;
		readSync(fd, buf, 0, len, pos);
		for (let i = len - 1; i >= 0; i--) {
			if (buf[i] !== 10) {
				skipFinal = false;
				continue;
			}
			if (skipFinal) {
				skipFinal = false;
				continue;
			}
			if (++seen === n) return pos + i + 1;
		}
	}
	return floor;
}

function copyRange(fd: number, from: number, to: number, emit: (b: Buffer) => void): void {
	const buf = Buffer.alloc(64 * 1024);
	for (let pos = from; pos < to; ) {
		const n = readSync(fd, buf, 0, Math.min(buf.length, to - pos), pos);
		if (n <= 0) break;
		emit(buf.subarray(0, n));
		pos += n;
	}
}

/** Last n lines with escapes removed and progress bars collapsed (for `wait --output`). Bounded read. */
function tailText(id: string, n: number): string {
	const fd = openSync(file(id, "log"), "r");
	try {
		const size = fstatSync(fd).size;
		const from = tailOffset(fd, size, n, Math.max(0, size - TAIL_CAP));
		const buf = Buffer.alloc(size - from);
		readSync(fd, buf, 0, buf.length, from);
		const lines = new AnsiStripper().push(buf).toString("utf8").split("\n");
		if (lines.at(-1) === "") lines.pop();
		return lines.slice(-n).map(lastFrame).join("\n");
	} finally {
		closeSync(fd);
	}
}

const ago = (s: number): string => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);

function table(jobs: Job[]): string {
	if (!jobs.length) return "(no jobs)\n";
	const t = now();
	const rows = [
		["JOB", "STATE", "EXIT", "STARTED", "TOOK", "COMMAND"],
		...jobs.map((j) => [
			j.id,
			(j.killed && j.state === "exited" ? "killed" : j.state) + (j.leftover ? "+" : ""),
			j.exit_code == null ? "-" : String(j.exit_code),
			`${ago(t - j.started_at)} ago`,
			j.ended_at == null ? (j.state === "running" ? ago(t - j.started_at) : "-") : ago(j.ended_at - j.started_at),
			j.command.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/ +/g, " ").slice(0, 120), // no escapes on the terminal
		]),
	];
	const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
	return `${rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ")).join("\n")}\n`;
}

function remove(id: string): void {
	for (const ext of ["json", "argv", "cwd", "log", "runner", "pid", "exit", "exit.tmp", "killed"]) rmSync(file(id, ext), { force: true });
}

/** cwd as `boxery run --cwd` resolves it: default ~/project (home if missing), relative below ~/project.
 *  Works on bytes, so a directory name that isn't UTF-8 still resolves. */
function resolveCwdBytes(cwd: Buffer | null): Buffer {
	const project = path.join(HOME, "project");
	const b = (s: string) => Buffer.from(s, "utf8");
	if (cwd == null || cwd.length === 0) return b(existsSync(project) ? project : HOME);
	const text = cwd.toString("latin1"); // 1:1 bytes; only ASCII prefixes are inspected
	if (text === "~") return b(HOME);
	if (text.startsWith("~/")) return Buffer.concat([b(`${HOME}/`), cwd.subarray(2)]);
	return text.startsWith("/") ? cwd : Buffer.concat([b(`${project}/`), cwd]);
}

function decode(b64: string | undefined, what: string): Buffer {
	if (b64 == null || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new UsageError(`invalid ${what}`);
	return Buffer.from(b64, "base64");
}

// ---------------------------------------------------------------- actions

function start(argvB64: string | undefined, cwdB64: string | undefined, runnerB64: string | undefined, text: boolean): void {
	// Bytes are passed through as given (like `boxery run`): only the JSON record holds UTF-8 strings.
	const raw = decode(argvB64, "argv");
	const argv = raw.length ? raw.toString("utf8").split("\0").slice(0, -1) : [];
	if (!argv.length || raw[raw.length - 1] !== 0) throw new UsageError("start needs a command (argv: NUL-terminated arguments)");
	if (raw[0] === 0) throw new UsageError("empty command name");
	const cwdRaw = cwdB64 === "-" ? null : decode(cwdB64, "cwd");
	const cwdBytes = resolveCwdBytes(cwdRaw);
	const cwd = cwdBytes.toString("utf8");
	const runner = decode(runnerB64, "runner").toString("utf8");
	if (!runner.startsWith("#!/bin/bash\n")) throw new UsageError("start needs the runner script (core/boxery-job-runner.sh, base64)");
	if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) throw new Error("tmux is not installed in the VM");
	mkdirSync(JD, { recursive: true, mode: 0o700 });
	writeAtomic(path.join(JD, "runner.sh"), runner, 0o700);
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	const id = `job-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(3).toString("hex")}`;
	const m: Meta = { id, argv, cwd, started_at: now(), boot_id: bootId() };
	writeFileSync(file(id, "argv"), raw, { mode: 0o600 });
	writeFileSync(file(id, "cwd"), cwdBytes, { mode: 0o600 });
	writeFileSync(file(id, "log"), "", { mode: 0o600 });
	writeAtomic(file(id, "json"), `${JSON.stringify(m)}\n`);
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	const r = spawnSync("tmux", ["new-session", "-d", "-s", id, `bash ${q(path.join(JD, "runner.sh"))} ${q(JD)} ${id}`], { encoding: "utf8" });
	if (r.status !== 0) {
		remove(id);
		throw new Error(`could not launch the job: tmux new-session failed${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
	}
	// Ready once the waiter (a login shell) has started the command. Give up early if it died first.
	// "Died" means really gone, seen twice: a process mid-exec must not count as dead.
	let gone = 0;
	for (const end = Date.now() + START_WAIT; pidFrom(file(id, "pid")) == null && Date.now() < end; sleep(50)) {
		const w = pidFrom(file(id, "runner"));
		let dead = false;
		try {
			if (w != null) process.kill(w, 0);
		} catch (e: any) {
			dead = e.code === "ESRCH";
		}
		gone = dead || (w != null && processState(w) === "Z") ? gone + 1 : 0;
		if (gone >= 2 && pidFrom(file(id, "pid")) == null) break;
	}
	if (pidFrom(file(id, "pid")) == null) {
		// Don't leave a job that might still start after we report failure (a retry would run it twice):
		// without its .json the waiter won't start the command, and whatever did start is killed.
		rmSync(file(id, "json"), { force: true });
		spawnSync("tmux", ["kill-session", "-t", `=${id}`], { stdio: "ignore" });
		sleep(200);
		// The waiter leads its own session, and anything it forked stays in its group until that runs
		// setsid; so kill both whole groups, then once more for a command that raced its .pid write.
		const killGroups = () => {
			for (const ext of ["runner", "pid"]) {
				const pid = pidFrom(file(id, ext));
				try {
					if (pid != null) process.kill(-pid, "SIGKILL");
				} catch {}
			}
		};
		killGroups();
		sleep(300);
		killGroups();
		remove(id);
		throw new Error("could not launch the job: the runner did not become ready (the login shell failed or took over 10s); nothing is running");
	}
	if (text) out(`${id}\n`);
	else json(job(m));
}

function logs(id: string, lines: number, bytes: number, follow: boolean, strip: boolean): void {
	const m = meta(id);
	const ansi = strip ? new AnsiStripper() : null;
	const emit = (b: Buffer) => out(ansi ? ansi.push(b) : b);
	const fd = openSync(file(id, "log"), "r");
	// Clip a read [from, to) to its last `bytes` bytes, before line selection and ANSI filtering.
	const clip = (from: number, to: number): number => {
		if (bytes > 0 && to - from > bytes) {
			truncatedNotice();
			return to - bytes;
		}
		return from;
	};
	try {
		let size = fstatSync(fd).size;
		let from = clip(0, size);
		if (lines >= 0) {
			const floor = Math.max(from, size - TAIL_CAP);
			const at = tailOffset(fd, size, lines, floor);
			if (at === floor && floor > from) truncatedNotice(); // fewer lines than asked: they're too long
			from = at;
		}
		copyRange(fd, from, size, emit);
		let off = size;
		while (follow && !callerGone()) {
			// Check for the end *before* reading, so the last read includes everything the job wrote.
			const done = stateOf(m) !== "running";
			size = fstatSync(fd).size;
			if (size > off) copyRange(fd, clip(off, size), size, emit);
			off = size;
			if (done) break;
			sleep(200);
		}
	} finally {
		closeSync(fd);
	}
}

function wait(id: string, timeout: number, output: number, exit0: boolean): number {
	const m = meta(id);
	const t0 = Date.now();
	let j = job(m);
	while (j.state === "running" && (timeout < 0 || Date.now() - t0 < timeout * 1000)) {
		if (callerGone(true)) process.exit(0);
		sleep(Math.min(200, timeout < 0 ? 200 : Math.max(10, timeout * 1000 - (Date.now() - t0))));
		j = job(m);
	}
	const res: Job & { timed_out: boolean; output?: string } = { ...j, timed_out: j.state === "running" };
	if (output > 0) res.output = tailText(id, output);
	json(res);
	// The job's code can be anything, including 255, which ssh callers read as "connection failed".
	if (exit0) return 0;
	return j.state === "exited" ? (j.exit_code ?? 125) : j.state === "running" ? 124 : 125;
}

function kill(id: string, grace: number, text: boolean): void {
	const m = meta(id);
	// Whatever the state: a job that has exited can leave processes behind in its group (`server & tests`).
	let target = stateOf(m) === "running" ? null : groupLeft(m);
	if (stateOf(m) === "running") {
		for (let i = 0; i < 100 && (target = procFrom(file(id, "pid"))) == null; i++) sleep(50);
		if (target == null) throw new Error(`${id} is still starting; try again in a moment`);
	}
	if (target != null) {
		const g = target;
		const signal = (sig: NodeJS.Signals) => {
			try {
				process.kill(-g.pid, sig);
			} catch {}
		};
		// Wait for the whole group, not just the exit code: children that ignore TERM get the KILL too.
		const busy = () => stateOf(m) === "running" || alive(g, true);
		const until = (ms: number) => {
			for (const end = Date.now() + ms; Date.now() < end && busy(); ) sleep(100);
		};
		// A job is "killed" if it was still running when signalled: one that ended on its own just before
		// isn't. (Exit codes are recorded after the fact, so check now, and only mark if it was running.)
		const wasRunning = !exitInfo(id);
		signal("SIGTERM");
		if (wasRunning) writeFileSync(file(id, "killed"), `${now()}\n`, { mode: 0o600 });
		until(grace * 1000);
		if (busy()) {
			signal("SIGKILL");
			until(3000);
		}
	}
	const j = job(m);
	if (!text) return json(j);
	if (j.state === "running" || j.leftover) throw new Error(`${id} is still running (a process may have left its process group)`);
	if (j.state !== "exited") return out(`${id} is ${j.state}${target ? " (stopped what it left running)" : ""}\n`);
	const what = j.killed ? "killed" : target ? "stopped processes left running by" : "already finished:";
	out(`${what} ${id} (exit ${j.exit_code})\n`);
}

/** Delete finished or lost jobs that ended more than olderThan seconds ago. */
function prune(olderThan: number, text: boolean): void {
	const t = now();
	// A job whose processes are still running (leftover) is kept: its files are how kill finds them.
	const removed = allJobs()
		.filter((j) => j.state !== "running" && !j.leftover && !groupLeftById(j.id) && t - (j.ended_at ?? j.started_at) >= olderThan)
		.map((j) => (remove(j.id), j.id));
	if (text) out(`removed ${removed.length} job${removed.length === 1 ? "" : "s"}\n`);
	else json(removed);
}

// ---------------------------------------------------------------- CLI

function main(argv: string[]): number {
	const [action, ...rest] = argv;
	const flags = new Map<string, string | true>();
	const pos: string[] = [];
	const valued = new Set(["--lines", "--bytes", "--timeout", "--output", "--grace", "--older-than"]);
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (valued.has(a)) {
			if (i + 1 >= rest.length) throw new UsageError(`${a} needs a value`);
			flags.set(a, rest[++i]);
		} else if (a.startsWith("--")) flags.set(a, true);
		else pos.push(a);
	}
	const num = (name: string, dflt: number, min = -1): number => {
		const v = flags.get(name);
		if (v === undefined) return dflt;
		const n = Number(v);
		if (v === true || !/^-?\d+$/.test(v) || !Number.isSafeInteger(n) || n < min) throw new UsageError(`${name} must be a whole number`);
		return n;
	};
	const text = flags.has("--text");
	switch (action) {
		case "start":
			start(pos[0], pos[1], pos[2], text);
			return 0;
		case "list":
			text ? out(table(allJobs())) : json(allJobs());
			return 0;
		case "logs":
			logs(assertId(pos[0]), num("--lines", -1), num("--bytes", 0, 1), flags.has("--follow"), flags.has("--strip-ansi"));
			return 0;
		case "wait":
			return wait(assertId(pos[0]), num("--timeout", -1), num("--output", 0, 0), flags.has("--exit0"));
		case "kill":
			kill(assertId(pos[0]), num("--grace", 5, 0), text);
			return 0;
		case "prune":
			prune(num("--older-than", 0, 0), text);
			return 0;
		default:
			throw new UsageError(`unknown action: ${action ?? ""} (start | list | logs | wait | kill | prune)`);
	}
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch (e: any) {
	process.stderr.write(`boxery jobs: ${e?.message ?? e}\n`);
	process.exitCode = e instanceof UnknownJob ? 3 : e instanceof UsageError ? 2 : 1;
}
