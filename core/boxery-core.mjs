// boxery core: VM transport and tool implementations shared by the pi extension and the MCP server.
// Plain ESM, Node >= 18, no dependencies. Talks to VMs over ssh using ~/.boxery/ssh_config
// (written by `boxery setup`), and to the VM host through the `boxery` controller CLI.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q } from "./shell.mjs";
import { streamCopy } from "./copy-stream.mjs";
export { q } from "./shell.mjs";

export const BOXERY_HOME = path.resolve(process.env.BOXERY_HOME ?? path.join(homedir(), ".boxery"));
export const SSH_CONF = path.join(BOXERY_HOME, "ssh_config");
// A context is resolved once at a call boundary, then inherited by all nested async work.
const hostContext = new AsyncLocalStorage();
const resolvedHosts = new WeakSet();
let implicitHost; // Existing callers (pi) keep a stable default for this process.
export const VALID_HOST = /^[a-z][a-z0-9-]{0,30}$/;
export function assertHost(name) {
	if (typeof name !== "string" || name !== name.trim() || !VALID_HOST.test(name)) throw new Error(`invalid host name "${name ?? ""}"`);
	return name;
}
function registryLine(file, optional = false) {
	let fd, text;
	try {
		// Validate and read the same object. No-follow prevents a replacement symlink from
		// changing the target; nonblocking lets fstat reject a replacement FIFO without hanging.
		fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
		if (!fstatSync(fd).isFile()) throw new Error("expected a readable regular file, not symlink");
		text = readFileSync(fd, "utf8");
	} catch (e) {
		if (optional && e.code === "ENOENT") return null;
		throw new Error(`invalid registry file: ${file} (${e.message})`);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	if (text.length < 2 || text.includes("\0") || !text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) throw new Error(`invalid registry file: ${file}`);
	return text.slice(0, -1);
}
export function resolveHost(host) {
	if (host && typeof host === "object" && resolvedHosts.has(host)) return host;
	let name = host;
	if (name == null) {
		const file = path.join(BOXERY_HOME, "default-host");
		name = registryLine(file, true) ?? "legacy";
	}
	assertHost(name);
	let dir = BOXERY_HOME;
	if (name !== "legacy") {
		const file = path.join(BOXERY_HOME, "host-registry", name);
		dir = registryLine(file, true);
		if (dir == null) throw new Error(`unknown host: ${name}`);
		if (!path.isAbsolute(dir) || /[\r\n\t]/.test(dir)) throw new Error(`invalid profile directory for ${name}`);
		if (!["config", "ssh_config"].every((f) => existsSync(path.join(dir, f)))) throw new Error(`incomplete profile: ${name}`);
	}
	const resolved = Object.freeze({ name, dir, sshConf: path.join(dir, "ssh_config") });
	resolvedHosts.add(resolved);
	return resolved;
}
export const currentHost = () => hostContext.getStore() ?? (implicitHost ??= resolveHost());
export const withHost = (host, fn) => hostContext.run(resolveHost(host), fn);
export function registeredHosts() {
	const registry = path.join(BOXERY_HOME, "host-registry");
	const names = existsSync(registry) ? readdirSync(registry).filter((n) => VALID_HOST.test(n) && n !== "legacy").sort() : [];
	return [resolveHost("legacy"), ...names.map(resolveHost)];
}
// A small regular file, or null. Nonblocking so a FIFO is rejected by fstat instead of hanging.
function readProfileFile(file, max = 64 * 1024) {
	let fd;
	try {
		fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
		const st = fstatSync(fd);
		return st.isFile() && st.size <= max ? readFileSync(fd, "utf8") : null;
	} catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
// One shell word as `boxery setup` writes it (literal(): '…' with '\'' for quotes), or a plain word.
// Anything needing expansion ($, `, globs…) is unknown: profile configs are never executed here.
function shellWord(s) {
	let out = "";
	for (let i = 0; i < s.length;) {
		const c = s[i];
		if (c === "'") {
			const j = s.indexOf("'", i + 1);
			if (j < 0) return null;
			out += s.slice(i + 1, j); i = j + 1;
		} else if (c === '"') {
			const j = s.indexOf('"', i + 1);
			if (j < 0 || /[$`\\]/.test(s.slice(i + 1, j))) return null;
			out += s.slice(i + 1, j); i = j + 1;
		} else if (c === "\\" && i + 1 < s.length) { out += s[i + 1]; i += 2; }
		else if (c === " " || c === "\t") return /^[ \t]*(#.*)?$/.test(s.slice(i)) ? out : null;
		else if (/[A-Za-z0-9_.@:%+\-/~,=]/.test(c)) { out += c; i++; }
		else return null;
	}
	return out;
}
const VALID_DEST = /^[A-Za-z0-9_.@:%+][A-Za-z0-9_.@:%+-]*$/; // controller valid_dest()
/** Where a profile's VM host runs: "local" (the machine running the controller), an ssh destination, or null (unset/unparsed). */
export function hostDestination(host) {
	const h = resolveHost(host);
	let dest = h.name === "legacy" ? process.env.BOXERY_HOST || null : null; // legacy honors BOXERY_HOST, like the controller
	if (!dest) {
		const text = readProfileFile(path.join(h.dir, "config")) ?? "";
		const values = text.split("\n").map((l) => /^[ \t]*(?:export[ \t]+)?HOST=(.*)$/.exec(l)).filter(Boolean);
		dest = values.length ? shellWord(values.at(-1)[1]) : null; // the last assignment wins, as when sourced
	}
	return dest && VALID_DEST.test(dest) ? dest : null;
}
/** The host's VM backend as recorded in the profile by `boxery setup`/`boxery backend`, or null. Never contacts the host. */
export function hostBackend(host) {
	const text = readProfileFile(path.join(resolveHost(host).dir, "backend"), 64);
	const name = text?.replace(/\n$/, "");
	return name && VALID_HOST.test(name) ? name : null; // one line, like the controller's valid_vm
}
/**
 * Registered hosts with where each runs: {name, dir, default, destination, backend, same_as}. Reads only local
 * profile files (never sources them, never contacts a host). same_as names the other entries sharing this
 * profile directory: `legacy` and an alias registered for ~/.boxery are the same host.
 */
export function describeHosts() {
	let def = null;
	try { def = resolveHost().name; } catch {}
	const real = (d) => { try { return realpathSync(d); } catch { return path.resolve(d); } };
	const hosts = registeredHosts().map((h) => ({ host: h, real: real(h.dir) }));
	return hosts.map(({ host: h, real: r }) => ({
		name: h.name,
		dir: h.dir,
		default: h.name === def,
		destination: hostDestination(h),
		backend: hostBackend(h),
		same_as: hosts.filter((o) => o.real === r && o.host.name !== h.name).map((o) => o.host.name),
	}));
}
/** Per-subprocess environment; ambient legacy overrides must never replace a named target. */
export function controllerCommand(args) {
	const host = currentHost();
	const env = { ...process.env, BOXERY_HOME: host.dir };
	if (host.name !== "legacy") { delete env.BOXERY_HOST; delete env.BOXERY_HOST_BIN; }
	// Bind the resolved directory, not a registry entry that could change during this call.
	return { args: ["--host", "legacy", ...args], env };
}
export const REMOTE_HOME = "/home/agent";
export const PROJECT = `${REMOTE_HOME}/project`;
export const CDP_PORT = 9222;
export const VALID_NAME = /^[a-z][a-z0-9-]{0,30}$/;
export const MAX_BYTES = 50 * 1024;
export const MAX_CAPTURE = 64 * 1024 * 1024; // hard cap on bytes buffered from one remote command
export const MAX_LINES = 2000;

export function controllerPath() {
	if (process.env.BOXERY_BIN) return process.env.BOXERY_BIN;
	try {
		const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../controller/boxery");
		if (existsSync(p)) return p;
	} catch {}
	return "boxery";
}
export const BOXERY = controllerPath();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const newName = () => `pi-${randomBytes(3).toString("hex")}`;

export const VALID_SNAP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function assertSnap(s) {
	if (!s || !VALID_SNAP.test(s)) throw new Error(`invalid snapshot name "${s ?? ""}"`);
	return s;
}

/** An image is a snapshot addressed host-wide: VM@SNAP. */
export function assertImage(s) {
	const [vm, snap, ...rest] = typeof s === "string" ? s.split("@") : [];
	if (rest.length || !vm || !VALID_NAME.test(vm) || !snap || !VALID_SNAP.test(snap)) throw new Error(`invalid image "${s ?? ""}" (use VM@SNAP)`);
	return s;
}

export function assertName(name) {
	if (typeof name !== "string" || !VALID_NAME.test(name)) throw new Error(`invalid VM name "${name ?? ""}"`);
	return name;
}

/** VM path for a model-supplied path: ~ → VM home, relative → VM project dir. */
export function vmPath(p) {
	const s = String(p ?? ".").trim() || ".";
	if (s === "~") return REMOTE_HOME;
	if (s.startsWith("~/")) return REMOTE_HOME + s.slice(1);
	return path.posix.isAbsolute(s) ? path.posix.normalize(s) : path.posix.join(PROJECT, s);
}

/** Parse "host/vm:/path", "vm:/path", "local:/path" or a plain path (= current VM). */
export function parseLoc(spec, current) {
	const explicit = String(spec).match(/^([^:]*\/[^:]*):(.*)$/s);
	if (explicit && !explicit[1].startsWith("/")) {
		const parts = explicit[1].split("/");
		if (parts.length !== 2) throw new Error(`invalid host/VM endpoint: ${spec}`);
		const host = resolveHost(parts[0]);
		return { host, vm: assertName(parts[1]), path: vmPath(explicit[2]) };
	}
	const m = String(spec).match(/^([a-z][a-z0-9-]{0,30}|local):(.*)$/s);
	if (m) return m[1] === "local" ? { vm: null, path: m[2] } : { vm: m[1], path: vmPath(m[2]) };
	if (!current) throw new Error(`"${spec}" has no VM prefix and no current VM is set (use NAME:path or local:path)`);
	return { vm: current, path: vmPath(spec) };
}

// ---------------------------------------------------------------- transport

/**
 * Run a bash script in a VM. opts: { input, signal, timeoutMs, onData }.
 * Resolves { code, stdout: Buffer, stderr }. ssh exit 255 (transport failure) rejects.
 */
export function sshRun(vm, script, opts = {}) {
	return new Promise((resolve, reject) => {
		if (!VALID_NAME.test(vm ?? "")) return reject(new Error(`invalid VM name "${vm}"`));
		const { sshConf } = currentHost();
		if (!existsSync(sshConf)) return reject(new Error(`boxery not set up (${sshConf} missing); run: boxery setup user@host`));
		const child = spawn("ssh", ["-F", sshConf, "-o", "BatchMode=yes", `${vm}.boxery`, `bash -c ${q(script)}`], {
			stdio: [opts.input != null ? "pipe" : "ignore", "pipe", "pipe"],
		});
		const out = [];
		let err = "";
		let timer;
		let size = 0;
		const cap = opts.maxBytes ?? MAX_CAPTURE;
		let overflow = false;
		child.stdout.on("data", (d) => {
			if (opts.onData) return opts.onData(d);
			size += d.length;
			if (size > cap) {
				overflow = true;
				child.kill();
				return;
			}
			out.push(d);
		});
		child.stderr.on("data", (d) => {
			if (opts.onData) return opts.onData(d);
			if (err.length < 64 * 1024) err += d.toString();
		});
		// opts.closePipes (job helper calls): also close our ends of the pipes, so a remote side that outlives
		// ssh gets EPIPE at its next write. Other callers keep them: e.g. vm_edit's guest cleans up on SIGTERM
		// and must not be cut off mid-cleanup.
		function stop() {
			child.kill();
			if (!opts.closePipes) return;
			child.stdout.destroy();
			child.stderr.destroy();
		}
		const onAbort = stop;
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts.timeoutMs) timer = setTimeout(stop, opts.timeoutMs);
		child.on("error", reject);
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (overflow) return reject(new Error(`output exceeded ${Math.round(cap / 1048576)} MiB; refusing to buffer more`));
			if (code === 255) return reject(new Error(`VM "${vm}" unreachable over ssh: ${err.trim() || "connection failed"}`));
			resolve({ code, stdout: Buffer.concat(out), stderr: err });
		});
		if (opts.input != null) {
			child.stdin.on("error", () => {}); // EPIPE if the remote side exits early; the exit code reports it
			child.stdin.end(opts.input);
		}
	});
}

export async function sshOk(vm, script, opts = {}) {
	const r = await sshRun(vm, script, opts);
	if (r.code !== 0) throw new Error(r.stderr.trim() || `command failed (exit ${r.code})`);
	return r.stdout;
}

/** opts.progress(line): called with each non-empty output line as it arrives (MCP progress). */
export function boxeryCli(args, timeoutMs = 300_000, { progress } = {}) {
	return new Promise((resolve, reject) => {
		const command = controllerCommand(args);
		const child = execFile(BOXERY, command.args, { env: command.env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (e, stdout, stderr) => {
			if (e) reject(new Error(`boxery ${args.join(" ")}: ${(stderr || e.message).trim()}`));
			else resolve(`${stdout}${stderr}`.trim());
		});
		if (progress) for (const s of [child.stdout, child.stderr]) s?.on("data", (d) => lastLine(d) && progress(lastLine(d)));
	});
}

/** The last non-empty line of an output chunk, for progress messages. */
export const lastLine = (d) => String(d).split("\n").map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 200) ?? "";

/**
 * Run a command in a VM as its own process group, so abort/timeout kill the remote job too.
 * stdin is /dev/null (tools like rg would otherwise read the ssh pipe). Local env is not forwarded.
 * Resolves { exitCode }; rejects "aborted" / "timeout:N" / transport errors.
 */
export function execRemote(vm, command, cwd, { onData, signal, timeout } = {}) {
	return new Promise((resolve, reject) => {
		const id = randomBytes(6).toString("hex");
		// setsid makes the inner shell a new session/group leader; it records its PID (= PGID) before
		// exec'ing the user command, so cleanup can kill exactly that process group.
		const pidf = `/tmp/boxery-run-${id}.pgid`;
		const inner = `echo $$ > ${pidf}; exec bash -lc ${q(command)}`;
		const script = `cd ${q(cwd || PROJECT)} 2>/dev/null || cd ${q(PROJECT)} 2>/dev/null || cd ~; setsid -w bash -c ${q(inner)} </dev/null; rc=$?; rm -f ${pidf}; exit $rc`;
		let timedOut = false;
		const host = currentHost();
		const killRemote = () => withHost(host, () =>
			sshRun(vm, `g=$(cat ${pidf} 2>/dev/null); [ -n "$g" ] && { kill -TERM -- -"$g"; sleep 2; kill -KILL -- -"$g"; rm -f ${pidf}; } 2>/dev/null; true`).catch(() => {}));
		const ac = new AbortController();
		const onAbort = () => {
			void killRemote();
			ac.abort();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = timeout
			? setTimeout(() => {
					timedOut = true;
					void killRemote();
					ac.abort();
				}, timeout * 1000)
			: undefined;
		sshRun(vm, script, { onData, signal: ac.signal })
			.then((r) => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (signal?.aborted) reject(new Error("aborted"));
				else if (timedOut) reject(new Error(`timeout:${timeout}`));
				else resolve({ exitCode: r.code });
			})
			.catch((e) => {
				if (timer) clearTimeout(timer);
				reject(e);
			});
	});
}

// ---------------------------------------------------------------- truncation

/** Keep the first lines/bytes (file reads). */
export function truncHead(text, maxLines = MAX_LINES, maxBytes = MAX_BYTES) {
	const lines = text.split("\n");
	let out = [];
	let bytes = 0;
	let truncated = false;
	for (const l of lines) {
		const b = Buffer.byteLength(l) + 1;
		if (out.length >= maxLines || bytes + b > maxBytes) {
			truncated = true;
			break;
		}
		out.push(l);
		bytes += b;
	}
	return { text: out.join("\n"), truncated, shownLines: out.length, totalLines: lines.length };
}

/** Keep the last lines/bytes (command output). */
export function truncTail(text, maxLines = MAX_LINES, maxBytes = MAX_BYTES) {
	const lines = text.split("\n");
	const out = [];
	let bytes = 0;
	let truncated = false;
	for (let i = lines.length - 1; i >= 0; i--) {
		const b = Buffer.byteLength(lines[i]) + 1;
		if (out.length >= maxLines || bytes + b > maxBytes) {
			truncated = true;
			break;
		}
		out.unshift(lines[i]);
		bytes += b;
	}
	return { text: out.join("\n"), truncated };
}

// ---------------------------------------------------------------- standalone file/shell tools (MCP; pi uses its own engines)

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export async function bashTool(vm, { command, timeout }, { signal, progress } = {}) {
	// Bounded tail buffer: an endless producer (`yes`) can't exhaust memory.
	const chunks = [];
	let held = 0;
	const keep = 4 * MAX_BYTES;
	const onData = (d) => {
		if (progress && lastLine(d)) progress(lastLine(d));
		chunks.push(d);
		held += d.length;
		while (held - chunks[0].length >= keep) held -= chunks.shift().length;
	};
	let r;
	try {
		r = await execRemote(vm, command, PROJECT, { onData, signal, timeout: timeout ?? 120 });
	} catch (e) {
		if (String(e.message).startsWith("timeout:")) {
			const t = truncTail(Buffer.concat(chunks).toString());
			return { text: `${t.text}\n\n[command timed out after ${timeout ?? 120}s and was killed]`, isError: true };
		}
		throw e;
	}
	const t = truncTail(Buffer.concat(chunks).toString());
	const note = t.truncated ? `[output truncated to the last ${MAX_LINES} lines / ${MAX_BYTES / 1024}KB]\n` : "";
	return { text: `${note}${t.text || "(no output)"}\n[exit ${r.exitCode}]`, isError: r.exitCode !== 0 };
}

// ---------------------------------------------------------------- background jobs (vm_jobs; same helper as `boxery run --bg`)

// core/boxery-jobs.ts runs in the VM under Node's type stripping, piped over ssh on each call.
const JOBS_SOURCE = readFileSync(new URL("./boxery-jobs.ts", import.meta.url));
// The runner it starts each job with (plain bash), sent along with every start.
const JOBS_RUNNER = readFileSync(new URL("./boxery-job-runner.sh", import.meta.url)).toString("base64");
// Probe for type stripping rather than matching versions (it arrived in 22.18 and 23.6, not 23.0).
const JOBS_NODE = `T="--experimental-strip-types --disable-warning=ExperimentalWarning --input-type=module-typescript"
node $T -e "" >/dev/null 2>&1 || { echo "boxery jobs: need Node >= 22.18 in the VM (found: $(node -v 2>/dev/null || echo none))" >&2; exit 1; }
BOXERY_CALLER=$PPID exec node $T -`;
export const VALID_JOB = /^job-[a-z0-9-]{1,36}$/;
const b64 = (s) => Buffer.from(s).toString("base64");

/** Run the helper; args must be validated (ids, numbers) or base64. Resolves {code, stdout, stderr}. */
function jobsHelper(vm, args, opts = {}) {
	return sshRun(vm, `${JOBS_NODE} ${args.join(" ")}`, { ...opts, input: JOBS_SOURCE, closePipes: true });
}
const helperError = (r, signal) =>
	new Error(
		signal?.aborted
			? "aborted (the job itself was not stopped)"
			: r.stderr.trim().replace(/^boxery jobs: /, "") || (r.code == null ? "timed out waiting for the VM" : `job operation failed (exit ${r.code})`),
	);
async function jobsJson(vm, args, opts) {
	const r = await jobsHelper(vm, args, opts);
	const text = r.stdout.toString().trim(); // wait's heartbeat newlines are whitespace
	if (r.code !== 0 || !text) throw helperError(r, opts?.signal);
	return JSON.parse(text);
}
const int = (v, name, dflt, min, max) => {
	if (v == null) return dflt;
	if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
	return v;
};

/** Text tail of a raw byte tail: no partial leading UTF-8 character, at most MAX_BYTES once decoded. */
function boundedText(buf) {
	let start = 0;
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
	let text = buf.subarray(start).toString();
	// Invalid UTF-8 decodes to U+FFFD (3 bytes): keep a character-safe suffix, not whole lines.
	const decoded = Buffer.from(text);
	if (decoded.length <= MAX_BYTES) return { text, clipped: false };
	let cut = decoded.length - MAX_BYTES;
	while (cut < decoded.length && (decoded[cut] & 0xc0) === 0x80) cut++;
	return { text: decoded.subarray(cut).toString(), clipped: true };
}

/**
 * vm_jobs: background jobs in tmux in the VM. Cancelling or timing out a call stops observing, never
 * the job (only `kill` does). The VM side of an abandoned wait exits within ~2 s (heartbeat).
 */
export async function jobsTool(vm, { action, command, cwd, job, lines, stripAnsi, timeout, grace }, { signal } = {}) {
	assertName(vm);
	const id = () => {
		if (typeof job !== "string" || !VALID_JOB.test(job)) throw new Error("invalid job ID (see vm_jobs {action:\"list\"})");
		return job;
	};
	const opts = { signal, timeoutMs: 120_000 };
	switch (action) {
		case "start": {
			if (typeof command !== "string" || !command.trim() || command.includes("\0")) throw new Error("start requires a command");
			if (cwd != null && (typeof cwd !== "string" || cwd.includes("\0"))) throw new Error("invalid cwd");
			// A shell line, like vm_bash. The job's runner is already a login shell (profile, PATH, grants).
			const argv = b64(["bash", "-c", command].map((a) => `${a}\0`).join(""));
			const j = await jobsJson(vm, ["start", argv, cwd ? b64(cwd) : "-", JOBS_RUNNER], opts);
			const started = { id: j.id, state: j.state, cwd: j.cwd };
			return { text: JSON.stringify(started), structured: started };
		}
		case "list": {
			const jobs = (await jobsJson(vm, ["list"], opts)).map(({ argv: _a, log: _l, ...j }) => j);
			return { text: JSON.stringify(jobs), structured: { jobs } };
		}
		case "logs": {
			const n = int(lines, "lines", 200, 0, MAX_LINES);
			// The VM clips raw bytes before selecting lines or stripping ANSI: a huge log moves ≤ 50KB.
			const r = await jobsHelper(vm, ["logs", id(), "--lines", String(n), "--bytes", String(MAX_BYTES), ...(stripAnsi ? ["--strip-ansi"] : [])], { ...opts, maxBytes: 2 * MAX_BYTES });
			if (r.code !== 0) throw helperError(r, signal);
			const t = boundedText(r.stdout);
			const clipped = t.clipped || r.stderr.includes("output byte-truncated");
			return { text: `${clipped ? "[output truncated]\n" : ""}${t.text || "(no output)"}`, structured: { log: t.text, truncated: clipped } };
		}
		case "wait": {
			// MCP clients time tool calls out after a few minutes; past that, poll with repeated waits.
			const secs = int(timeout, "timeout", 60, 0, 600);
			const n = int(lines, "lines", 20, 0, MAX_LINES);
			const j = await jobsJson(vm, ["wait", id(), "--timeout", String(secs), "--output", String(n), "--exit0"], { signal, timeoutMs: (secs + 60) * 1000 });
			const { argv: _a, log: _l, output, ...rec } = j;
			const out = output ? boundedText(Buffer.from(output)).text : "";
			const tail = out ? `\n--- last ${n} lines ---\n${out}` : "";
			return { text: `${JSON.stringify(rec)}${tail}`, structured: { ...rec, ...(output != null ? { output: out } : {}) }, isError: j.state === "lost" || (j.state === "exited" && j.exit_code !== 0) };
		}
		case "kill": {
			const g = int(grace, "grace", 5, 0, 60);
			const { argv: _a, log: _l, ...j } = await jobsJson(vm, ["kill", id(), "--grace", String(g)], opts);
			return { text: JSON.stringify(j), structured: j, isError: j.state === "running" };
		}
		default:
			throw new Error(`unknown jobs action: ${action} (start | list | logs | wait | kill)`);
	}
}

export const JOBS_DESCRIPTION =
	"Background jobs in a VM for long commands (test suites, builds): tmux in the VM, so they survive disconnects and keep the real exit code. " +
	"start {command, cwd?} runs a bash command line like vm_bash (cwd default ~/project; relative paths below it) → {id}. " +
	"list → [{id, state: running|exited|lost, exit_code, started_at, ended_at, command, cwd, killed, leftover}]; leftover = it exited but left processes running. " +
	"logs {job, lines?=200, stripAnsi?} → output tail (≤ 50KB). " +
	"wait {job, timeout?=60 s (0–600; 0 = just check), lines?=20} → the job record (+ timed_out) and an output tail; a non-zero exit or a lost job is a tool error. " +
	"kill {job, grace?=5} stops it, or what it left running (SIGTERM to its process group, SIGKILL after grace). " +
	"Timeouts and cancelled calls never stop a job: start it, do other work, then wait again. Jobs have no ssh agent.";

const JOB_RECORD = {
	type: "object",
	properties: {
		id: { type: "string" },
		state: { type: "string", enum: ["running", "exited", "lost"] },
		command: { type: "string", description: "the command, shell-quoted, for display" },
		cwd: { type: "string" },
		started_at: { type: ["number", "null"], description: "Unix seconds" },
		ended_at: { type: ["number", "null"], description: "Unix seconds; null unless exited" },
		exit_code: { type: ["integer", "null"] },
		killed: { type: "boolean", description: "stopped by kill" },
		leftover: { type: "boolean", description: "exited, but processes it started are still running (kill stops them)" },
	},
};
/** vm_jobs structuredContent: start → {id, state, cwd}; list → {jobs}; logs → {log, truncated};
 *  wait → a job record + timed_out (+ output: the output tail); kill → a job record. */
export const JOBS_OUTPUT = {
	type: "object",
	properties: {
		...JOB_RECORD.properties,
		timed_out: { type: "boolean" },
		output: { type: "string", description: "wait: the last lines of output, escapes removed" },
		jobs: { type: "array", items: JOB_RECORD },
		log: { type: "string" },
		truncated: { type: "boolean" },
	},
};

export async function readTool(vm, { path: p, offset, limit }) {
	const rp = vmPath(p);
	const mime = (await sshOk(vm, `test -r ${q(rp)} || { printf 'cannot read %s\\n' ${q(rp)} >&2; exit 1; }; file --mime-type -b -- ${q(rp)}`)).toString().trim();
	if (IMAGE_TYPES.includes(mime)) {
		// downscale large images in the VM (ImageMagick) so they fit model limits
		const data = await sshOk(vm, `convert ${q(rp)} -resize '1568x1568>' png:-`);
		return { text: `${rp} (${mime}, shown as PNG)`, image: { data: data.toString("base64"), mimeType: "image/png" } };
	}
	const buf = await sshOk(vm, `[ -f ${q(rp)} ] || { printf 'not a regular file: %s\\n' ${q(rp)} >&2; exit 1; }; cat -- ${q(rp)}`, { maxBytes: 16 * 1024 * 1024, timeoutMs: 60_000 });
	const all = buf.toString("utf8").split("\n");
	const start = Math.max(1, Math.floor(offset ?? 1));
	const slice = all.slice(start - 1, limit ? start - 1 + Math.floor(limit) : undefined).join("\n");
	const t = truncHead(slice);
	let text = t.text;
	const end = start - 1 + t.shownLines;
	if (t.truncated || (limit && end < all.length)) text += `\n\n[showing lines ${start}-${end} of ${all.length}; use offset=${end + 1} to continue]`;
	return { text };
}

export async function writeTool(vm, { path: p, content }) {
	const rp = vmPath(p);
	await sshOk(vm, `f=${q(rp)}; mkdir -p "$(dirname "$f")" && cat > "$f"`, { input: content ?? "" });
	return { text: `wrote ${Buffer.byteLength(content ?? "")} bytes to ${rp}` };
}

/** Exact-text replacement; each oldText must match exactly once in the original file; edits must not overlap. */
export function applyEdits(original, edits) {
	const spans = edits.map((e, i) => {
		if (!e.oldText) throw new Error(`edits[${i}].oldText is empty`);
		const at = original.indexOf(e.oldText);
		if (at < 0) throw new Error(`edits[${i}].oldText not found`);
		if (original.indexOf(e.oldText, at + 1) >= 0) throw new Error(`edits[${i}].oldText matches more than once; add surrounding context`);
		return { at, end: at + e.oldText.length, newText: e.newText ?? "" };
	});
	spans.sort((a, b) => a.at - b.at);
	for (let i = 1; i < spans.length; i++) if (spans[i].at < spans[i - 1].end) throw new Error("edits overlap");
	let out = "";
	let pos = 0;
	for (const s of spans) {
		out += original.slice(pos, s.at) + s.newText;
		pos = s.end;
	}
	return out + original.slice(pos);
}

const atomicEditHelper = readFileSync(new URL("./atomic-edit.mjs", import.meta.url), "utf8");
const editScript = `set -e; umask 077
 d="$HOME/.boxery-edit"
 [ ! -L "$d" ]; mkdir -m 700 -p "$d"
 [ -d "$d" ] && [ -O "$d" ] && [ "$(stat -c %a "$d")" = 700 ] || { echo 'unsafe edit lock directory' >&2; exit 1; }
 l="$d/edit.lock"
 [ ! -L "$l" ] && { [ ! -e "$l" ] || [ -f "$l" ]; } || { echo 'unsafe edit lock file' >&2; exit 1; }
 exec flock -w 60 "$l" node --input-type=module -e ${q(`${atomicEditHelper}\nawait main(${applyEdits.toString()});`)}`;

export async function editTool(vm, { path: p, edits, oldText, newText }, { signal } = {}) {
	if (signal?.aborted) throw new Error("edit cancelled");
	const rp = vmPath(p);
	const list = Array.isArray(edits) && edits.length ? edits : oldText != null ? [{ oldText, newText }] : [];
	if (!list.length) throw new Error("provide edits: [{oldText, newText}]");
	const input = JSON.stringify({ path: rp, edits: list });
	if (signal?.aborted) throw new Error("edit cancelled");
	if (Buffer.byteLength(input) > 3 * 16 * 1024 * 1024) throw new Error("edit request too large");
	try {
		const result = await sshRun(vm, editScript, { input, signal, timeoutMs: 120_000, maxBytes: 64 * 1024 });
		if (signal?.aborted) throw new Error("edit cancelled");
		if (result.code !== 0) throw new Error(result.stderr.trim() || `edit interrupted (exit ${result.code})`);
		if (JSON.parse(result.stdout.toString("utf8"))?.committed !== true) throw new Error("invalid edit acknowledgement");
	} catch (cause) {
		throw new Error(`${cause.message}; commit outcome may be unknown; reread before retrying`, { cause });
	}
	return { text: `edited ${rp}: ${list.length} replacement(s)` };
}

// ---------------------------------------------------------------- copy

export async function copyTool({ from, to }, { current, localCwd = process.cwd(), signal } = {}) {
	const host = currentHost();
	const src = { host, ...parseLoc(from, current) };
	const dst = { host, ...parseLoc(to, current) };
	const localAbs = (s) => path.resolve(localCwd, String(s).replace(/^~(?=\/|$)/, homedir()));
	// Resolve BOTH endpoints and SSH profiles before creating staging directories or starting work.
	// The stream transport never consults ambient host/session state, including during cleanup.
	const endpoint = (loc) => {
		if (!loc.vm) return { path: localAbs(loc.path), label: "local" };
		assertName(loc.vm);
		if (!existsSync(loc.host.sshConf)) throw new Error(`boxery not set up (${loc.host.sshConf} missing); run: boxery setup user@host`);
		return { path: loc.path, vm: loc.vm, sshConf: loc.host.sshConf, label: `${loc.host.name}/${loc.vm}` };
	};
	const source = endpoint(src), destination = endpoint(dst);
	const bytes = await streamCopy(source, destination, { signal });
	const fmt = (l) => `${l.vm ? `${l.host.name}/${l.vm}` : "local"}:${l.vm ? l.path : localAbs(l.path)}`;
	return { text: `copied ${fmt(src)} → ${fmt(dst)} (${bytes} bytes tar)` };
}

// ---------------------------------------------------------------- computer use

// Desktop tools on a headless VM (boxery new --headless) fail with this, not with an X11 error.
const HEADLESS_EXIT = 64;
const X = `[ ! -e /etc/boxery/headless ] || exit ${HEADLESS_EXIT}; export DISPLAY=:1; `;
const headlessError = (vm) =>
	new Error(`VM "${vm}" is headless (created with --headless): it has no desktop, so screenshots, mouse/keyboard input and vm_browser don't work there. Use a desktop VM (vm_manage {action:'new'} without headless) for GUI or browser work.`);
async function desktopRun(vm, script, opts) {
	const r = await sshRun(vm, script, opts);
	if (r.code === HEADLESS_EXIT) throw headlessError(vm);
	return r;
}
async function desktopOk(vm, script, opts) {
	const r = await desktopRun(vm, script, opts);
	if (r.code !== 0) throw new Error(r.stderr.trim() || `command failed (exit ${r.code})`);
	return r.stdout;
}
const screenScale = new Map(); // screenshot px → screen px, per host+VM
const screenKey = (vm) => `${currentHost().dir}\0${vm}`;

/**
 * Screenshot of the VM's desktop, downscaled to maxWidth (model image limits; clicks scale back).
 * jpeg is for the live view (frames many times smaller); `size` gives shot and screen dimensions.
 */
export async function screenshot(vm, maxWidth = 1280, { jpeg = false } = {}) {
	// geometry on stderr, image on stdout
	const out = jpeg ? "-quality 70 jpeg:-" : "png:-";
	const r = await desktopRun(vm, `${X}xdotool getdisplaygeometry >&2; import -window root -resize '${maxWidth}x>' ${out}`, { timeoutMs: 30_000 });
	if (r.code !== 0) throw new Error(r.stderr.trim() || "screenshot failed");
	// Find the "W H" line: X11 warnings can come first while the desktop starts. Without it there is
	// no scale for clicks, so fail rather than return a NaN-sized shot.
	const geometry = r.stderr.toString().match(/^(\d+) (\d+)$/m);
	if (!geometry) {
		const why = r.stderr.toString().trim().split("\n")[0];
		throw new Error(`VM "${vm}": desktop not ready, couldn't read the screen size${why ? ` (${why})` : ""}. If the VM just started, try again in a few seconds.`);
	}
	const [sw, sh] = [Number(geometry[1]), Number(geometry[2])];
	const shotW = Math.min(sw, maxWidth);
	const scale = sw / shotW;
	const shotH = Math.round(sh / scale);
	screenScale.set(screenKey(vm), scale);
	return {
		text: `Screen of VM "${vm}": ${sw}x${sh}, shown at ${shotW}x${shotH}. Use coordinates in this screenshot's pixels.`,
		image: { data: r.stdout.toString("base64"), mimeType: jpeg ? "image/jpeg" : "image/png" },
		size: { width: shotW, height: shotH, screenWidth: sw, screenHeight: sh },
	};
}

const toScreen = (vm, n) => Math.round(Number(n) * (screenScale.get(screenKey(vm)) ?? 1600 / 1280));

async function after(vm, msg, want) {
	if (want === false) return { text: msg };
	await sleep(500);
	const s = await screenshot(vm);
	return { text: `${msg}\n${s.text}`, image: s.image };
}

export async function click(vm, { x, y, button, double, screenshot: shot }) {
	const b = { left: 1, middle: 2, right: 3 }[button ?? "left"] ?? 1;
	await desktopOk(vm, `${X}xdotool mousemove ${toScreen(vm, x)} ${toScreen(vm, y)} click ${double ? "--repeat 2 " : ""}${b}`);
	return after(vm, `clicked ${button ?? "left"} at (${x}, ${y})`, shot);
}

export async function typeText(vm, { text, screenshot: shot }) {
	await desktopOk(vm, `${X}xdotool type --clearmodifiers --delay 8 --file -`, { input: String(text) });
	return after(vm, `typed ${String(text).length} chars`, shot);
}

export async function pressKeys(vm, { keys, screenshot: shot }) {
	const list = String(keys).trim().split(/\s+/);
	if (!list.every((k) => /^[A-Za-z0-9_+\-]+$/.test(k))) throw new Error(`invalid key spec: ${keys}`);
	await desktopOk(vm, `${X}xdotool key --clearmodifiers -- ${list.join(" ")}`);
	return after(vm, `pressed ${list.join(" ")}`, shot);
}

export async function scroll(vm, { x, y, direction, amount, screenshot: shot }) {
	const btn = { up: 4, down: 5, left: 6, right: 7 }[direction];
	if (!btn) throw new Error("direction must be up, down, left or right");
	const n = Math.max(1, Math.min(50, Math.floor(amount ?? 5)));
	await desktopOk(vm, `${X}xdotool mousemove ${toScreen(vm, x)} ${toScreen(vm, y)} click --repeat ${n} ${btn}`);
	return after(vm, `scrolled ${direction} x${n}`, shot);
}

export async function browser(vm, { code, screenshot: shot, timeout }, { signal } = {}) {
	const program = `
const { chromium } = await import(process.env.BOXERY_PW);
const out = (o) => process.stdout.write('\\n__BOXERY__' + JSON.stringify(o) + '\\n');
try {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:${CDP_PORT}');
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = context.pages().filter((pg) => !pg.url().startsWith('devtools:')).at(-1) ?? await context.newPage();
  await page.bringToFront().catch(() => {});
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const result = await new AsyncFunction('page', 'context', 'browser', ${JSON.stringify(String(code))})(page, context, browser);
  const shot = ${shot ? "(await page.screenshot()).toString('base64')" : "null"};
  out({ ok: true, result: result === undefined ? null : result, url: page.url(), shot });
} catch (e) { out({ ok: false, error: String(e && e.stack || e) }); }
process.exit(0);`;
	const script =
		`${X}if ! curl -fs -m1 127.0.0.1:${CDP_PORT}/json/version >/dev/null; then ` +
		`setsid nohup google-chrome --remote-debugging-port=${CDP_PORT} --remote-debugging-address=127.0.0.1 --user-data-dir=$HOME/.config/boxery-chrome ` +
		`--no-first-run --no-default-browser-check --password-store=basic --start-maximized about:blank >/tmp/boxery-chrome.log 2>&1 & ` +
		`for i in $(seq 75); do curl -fs -m1 127.0.0.1:${CDP_PORT}/json/version >/dev/null && break; sleep 0.2; done; fi; ` +
		`cd /opt/boxery && BOXERY_PW=/opt/boxery/node_modules/playwright-core/index.mjs exec node --input-type=module`;
	const r = await desktopRun(vm, script, { input: program, signal, timeoutMs: (timeout ?? 60) * 1000 });
	const m = r.stdout.toString().match(/__BOXERY__(.*)\n?$/s);
	if (!m) throw new Error(`browser script produced no result (exit ${r.code}): ${r.stderr.slice(-2000)}`);
	const res = JSON.parse(m[1]);
	if (!res.ok) throw new Error(res.error);
	return {
		text: truncHead(`url: ${res.url}\nresult: ${JSON.stringify(res.result, null, 2)}`).text,
		image: res.shot ? { data: res.shot, mimeType: "image/png" } : undefined,
	};
}

// ---------------------------------------------------------------- lifecycle

/** Run a controller command with --json and parse its stdout (stderr is diagnostics only). */
export function boxeryJson(args, timeoutMs = 60_000) {
	const command = controllerCommand([...args, "--json"]);
	return new Promise((resolve, reject) => {
		execFile(BOXERY, command.args, { env: command.env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (e, stdout, stderr) => {
			if (e) return reject(new Error(`boxery ${args.join(" ")} --json: ${(stderr || e.message).trim()}`));
			try {
				resolve(JSON.parse(stdout));
			} catch {
				reject(new Error(`boxery ${args.join(" ")} --json: not JSON: ${stdout.slice(0, 200)}`));
			}
		});
	});
}

/** VMs on the host: [{name, state, ssh_addr, disk_size, disk_used, tunnel, lease, shape, cpus, mem, desktop, grants}]
 *  (fields: docs/cli.md). ssh_addr is "HOST:PORT" as the host reaches the VM; disk_size and disk_used are GiB. */
export const listVms = () => boxeryJson(["ls"]);

/** VM sizes defined on the host: {default, shapes: {NAME: {cpus, mem, disk}}} (docs/shapes.md). */
export const listShapes = () => boxeryJson(["shapes"]);

/** Snapshots of VM NAME: [{name, created, size}] (docs/cli.md). */
export const listSnaps = (name) => boxeryJson(["snaps", assertName(name)]);

/** Controller and host versions: {controller: {version, describe}, host: {name, version, describe, install} | null, behind}. */
export const versions = () => boxeryJson(["version"]);

export function formatVersions({ controller, host, behind }) {
	const v = (x) => `${x.version}${x.describe && x.describe !== x.version ? ` (${x.describe})` : ""}`;
	const upgrade = host?.name && host.name !== "legacy" ? `boxery --host ${host.name} upgrade-host` : "boxery upgrade-host";
	const lines = [`controller: ${v(controller)}`, host ? `host ${host.name}: ${v(host)} (${host.install} install)` : "host: unknown (it predates boxery-host version)"];
	if (behind) lines.push(`The host is older than the controller. Tell the user; they can upgrade it with: ${host ? upgrade : "a manual update (git pull or npm update -g boxery-vm, then boxery-host init) on the host"}`);
	return lines.join("\n");
}

export function formatSnaps(name, snaps) {
	if (!snaps.length) return `no snapshots of ${name}`;
	return snaps.map((s) => `${s.name}\t${s.created ?? "-"}\t${s.size ?? "-"}`).join("\n");
}

export function assertShape(s) {
	if (typeof s !== "string" || !/^[a-z][a-z0-9-]{0,30}$/.test(s)) throw new Error(`invalid shape name: ${s}`);
	return s;
}

export function formatShapes({ default: def, shapes }) {
	const rows = [["SHAPE", "CPUS", "MEM", "DISK"], ...Object.entries(shapes).map(([n, s]) => [n + (n === def ? " (default)" : ""), String(s.cpus), `${s.mem / 1024} GiB`, `${s.disk} GiB`])];
	const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
	return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ")).join("\n");
}

const fmtGrant = (g) => (g.kind === "env" ? `env:${g.var}` : g.kind === "file" ? `file:${g.remote}` : g.kind === "http" ? `http:${g.host}` : g.kind);

// The VM's ssh endpoint from the host (HOST:PORT). A running VM whose tunnel isn't up (exe.dev) shows why
// instead. `addr`: hosts from before ssh_addr.
const fmtAddr = (v) => (v.state === "running" && v.tunnel != null && v.tunnel !== "up" ? `tunnel ${v.tunnel}` : (v.ssh_addr ?? v.addr ?? "-"));
// USED/SIZE in GiB ("0.5/40GiB"), or only the size when the backend can't tell what's used.
const fmtDisk = (v) => (v.disk_size == null && v.disk_used == null ? "-"
	: `${v.disk_used == null ? "" : `${v.disk_used.toFixed(1)}/`}${v.disk_size ?? "?"}GiB`);

/** Human-readable table for tools and /vm ls. */
export function formatVms(vms) {
	if (!vms.length) return "(no VMs)";
	const kind = (v) => (v.desktop === false ? "headless" : "desktop"); // no field: a host from before headless VMs
	const lease = (v) => v.lease?.state?.toLowerCase() ?? "-"; // hosts from before lowercase lease states
	const rows = [["NAME", "STATE", "SSH", "DISK", "SHAPE", "KIND", "LEASE", "GRANTS"], ...vms.map((v) => [v.name, v.state ?? "-", fmtAddr(v), fmtDisk(v), v.shape ?? "-", kind(v), lease(v), (v.grants ?? []).map(fmtGrant).join(",") || "-"])];
	const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
	return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : String(c).padEnd(w[i]))).join("  ")).join("\n");
}

export function formatGrants(name, grants) {
	if (!grants.length) return `no grants for ${name}`;
	const line = (g) =>
		g.kind === "ssh-agent"
			? "ssh-agent   forward the user's local ssh agent"
			: g.kind === "env"
				? `env:${g.var}${g.cmd ? `   (from: ${g.cmd})` : ""}`
				: g.kind === "http"
					? `http:${g.host}   (${g.auth}${g.readonly ? ", read-only" : ""}; injected by the host proxy, never in the VM)`
					: `file:${g.local} → ${g.remote}`;
	return [`grants for ${name}:`, ...grants.map((g) => `  ${line(g)}`)].join("\n");
}

export async function vmExists(name) {
	return (await listVms()).some((v) => v.name === name);
}

/** Make sure VM `name` exists (create it if not) and answers over ssh. */
export async function ensureVm(name, notify = () => {}) {
	assertName(name);
	if (!(await vmExists(name))) {
		notify(`boxery: creating VM "${name}" (~15s)…`);
		await boxeryCli(["new", name]);
	}
	await sshOk(name, "true", { timeoutMs: 30_000 });
}

/** The VM a vm_manage action `a` acts on: `a.vm`, which it must name. */
export function needVm(a) {
	if (a.vm == null || a.vm === "") throw new Error(`${a.action} needs \`vm\`, the VM to act on`);
	return assertName(a.vm);
}

/** vm_manage actions that don't touch "current VM" state (callers handle use/none). opts.progress: see boxeryCli. */
export async function manage(a, opts = {}) {
	const { action, vm, snapshot, to, shape, from, cpus, mem, disk, headless } = a;
	const need = () => needVm(a);
	const sizeArgs = () =>
		Object.entries({ cpus, mem, disk }).flatMap(([k, v]) => {
			if (v == null) return [];
			if (!Number.isSafeInteger(v) || v < 1) throw new Error(`${k} must be a positive integer`);
			return [`--${k}`, String(v)];
		});
	const shapeArgs = () => [...(shape == null || shape === "" ? [] : ["--shape", assertShape(shape)]), ...sizeArgs()];
	switch (action) {
		case "fork": {
			// to: one name or a list; default one fresh name. Returns "NAME ADDR" per fork.
			const dsts = (Array.isArray(to) ? to : to ? [to] : [newName()]).map((n) => assertName(n));
			if (dsts.length > 8) throw new Error("fork: at most 8 copies at once");
			return boxeryCli(["fork", need(), ...dsts, ...shapeArgs()], 900_000, opts);
		}
		case "new":
			return boxeryCli(["new", vm ? need() : newName(), ...shapeArgs(), ...(from ? ["--from", assertImage(from)] : []), ...(headless ? ["--headless"] : [])], undefined, opts);
		case "rm":
			return boxeryCli(["rm", need()], 120_000, opts);
		case "start":
		case "stop":
			return boxeryCli([action, need()], 300_000, opts);
		case "resize": {
			const args = sizeArgs();
			if (!args.length) throw new Error("resize needs cpus, mem and/or disk");
			return boxeryCli(["resize", need(), ...args], 600_000, opts);
		}
		case "snap":
			return boxeryCli(["snap", need(), ...(snapshot ? [assertSnap(snapshot)] : [])], 600_000, opts);
		case "revert":
			return boxeryCli(["revert", need(), assertSnap(snapshot)], 600_000, opts);
		case "snap-rm":
			return boxeryCli(["snap-rm", need(), assertSnap(snapshot)], 120_000);
		case "images":
			return boxeryCli(["images"], 60_000);
		default:
			throw new Error(`unknown action ${action}`);
	}
}

// ---------------------------------------------------------------- shared prompt text

export function guidance(current, { localToolsNote } = {}) {
	const local = localToolsNote ?? "Your other tools (shell, file read/write/edit) act on the user's LOCAL machine, not the VM. Use them only when you deliberately need something local.";
	if (!current)
		return `boxery: vm_manage creates and vm_info lists remote Linux desktop VMs; vm_bash/vm_read/vm_write/vm_edit/vm_copy and computer-use tools (vm_screenshot, vm_click, vm_type, vm_key, vm_scroll, vm_browser) operate them (pass \`vm\`, or vm_manage {action:'use'} to set a default). ${local}`;
	return [
		`The user's project work happens in a remote Linux VM named "${current}" (Ubuntu 24.04, user "agent", passwordless sudo), project directory ${PROJECT}.`,
		"Use the vm_* tools for that work: vm_bash, vm_read, vm_write, vm_edit (and vm_copy to move files between this machine and the VM).",
		local,
		"Unless it was created headless, the VM has an XFCE desktop on DISPLAY=:1 the user may be watching; GUI programs started via vm_bash appear there (start them detached: `setsid nohup prog >/dev/null 2>&1 &`). A headless VM has /etc/boxery/headless and no desktop tools.",
		"See and operate it with vm_screenshot, vm_click, vm_type, vm_key, vm_scroll (screenshot-pixel coordinates). For web pages prefer vm_browser (Playwright → Chrome on that desktop).",
		"Access the user granted this VM from their machine (ssh agent for git over ssh, env vars, files such as .env) is already set up in login shells; vm_info {action:'grants'} lists it. You cannot add grants yourself; ask the user if something is missing.",
		`Servers started in the VM are reachable from the user's machine with \`boxery forward ${current} PORT\`. vm_manage creates/removes/snapshots VMs and vm_info lists them; every vm_* tool takes an optional \`vm\`.`,
		"To try several approaches in parallel, or to keep a known-good state before something risky, use vm_manage {action:'fork', vm, to:[...]}: each copy gets the VM's disk (files, installed packages, git state; not running processes) and is a separate VM you address with `vm`. Remove copies you don't need with vm_manage {action:'rm'}.",
	].join("\n");
}

// ---------------------------------------------------------------- pool leases

export const LEASE_TTL = { min: 60, max: 28_800, default: 1800 };
function assertSeconds(what, v, min, max) {
	if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`${what} must be a whole number of seconds, ${min}–${max}`);
	return v;
}

/**
 * The pool leases one front-end session holds. Each is renewed at a third of its TTL while
 * alive(lease) says the session is still using it; otherwise it is left to expire on the host. A
 * failed renewal means the lease is gone (expired, reaped, host rebooted) and the VM may already
 * belong to someone else, so the lease is forgotten and onLost(lease, error) runs. Every lease
 * remembers the host it came from; renew/release run against that host.
 */
export class LeaseKeeper {
	constructor({ alive = () => true, onLost = () => {}, everyMs = (ttl) => Math.max(20, ttl / 3) * 1000 } = {}) {
		this.leases = new Map(); // lease id → { name, id, ttl, host, expiresAt, timer }
		this.alive = alive;
		this.onLost = onLost;
		this.everyMs = everyMs; // heartbeat interval for a TTL (tests shorten it)
	}

	/** The lease this session holds on VM `name` on `host` (default: the current host), if any. */
	find(name, host = currentHost()) {
		for (const l of this.leases.values()) if (l.name === name && l.host.name === host.name && l.host.dir === host.dir) return l;
		return null;
	}

	list() {
		return [...this.leases.values()];
	}

	async acquire({ ttl = LEASE_TTL.default, wait = 60 } = {}) {
		assertSeconds("ttl", ttl, LEASE_TTL.min, LEASE_TTL.max);
		assertSeconds("wait", wait, 0, 3600);
		const host = currentHost();
		// boxeryCli returns stdout+stderr; the machine-readable line is "NAME LEASE_ID".
		const out = await boxeryCli(["acquire", "--ttl", String(ttl), "--wait", String(wait)], (wait + 300) * 1000);
		const m = out.match(/^([a-z][a-z0-9-]{0,30}) (l-[0-9a-f]{32})$/m);
		if (!m) {
			const leaked = out.match(/l-[0-9a-f]{32}/)?.[0];
			if (leaked) await boxeryCli(["release", leaked], 180_000).catch(() => {}); // never leak a lease
			throw new Error(`unexpected acquire output: ${out.slice(0, 300)}`);
		}
		const lease = { name: m[1], id: m[2], ttl, host, expiresAt: Date.now() + ttl * 1000, timer: null };
		this.leases.set(lease.id, lease);
		this.#schedule(lease);
		return lease;
	}

	#schedule(lease) {
		clearInterval(lease.timer);
		lease.timer = setInterval(() => void this.#heartbeat(lease), this.everyMs(lease.ttl));
		lease.timer.unref?.();
	}

	async #heartbeat(lease) {
		if (!this.leases.has(lease.id) || !this.alive(lease)) return;
		try {
			await withHost(lease.host, () => this.#renew(lease, lease.ttl));
		} catch (e) {
			if (this.#forget(lease)) this.onLost(lease, e);
		}
	}

	async #renew(lease, ttl) {
		const out = await boxeryCli(["renew", lease.id, "--ttl", String(ttl)], 60_000);
		lease.ttl = ttl;
		lease.expiresAt = Date.now() + ttl * 1000;
		return out;
	}

	#forget(lease) {
		clearInterval(lease.timer);
		return this.leases.delete(lease.id);
	}

	/** Renew now (optionally with a new TTL, which later heartbeats keep). A failed renewal loses the lease. */
	async renew(name, ttl) {
		const lease = this.find(name);
		if (!lease) throw new Error(`this session holds no lease on ${name}`);
		if (ttl != null) assertSeconds("ttl", ttl, LEASE_TTL.min, LEASE_TTL.max);
		try {
			await this.#renew(lease, ttl ?? lease.ttl);
		} catch (e) {
			this.#forget(lease);
			throw new Error(`lease on ${name} is gone (${e.message}); the VM may already be reset`);
		}
		this.#schedule(lease);
		return lease;
	}

	/** Give the lease back; the host resets the VM to its clean image. */
	async release(name) {
		const lease = this.find(name);
		if (!lease) throw new Error(`this session holds no lease on ${name}`);
		this.#forget(lease);
		return boxeryCli(["release", lease.id], 180_000);
	}

	/** Release every lease (session end). Never throws: a lease the host already dropped is just forgotten. */
	async releaseAll() {
		await Promise.all(this.list().map((l) => (this.#forget(l), withHost(l.host, () => boxeryCli(["release", l.id], 180_000)).catch(() => {}))));
	}
}

export function formatLeases(leases, current) {
	if (!leases.length) return "this session holds no leases";
	const now = Date.now();
	return leases
		.map((l) => `${l.name}\t${l.id}\texpires in ${Math.max(0, Math.round((l.expiresAt - now) / 1000))}s (ttl ${l.ttl}s, renewed automatically)${l.name === current ? "\tcurrent" : ""}`)
		.join("\n");
}
