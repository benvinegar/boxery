// boxery core: VM transport and tool implementations shared by the pi extension and the MCP server.
// Plain ESM, Node >= 18, no dependencies. Talks to VMs over ssh using ~/.boxery/ssh_config
// (written by `boxery setup`), and to the VM host through the `boxery` controller CLI.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const newName = () => `pi-${randomBytes(3).toString("hex")}`;

export const VALID_SNAP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function assertSnap(s) {
	if (!s || !VALID_SNAP.test(s)) throw new Error(`invalid snapshot name "${s ?? ""}"`);
	return s;
}

export function assertName(name) {
	if (!name || !VALID_NAME.test(name)) throw new Error(`invalid VM name "${name ?? ""}"`);
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
		const onAbort = () => child.kill();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts.timeoutMs) timer = setTimeout(() => child.kill(), opts.timeoutMs);
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

export function boxeryCli(args, timeoutMs = 300_000) {
	return new Promise((resolve, reject) => {
		const command = controllerCommand(args);
		execFile(BOXERY, command.args, { env: command.env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (e, stdout, stderr) => {
			if (e) reject(new Error(`boxery ${args.join(" ")}: ${(stderr || e.message).trim()}`));
			else resolve(`${stdout}${stderr}`.trim());
		});
	});
}

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

export async function bashTool(vm, { command, timeout }, { signal } = {}) {
	// Bounded tail buffer: an endless producer (`yes`) can't exhaust memory.
	const chunks = [];
	let held = 0;
	const keep = 4 * MAX_BYTES;
	const onData = (d) => {
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

const JOB_SCRIPT = readFileSync(new URL("../controller/jobs.sh", import.meta.url));

/** Detached jobs: cancelling a tool call stops observation, never the tmux job. */
export async function jobsTool(vm, { action, command, cwd, job, lines, stripAnsi, timeout }, { signal } = {}) {
	assertName(vm);
	if (signal?.aborted) throw new Error("aborted");
	const args = [action];
	if (action === "start") {
		if (typeof command !== "string" || !command.trim() || command.includes("\0")) throw new Error("start requires a command");
		if (cwd != null && (typeof cwd !== "string" || cwd.includes("\0"))) throw new Error("invalid cwd");
		args.push(cwd ?? "", "bash", "-lc", command);
	} else if (action === "list") args.push("--json");
	else if (action === "logs" || action === "wait") {
		if (typeof job !== "string" || !/^job-[A-Za-z0-9]{12}$/.test(job)) throw new Error("invalid job ID");
		args.push(job);
		if (action === "logs") {
			if (lines != null && (!Number.isInteger(lines) || lines < 0 || lines > MAX_LINES)) throw new Error(`lines must be an integer from 0 to ${MAX_LINES}`);
			args.push("--lines", String(lines ?? 200), "--bytes", String(MAX_BYTES));
			if (stripAnsi) args.push("--strip-ansi");
		} else {
			if (timeout != null && (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)) throw new Error("timeout must be an integer from 1 to 3600 seconds");
			args.push("--json", "--timeout", String(timeout ?? 120));
		}
	} else throw new Error(`unknown jobs action: ${action}`);
	const r = await sshRun(vm, `bash -s -- ${args.map(q).join(" ")}`, {
		input: JOB_SCRIPT, signal, timeoutMs: action === "wait" ? ((timeout ?? 120) + 15) * 1000 : 120_000,
		...(action === "logs" ? { maxBytes: MAX_BYTES } : {}),
	});
	if (signal?.aborted) throw new Error("aborted (detached job was not stopped)");
	if (r.code !== 0) throw new Error(r.stderr.trim() || `job operation failed (exit ${r.code ?? "timeout"})`);
	const out = r.stdout.toString().trim();
	if (action === "start") return { text: JSON.stringify({ id: out }) };
	if (action === "logs") {
		// The guest already bounds bytes and lines; do not drop an oversized final
		// line via the shared whole-line truncator. Skip a clipped UTF-8 prefix.
		let start = 0;
		while (start < r.stdout.length && (r.stdout[start] & 0xc0) === 0x80) start++;
		let log = r.stdout.subarray(start).toString();
		// Invalid UTF-8 decodes to replacement characters, which can expand the
		// encoded response beyond the raw guest cap. Keep a character-safe suffix,
		// not whole lines: a single huge line can still have a useful ending.
		const decoded = Buffer.from(log);
		const responseTruncated = decoded.length > MAX_BYTES;
		if (responseTruncated) {
			let cut = decoded.length - MAX_BYTES;
			while (cut < decoded.length && (decoded[cut] & 0xc0) === 0x80) cut++;
			log = decoded.subarray(cut).toString();
		}
		const truncated = responseTruncated || r.stderr.includes("boxery jobs: output byte-truncated");
		return { text: `${truncated ? "[output truncated]\n" : ""}${log || "(no output)"}` };
	}
	if (action === "wait") {
		const result = JSON.parse(out);
		if (result.state === "running") result.timed_out = true;
		return { text: JSON.stringify(result), isError: result.state === "lost" || (result.state === "completed" && result.exit_code !== 0) };
	}
	return { text: out };
}

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

export async function editTool(vm, { path: p, edits, oldText, newText }) {
	const rp = vmPath(p);
	const list = Array.isArray(edits) && edits.length ? edits : oldText != null ? [{ oldText, newText }] : [];
	if (!list.length) throw new Error("provide edits: [{oldText, newText}]");
	const original = (await sshOk(vm, `test -w ${q(rp)} || { printf 'cannot write %s\\n' ${q(rp)} >&2; exit 1; }; cat -- ${q(rp)}`)).toString("utf8");
	const updated = applyEdits(original, list);
	await sshOk(vm, `cat > ${q(rp)}`, { input: updated });
	return { text: `edited ${rp}: ${list.length} replacement(s)` };
}

// ---------------------------------------------------------------- copy

export async function copyTool({ from, to }, { current, localCwd = process.cwd(), signal } = {}) {
	const host = currentHost();
	const src = { host, ...parseLoc(from, current) };
	const dst = { host, ...parseLoc(to, current) };
	const localAbs = (s) => path.resolve(localCwd, String(s).replace(/^~(?=\/|$)/, homedir()));
	let tarball;
	if (src.vm) {
		tarball = await withHost(src.host, () => sshOk(src.vm, `s=${q(src.path)}; cd "$(dirname "$s")" && tar -cf - -- "$(basename "$s")"`, { signal }));
	} else {
		const abs = localAbs(src.path);
		tarball = await new Promise((res, rej) =>
			execFile("tar", ["-cf", "-", "-C", path.dirname(abs), "--", path.basename(abs)], {
				encoding: "buffer",
				maxBuffer: 1 << 30,
				// BSD tar packages Mac extended attributes as ._* files, which Linux tar leaves behind.
				// These can even look like corrupt Git pack indexes. Transfer contents, not Mac metadata.
				env: { ...process.env, COPYFILE_DISABLE: "1" },
			}, (e, out) => e ? rej(e) : res(out)),
		);
	}
	const srcBase = path.posix.basename(src.vm ? src.path : localAbs(src.path));
	if (dst.vm) {
		await withHost(dst.host, () => sshOk(
			dst.vm,
			`set -e; d=${q(dst.path)}; t=$(mktemp -d); trap 'rm -rf "$t"' EXIT; tar -xf - -C "$t"; if [ -d "$d" ]; then cp -a "$t"/. "$d"/; else mkdir -p "$(dirname "$d")"; mv "$t"/${q(srcBase)} "$d"; fi`,
			{ input: tarball, signal },
		));
	} else {
		const d = localAbs(dst.path);
		const tmp = path.join(path.dirname(d), `.boxery-copy-${randomBytes(4).toString("hex")}`);
		await mkdir(tmp, { recursive: true });
		await new Promise((res, rej) => {
			const c = spawn("tar", ["-xf", "-", "-C", tmp]);
			c.on("error", rej);
			c.stdin.on("error", () => {});
			c.on("close", (code) => (code === 0 ? res() : rej(new Error(`tar exit ${code}`))));
			c.stdin.end(tarball);
		});
		await new Promise((res, rej) =>
			execFile("sh", ["-c", 'trap \'rm -rf "$1"\' EXIT; set -e; if [ -d "$2" ]; then cp -a "$1"/. "$2"/; else mv "$1"/"$3" "$2"; fi', "sh", tmp, d, srcBase], (e) =>
				e ? rej(e) : res(),
			),
		);
	}
	const fmt = (l) => `${l.vm ? `${l.host.name}/${l.vm}` : "local"}:${l.vm ? l.path : localAbs(l.path)}`;
	return { text: `copied ${fmt(src)} → ${fmt(dst)} (${tarball.length} bytes tar)` };
}

// ---------------------------------------------------------------- computer use

const X = "export DISPLAY=:1; ";
const screenScale = new Map(); // screenshot px → screen px, per host+VM
const screenKey = (vm) => `${currentHost().dir}\0${vm}`;

export async function screenshot(vm, maxWidth = 1280) {
	// geometry on stderr, PNG on stdout (downscaled for model image limits; clicks scale back)
	const r = await sshRun(vm, `${X}xdotool getdisplaygeometry >&2; import -window root -resize '${maxWidth}x>' png:-`, { timeoutMs: 30_000 });
	if (r.code !== 0) throw new Error(r.stderr.trim() || "screenshot failed");
	const [sw, sh] = r.stderr.trim().split(/\s+/).map(Number);
	const shotW = Math.min(sw, maxWidth);
	const scale = sw / shotW;
	screenScale.set(screenKey(vm), scale);
	return {
		text: `Screen of VM "${vm}": ${sw}x${sh}, shown at ${shotW}x${Math.round(sh / scale)}. Use coordinates in this screenshot's pixels.`,
		image: { data: r.stdout.toString("base64"), mimeType: "image/png" },
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
	await sshOk(vm, `${X}xdotool mousemove ${toScreen(vm, x)} ${toScreen(vm, y)} click ${double ? "--repeat 2 " : ""}${b}`);
	return after(vm, `clicked ${button ?? "left"} at (${x}, ${y})`, shot);
}

export async function typeText(vm, { text, screenshot: shot }) {
	await sshOk(vm, `${X}xdotool type --clearmodifiers --delay 8 --file -`, { input: String(text) });
	return after(vm, `typed ${String(text).length} chars`, shot);
}

export async function pressKeys(vm, { keys, screenshot: shot }) {
	const list = String(keys).trim().split(/\s+/);
	if (!list.every((k) => /^[A-Za-z0-9_+\-]+$/.test(k))) throw new Error(`invalid key spec: ${keys}`);
	await sshOk(vm, `${X}xdotool key --clearmodifiers -- ${list.join(" ")}`);
	return after(vm, `pressed ${list.join(" ")}`, shot);
}

export async function scroll(vm, { x, y, direction, amount, screenshot: shot }) {
	const btn = { up: 4, down: 5, left: 6, right: 7 }[direction];
	if (!btn) throw new Error("direction must be up, down, left or right");
	const n = Math.max(1, Math.min(50, Math.floor(amount ?? 5)));
	await sshOk(vm, `${X}xdotool mousemove ${toScreen(vm, x)} ${toScreen(vm, y)} click --repeat ${n} ${btn}`);
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
		`P=/opt/boxery; [ -d $P ] || P=/opt/agentvm; cd $P && BOXERY_PW=$P/node_modules/playwright-core/index.mjs exec node --input-type=module`; // /opt/agentvm: images built before the rename
	const r = await sshRun(vm, script, { input: program, signal, timeoutMs: (timeout ?? 60) * 1000 });
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

/** VMs on the host: [{name, state, addr, disk, lease, grants}] (fields: docs/cli.md). */
export const listVms = () => boxeryJson(["ls"]);

const fmtGrant = (g) => (g.kind === "env" ? `env:${g.var}` : g.kind === "file" ? `file:${g.remote}` : g.kind === "http" ? `http:${g.host}` : g.kind);

/** Human-readable table for tools and /vm ls. */
export function formatVms(vms) {
	if (!vms.length) return "(no VMs)";
	const rows = [["NAME", "STATE", "ADDR", "LEASE", "GRANTS"], ...vms.map((v) => [v.name, v.state ?? "-", v.addr ?? "-", v.lease?.state ?? "-", (v.grants ?? []).map(fmtGrant).join(",") || "-"])];
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

/** vm_manage actions that don't touch "current VM" state (callers handle use/none). */
export async function manage({ action, name, snapshot, to }) {
	const need = () => assertName(name);
	switch (action) {
		case "fork": {
			// to: one name or a list; default one fresh name. Returns "NAME ADDR" per fork.
			const dsts = (Array.isArray(to) ? to : to ? [to] : [newName()]).map((n) => assertName(n));
			if (dsts.length > 8) throw new Error("fork: at most 8 copies at once");
			return boxeryCli(["fork", need(), ...dsts], 900_000);
		}
		case "snaps":
			return boxeryCli(["snaps", need()], 60_000);
		case "list":
			return formatVms(await listVms());
		case "new":
			return boxeryCli(["new", name ? need() : newName()]);
		case "rm":
			return boxeryCli(["rm", need()], 120_000);
		case "snap":
			return boxeryCli(["snap", need(), ...(snapshot ? [assertSnap(snapshot)] : [])], 600_000);
		case "revert":
			return boxeryCli(["revert", need(), assertSnap(snapshot)], 600_000);
		case "grants":
			return formatGrants(name, await boxeryJson(["grants", need()]));
		default:
			throw new Error(`unknown action ${action}`);
	}
}

// ---------------------------------------------------------------- shared prompt text

export function guidance(current, { localToolsNote } = {}) {
	const local = localToolsNote ?? "Your other tools (shell, file read/write/edit) act on the user's LOCAL machine, not the VM. Use them only when you deliberately need something local.";
	if (!current)
		return `boxery: vm_manage lists and creates remote Linux desktop VMs; vm_bash/vm_read/vm_write/vm_edit/vm_copy and computer-use tools (vm_screenshot, vm_click, vm_type, vm_key, vm_scroll, vm_browser) operate them (pass \`vm\`, or vm_manage {action:'use'} to set a default). ${local}`;
	return [
		`The user's project work happens in a remote Linux VM named "${current}" (Ubuntu 24.04, user "agent", passwordless sudo), project directory ${PROJECT}.`,
		"Use the vm_* tools for that work: vm_bash, vm_read, vm_write, vm_edit (and vm_copy to move files between this machine and the VM).",
		local,
		"The VM has an XFCE desktop on DISPLAY=:1 the user may be watching; GUI programs started via vm_bash appear there (start them detached: `setsid nohup prog >/dev/null 2>&1 &`).",
		"See and operate it with vm_screenshot, vm_click, vm_type, vm_key, vm_scroll (screenshot-pixel coordinates). For web pages prefer vm_browser (Playwright → Chrome on that desktop).",
		"Access the user granted this VM from their machine (ssh agent for git over ssh, env vars, files such as .env) is already set up in login shells; vm_manage {action:'grants'} lists it. You cannot add grants yourself; ask the user if something is missing.",
		`Servers started in the VM are reachable from the user's machine with \`boxery forward ${current} PORT\`. vm_manage lists/creates/removes/snapshots VMs; every vm_* tool takes an optional \`vm\`.`,
		"To try several approaches in parallel, or to keep a known-good state before something risky, use vm_manage {action:'fork', name, to:[...]}: each copy gets the VM's disk (files, installed packages, git state; not running processes) and is a separate VM you address with `vm`. Remove copies you don't need with vm_manage {action:'rm'}.",
	].join("\n");
}
