// boxery core: VM transport and tool implementations shared by the pi extension and the MCP server.
// Plain ESM, Node >= 18, no dependencies. Talks to VMs over ssh using the selected host profile's
// ssh_config (written by `boxery setup`), and to the VM host through the `boxery` controller CLI
// (leases and grants: through the shared operations in leases.mjs and grants.mjs).
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as linux from "../guests/linux.mjs";
import { q } from "./shell.mjs";
import { streamCopy } from "./copy-stream.mjs";
import { VALID_DEST, shellWord } from "./ssh-config.mjs";
import { acquireLease, releaseLease, renewLease } from "./leases.mjs";
import * as lifecycle from "./lifecycle.mjs";
import { versions as versionInfo } from "./versions.mjs";
import { parseGrantRequest, grantPrompt, grantCommand, listGrants, addGrants } from "./grants.mjs";
export { parseGrantRequest, grantPrompt, listGrants, applyGrants, revokeGrants } from "./grants.mjs";
export { requestUserGrants, prepareUserGrants, approveGrantSpecs } from "./grant-approval.mjs";
export { addGrants } from "./grants.mjs";
export { q } from "./shell.mjs";
/** @import { ChildProcessWithoutNullStreams } from "node:child_process" */
/** @import { EditRequest } from "./atomic-edit.mjs" */
/** A resolved host profile (resolveHost): frozen, and recognised again by resolveHost without a registry read. @typedef {Readonly<{ name: string, dir: string, sshConf: string }>} HostProfile */
/** A host name, a resolved profile, or nullish for the default host. @typedef {string | HostProfile | null | undefined} HostRef */
/** @typedef {(line: string) => void} Progress */
/** @typedef {{ progress?: Progress }} ProgressOpts */
/** @typedef {{ name: string, dir: string, default: boolean, destination: string | null, backend: string | null, same_as: string[] }} HostDescription */
/** @typedef {{ host?: HostProfile, vm: string | null, path: string }} Loc */
/** @typedef {{ input?: string | Buffer, signal?: AbortSignal, timeoutMs?: number, onData?: (d: Buffer) => void, maxBytes?: number, closePipes?: boolean }} SshRunOpts */
/** @typedef {{ code: number | null, stdout: Buffer, stderr: string }} SshResult */
/** @typedef {{ onData?: (d: Buffer) => void, signal?: AbortSignal, timeout?: number }} ExecRemoteOpts */
/** @typedef {{ exitCode: number | null }} ExecResult */
/** @typedef {{ data: string, mimeType: string }} ImageContent */
/** What a tool returns to the front-end: text, plus an image, MCP structuredContent and/or an error flag. @typedef {{ text: string, image?: ImageContent, structured?: Record<string, any>, isError?: boolean }} ToolResult */
/** @typedef {{ signal?: AbortSignal }} SignalOpts */
/** @typedef {{ signal?: AbortSignal, progress?: Progress }} BashToolOpts */
/** @typedef {{ action?: string, command?: string, cwd?: string, job?: string, lines?: number, stripAnsi?: boolean, timeout?: number, grace?: number }} JobsParams */
/** @typedef {EditRequest["edits"][number]} TextEdit */
/** local: endpoint policy for vm_copy: undefined (unrestricted), false (refused) or confined to a root. @typedef {{ root: string, deny?: string[] }} LocalConfinement */
/** A resolved vm_copy endpoint as streamCopy takes it. @typedef {{ path: string, label: string, vm?: string, sshConf?: string, confine?: (real: string) => void }} CopyEndpoint */
/** @typedef {{ current?: string | null, localCwd?: string, local?: LocalConfinement | false, signal?: AbortSignal }} CopyOpts */
/** @typedef {{ text: string, image: ImageContent, size: { width: number, height: number, screenWidth: number, screenHeight: number } }} Screenshot */
/** A grant as `boxery grants --json` lists it. @typedef {{ kind: string, var?: string, cmd?: string | null, host?: string, auth?: string, readonly?: boolean, local?: string, remote?: string, provider?: string }} Grant */
/** A validated vm_grant request (parseGrantRequest). @typedef {{ kind: "ssh-agent" | "github" | "http" | "env" | "file" | "llm", spec: string, readonly?: boolean, cmd?: string, auth?: string, host?: string, var?: string, provider?: string, local?: string, requested?: string, remote?: string }} GrantSpec */
/** vm_grant arguments. @typedef {{ spec?: unknown, readonly?: boolean, reason?: unknown }} GrantRequestArgs */
/** @typedef {"accept" | "decline" | "cancel"} ApprovalAnswer */
/** @typedef {(message: string) => Promise<ApprovalAnswer | string>} Approve */
/** A VM as `boxery ls --json` lists it (docs/cli.md); `addr` is from hosts before ssh_addr. @typedef {{ name: string, state?: string | null, ssh_addr?: string | null, addr?: string | null, disk_size?: number | null, disk_used?: number | null, tunnel?: string | null, lease?: { state?: string, [k: string]: any } | null, shape?: string | null, cpus?: number | null, mem?: number | null, desktop?: boolean, os?: string, grants?: Grant[], guest?: GuestInfo }} VmInfo */
/** Guest software status from the host's build records (docs/cli.md, `guest`). @typedef {{ status: string, reasons?: string[], built_at?: string | null, age_days?: number | null, [k: string]: any }} GuestInfo */
/** @typedef {{ cpus: number, mem: number, disk: number }} Shape */
/** @typedef {{ default?: string, shapes: Record<string, Shape> }} Shapes */
/** @typedef {{ name: string, created?: string | null, size?: string | number | null, age_days?: number | null, guest?: GuestInfo }} SnapInfo */
/** @typedef {{ image: string, created?: string | null, size?: string | number | null, age_days?: number | null, guest?: GuestInfo }} ImageInfo */
/** @typedef {{ version: string, describe?: string }} VersionInfo */
/** @typedef {{ controller: VersionInfo, host: (VersionInfo & { name: string, install: string }) | null, behind?: boolean }} Versions */
/** vm_manage arguments. @typedef {{ action?: string, vm?: string | null, snapshot?: string, to?: string | string[], shape?: string | null, from?: string, cpus?: number, mem?: number, disk?: number, headless?: boolean, [k: string]: unknown }} ManageArgs */
/** A pool lease held by a LeaseKeeper. @typedef {{ name: string, id: string, ttl: number, host: HostProfile, expiresAt: number, timer: NodeJS.Timeout | null }} Lease */
/** @typedef {{ alive?: (lease: Lease) => boolean, onLost?: (lease: Lease, error: unknown) => void, everyMs?: (ttl: number) => number }} LeaseKeeperOpts */

export const BOXERY_HOME = path.resolve(process.env.BOXERY_HOME ?? path.join(homedir(), ".boxery"));
// A context is resolved once at a call boundary, then inherited by all nested async work.
const hostContext = /** @type {AsyncLocalStorage<HostProfile>} */ (new AsyncLocalStorage());
/** @type {WeakSet<object>} */
const resolvedHosts = new WeakSet();
/** @type {HostProfile | undefined} */
let implicitHost; // Existing callers (pi) keep a stable default for this process.
export const VALID_HOST = /^[a-z][a-z0-9-]{0,30}$/;
/** @param {unknown} name */
export function assertHost(name) {
	if (typeof name !== "string" || name !== name.trim() || !VALID_HOST.test(name)) throw new Error(`invalid host name "${name ?? ""}"`);
	return name;
}
/** @param {string} file @returns {string | null} */
function registryLine(file, optional = false) {
	let fd, text;
	try {
		// Validate and read the same object. No-follow prevents a replacement symlink from
		// changing the target; nonblocking lets fstat reject a replacement FIFO without hanging.
		fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
		if (!fstatSync(fd).isFile()) throw new Error("expected a readable regular file, not symlink");
		text = readFileSync(fd, "utf8");
	} catch (e) {
		if (optional && /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
		throw new Error(`invalid registry file: ${file} (${/** @type {Error} */ (e).message})`);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	if (text.length < 2 || text.includes("\0") || !text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) throw new Error(`invalid registry file: ${file}`);
	return text.slice(0, -1);
}
/** @param {HostRef} [host] @returns {HostProfile} */
export function resolveHost(host) {
	if (host && typeof host === "object" && resolvedHosts.has(host)) return host;
	const name = /** @type {string | null} */ (host ?? defaultHost()); // an unregistered object fails assertHost
	if (name == null) throw new Error("no boxery host configured; run: boxery setup user@host|local");
	assertHost(name);
	const dir = registryLine(path.join(BOXERY_HOME, "host-registry", name), true);
	if (dir == null) throw new Error(`unknown host: ${name}`);
	return profileFromDirectory(name, dir);
}
/** Internal CLI bridge: use the exact trusted profile already selected by Bash, not today's registry.
 * This factory is not exposed through agent tool arguments. @param {string} name @param {string} dir
 * @returns {HostProfile}
 */
export function profileFromDirectory(name, dir) {
	assertHost(name);
	if (!path.isAbsolute(dir) || /[\r\n\t\0]/.test(dir)) throw new Error(`invalid profile directory for ${name}`);
	if (!["config", "ssh_config"].every((f) => existsSync(path.join(dir, f)))) throw new Error(`incomplete profile: ${name}`);
	const resolved = Object.freeze({ name, dir, sshConf: path.join(dir, "ssh_config") });
	resolvedHosts.add(resolved);
	return resolved;
}
/** The default host's name (BOXERY_HOME/default-host), or null when none is selected. */
export const defaultHost = () => registryLine(path.join(BOXERY_HOME, "default-host"), true);
/** @returns {HostProfile} */
export const currentHost = () => hostContext.getStore() ?? (implicitHost ??= resolveHost());
/** @template T @param {HostRef} host @param {() => T} fn @returns {T} */
export const withHost = (host, fn) => hostContext.run(resolveHost(host), fn);
export function registeredHosts() {
	const registry = path.join(BOXERY_HOME, "host-registry");
	const names = existsSync(registry) ? readdirSync(registry).filter((n) => VALID_HOST.test(n)).sort() : [];
	return names.map(resolveHost);
}
/** Deny-directory inventory for reconciliation: retain valid pointers even to incomplete profiles.
 * Broken entries must not hide the other profiles or prevent re-applying existing grants.
 */
function registeredProfileDirs() {
	const registry = path.join(BOXERY_HOME, "host-registry");
	let names;
	try { names = readdirSync(registry); } catch { return []; }
	return names.filter((n) => VALID_HOST.test(n)).flatMap((name) => {
		try {
			const dir = registryLine(path.join(registry, name));
			return dir && path.isAbsolute(dir) && !/[\r\n\t\0]/.test(dir) ? [dir] : [];
		} catch { return []; }
	});
}
// A small regular file, or null. Nonblocking so a FIFO is rejected by fstat instead of hanging.
/** @param {string} file */
function readProfileFile(file, max = 64 * 1024) {
	let fd;
	try {
		fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
		const st = fstatSync(fd);
		return st.isFile() && st.size <= max ? readFileSync(fd, "utf8") : null;
	} catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
/** Where a profile's VM host runs: "local" (the machine running the controller), an ssh destination, or null (unset/unparsed). @param {HostRef} [host] */
export function hostDestination(host) {
	const h = resolveHost(host);
	const text = readProfileFile(path.join(h.dir, "config")) ?? "";
	const values = text.split("\n").map((l) => /^[ \t]*(?:export[ \t]+)?HOST=(.*)$/.exec(l)).filter(Boolean);
	const dest = values.length ? shellWord(/** @type {RegExpExecArray} */ (values.at(-1))[1]) : null; // the last assignment wins, as when sourced
	return dest && VALID_DEST.test(dest) ? dest : null;
}
/** The host's VM backend as recorded in the profile by `boxery setup`/`boxery backend`, or null. Never contacts the host. @param {HostRef} [host] */
export function hostBackend(host) {
	const text = readProfileFile(path.join(resolveHost(host).dir, "backend"), 64);
	const name = text?.replace(/\n$/, "");
	return name && VALID_HOST.test(name) ? name : null; // one line, like the controller's valid_vm
}
/**
 * Registered hosts with where each runs: {name, dir, default, destination, backend, same_as}. Reads only local
 * profile files (never sources them, never contacts a host). same_as names the other entries registered for
 * this profile directory: they are the same host.
 * @returns {HostDescription[]}
 */
export function describeHosts() {
	let def = null;
	try { def = resolveHost().name; } catch {}
	const real = (/** @type {string} */ d) => { try { return realpathSync(d); } catch { return path.resolve(d); } };
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
/**
 * Register a host, as `boxery host add NAME DEST [--backend B | --profile P]` does (core/registry.mjs, in
 * process; with backend, a new profile is made on DEST). Only the default key and host executable: no key,
 * host-bin or config-dir, which name local files (an imported config is shell code). Becomes the default
 * only when there is none. Nothing can be asked (ssh runs in batch mode); the answer is what setup said.
 * @param {{ name: string, dest: string, backend?: string | null, profile?: string | null }} host @param {ProgressOpts} [opts]
 * @returns {Promise<string>}
 */
export async function addHost({ name, dest, backend, profile }, { progress } = {}) {
	assertHost(name);
	if (typeof dest !== "string" || !VALID_DEST.test(dest)) throw new Error(`invalid destination "${dest ?? ""}" (local, or an ssh destination such as user@host)`);
	if (backend != null && !VALID_HOST.test(backend)) throw new Error(`invalid backend "${backend}"`);
	if (profile != null && !VALID_HOST.test(profile)) throw new Error(`invalid host profile "${profile}"`);
	const registry = await import("./registry.mjs");
	const { io, text } = registry.textIO(progress);
	try {
		await registry.withRegistryLock(() => registry.addHostLocked(name, { dest, ...(backend ? { backend } : {}), ...(profile ? { hostProfile: profile } : {}) }, io));
	} catch (e) { throw new Error([`host add ${name}: ${/** @type {Error} */ (e).message}`, text()].filter(Boolean).join("\n")); }
	return text();
}
/** Forget a host's registration, as `boxery host rm NAME` (the CLI default can't be; profile data, VMs and
 *  grants stay). @param {string} name @returns {Promise<string>} */
export async function removeHost(name) {
	assertHost(name);
	const registry = await import("./registry.mjs");
	const { io, text } = registry.textIO();
	try { await registry.withRegistryLock(async () => registry.removeHostLocked(name, io)); }
	catch (e) { throw new Error(`host rm ${name}: ${/** @type {Error} */ (e).message}`); }
	return text();
}
export const REMOTE_HOME = linux.home;
export const PROJECT = linux.project;
export const CDP_PORT = 9222;
export const VALID_NAME = /^[a-z][a-z0-9-]{0,30}$/;
export const MAX_BYTES = 50 * 1024;
export const MAX_CAPTURE = 64 * 1024 * 1024; // hard cap on bytes buffered from one remote command
export const MAX_LINES = 2000;

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
export const newName = () => `pi-${randomBytes(3).toString("hex")}`;

export const VALID_SNAP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** @param {unknown} s @returns {string} */
export function assertSnap(s) {
	if (!s || !VALID_SNAP.test(/** @type {string} */ (s))) throw new Error(`invalid snapshot name "${s ?? ""}"`);
	return /** @type {string} */ (s);
}

/** An image is a snapshot addressed host-wide: VM@SNAP. @param {unknown} s @returns {string} */
export function assertImage(s) {
	const [vm, snap, ...rest] = typeof s === "string" ? s.split("@") : [];
	if (rest.length || !vm || !VALID_NAME.test(vm) || !snap || !VALID_SNAP.test(snap)) throw new Error(`invalid image "${s ?? ""}" (use VM@SNAP)`);
	return /** @type {string} */ (s);
}

/** @param {unknown} name @returns {string} */
export function assertName(name) {
	if (typeof name !== "string" || !VALID_NAME.test(name)) throw new Error(`invalid VM name "${name ?? ""}"`);
	return name;
}

/** VM path for a model-supplied path: ~ → VM home, relative → VM project dir. @param {unknown} p */
export function vmPath(p) {
	const s = String(p ?? ".").trim() || ".";
	if (s === "~") return REMOTE_HOME;
	if (s.startsWith("~/")) return REMOTE_HOME + s.slice(1);
	return path.posix.isAbsolute(s) ? path.posix.normalize(s) : path.posix.join(PROJECT, s);
}

const hostVmLoc = (/** @type {unknown} */ spec) => {
	const m = String(spec).match(/^([^:]*\/[^:]*):(.*)$/s);
	return m && !m[1].startsWith("/") ? m : null;
};
const vmLoc = (/** @type {unknown} */ spec) => String(spec).match(/^([a-z][a-z0-9-]{0,30}|local):(.*)$/s);
/** A location with no host/vm:, vm: or local: prefix; parseLoc puts it on the current VM. */
export const isBarePath = (/** @type {unknown} */ spec) => !hostVmLoc(spec) && !vmLoc(spec);

/** Parse "host/vm:/path", "vm:/path", "local:/path" or a plain path (= current VM). @param {unknown} spec @param {string | null} [current] @returns {Loc} */
export function parseLoc(spec, current) {
	const explicit = hostVmLoc(spec);
	if (explicit) {
		const parts = explicit[1].split("/");
		if (parts.length !== 2) throw new Error(`invalid host/VM endpoint: ${spec}`);
		const host = resolveHost(parts[0]);
		return { host, vm: assertName(parts[1]), path: vmPath(explicit[2]) };
	}
	const m = vmLoc(spec);
	if (m) return m[1] === "local" ? { vm: null, path: m[2] } : { vm: m[1], path: vmPath(m[2]) };
	if (!current) throw new Error(`"${spec}" has no VM prefix and no current VM is set (use NAME:path or local:path)`);
	return { vm: current, path: vmPath(spec) };
}

// ---------------------------------------------------------------- transport

/**
 * Run a bash script in a VM. opts: { input, signal, timeoutMs, onData }.
 * Resolves { code, stdout: Buffer, stderr }. ssh exit 255 (transport failure) rejects.
 * @param {string} vm @param {string} script @param {SshRunOpts} [opts] @returns {Promise<SshResult>}
 */
export function sshRun(vm, script, opts = {}) {
	return new Promise((resolve, reject) => {
		if (!VALID_NAME.test(vm ?? "")) return reject(new Error(`invalid VM name "${vm}"`));
		const { sshConf } = currentHost();
		if (!existsSync(sshConf)) return reject(new Error(`boxery not set up (${sshConf} missing); run: boxery setup user@host`));
		// stdin is a pipe whenever it is used (opts.input != null).
		const child = /** @type {ChildProcessWithoutNullStreams} */ (spawn("ssh", ["-F", sshConf, "-o", "BatchMode=yes", `${vm}.boxery`, `bash -c ${q(script)}`], {
			stdio: [opts.input != null ? "pipe" : "ignore", "pipe", "pipe"],
		}));
		/** @type {Buffer[]} */
		const out = [];
		let err = "";
		/** @type {NodeJS.Timeout | undefined} */
		let timer;
		let size = 0;
		const cap = opts.maxBytes ?? MAX_CAPTURE;
		let overflow = false;
		child.stdout.on("data", (/** @type {Buffer} */ d) => {
			if (opts.onData) return opts.onData(d);
			size += d.length;
			if (size > cap) {
				overflow = true;
				child.kill();
				return;
			}
			out.push(d);
		});
		child.stderr.on("data", (/** @type {Buffer} */ d) => {
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

/** @param {string} vm @param {string} script @param {SshRunOpts} [opts] */
export async function sshOk(vm, script, opts = {}) {
	const r = await sshRun(vm, script, opts);
	if (r.code !== 0) throw new Error(r.stderr.trim() || `command failed (exit ${r.code})`);
	return r.stdout;
}

/** The last non-empty line of an output chunk, for progress messages. */
export const lastLine = (/** @type {unknown} */ d) => String(d).split("\n").map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 200) ?? "";

/**
 * Run a command in a VM as its own process group, so abort/timeout kill the remote job too.
 * stdin is /dev/null (tools like rg would otherwise read the ssh pipe). Local env is not forwarded.
 * Resolves { exitCode }; rejects "aborted" / "timeout:N" / transport errors.
 * @param {string} vm @param {string} command @param {string | null | undefined} cwd @param {ExecRemoteOpts} [opts] @returns {Promise<ExecResult>}
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

/** Keep the first lines/bytes (file reads). @param {string} text */
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

/** Keep the last lines/bytes (command output). @param {string} text */
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

/** @param {string} vm @param {{ command: string, timeout?: number }} params @param {BashToolOpts} [opts] @returns {Promise<ToolResult>} */
export async function bashTool(vm, { command, timeout }, { signal, progress } = {}) {
	// Bounded tail buffer: an endless producer (`yes`) can't exhaust memory.
	/** @type {Buffer[]} */
	const chunks = [];
	let held = 0;
	const keep = 4 * MAX_BYTES;
	const onData = (/** @type {Buffer} */ d) => {
		if (progress && lastLine(d)) progress(lastLine(d));
		chunks.push(d);
		held += d.length;
		while (held - chunks[0].length >= keep) held -= /** @type {Buffer} */ (chunks.shift()).length;
	};
	let r;
	try {
		r = await execRemote(vm, command, PROJECT, { onData, signal, timeout: timeout ?? 120 });
	} catch (e) {
		if (String(/** @type {Error} */ (e).message).startsWith("timeout:")) {
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
const b64 = (/** @type {string} */ s) => Buffer.from(s).toString("base64");

/** Run the helper; args must be validated (ids, numbers) or base64. Resolves {code, stdout, stderr}. @param {string} vm @param {string[]} args @param {SshRunOpts} [opts] */
function jobsHelper(vm, args, opts = {}) {
	return sshRun(vm, `${JOBS_NODE} ${args.join(" ")}`, { ...opts, input: JOBS_SOURCE, closePipes: true });
}
const helperError = (/** @type {SshResult} */ r, /** @type {AbortSignal | undefined} */ signal) =>
	new Error(
		signal?.aborted
			? "aborted (the job itself was not stopped)"
			: r.stderr.trim().replace(/^boxery jobs: /, "") || (r.code == null ? "timed out waiting for the VM" : `job operation failed (exit ${r.code})`),
	);
/** Parsed JSON from the VM helper. @param {string} vm @param {string[]} args @param {SshRunOpts} opts @returns {Promise<any>} */
async function jobsJson(vm, args, opts) {
	const r = await jobsHelper(vm, args, opts);
	const text = r.stdout.toString().trim(); // wait's heartbeat newlines are whitespace
	if (r.code !== 0 || !text) throw helperError(r, opts?.signal);
	return JSON.parse(text);
}
/** @param {unknown} v @param {string} name @param {number} dflt @param {number} min @param {number} max @returns {number} */
const int = (v, name, dflt, min, max) => {
	if (v == null) return dflt;
	if (!Number.isInteger(v) || /** @type {number} */ (v) < min || /** @type {number} */ (v) > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
	return /** @type {number} */ (v);
};

/** Text tail of a raw byte tail: no partial leading UTF-8 character, at most MAX_BYTES once decoded. @param {Buffer} buf */
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
 * @param {string} vm @param {JobsParams} params @param {SignalOpts} [opts] @returns {Promise<ToolResult>}
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
			const jobs = (await jobsJson(vm, ["list"], opts)).map((/** @type {Record<string, unknown>} */ { argv: _a, log: _l, ...j }) => j);
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

/** @param {string} vm @param {{ path?: string, offset?: number, limit?: number }} params @returns {Promise<ToolResult>} */
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

/** @param {string} vm @param {{ path?: string, content?: string }} params @returns {Promise<ToolResult>} */
export async function writeTool(vm, { path: p, content }) {
	const rp = vmPath(p);
	await sshOk(vm, `f=${q(rp)}; mkdir -p "$(dirname "$f")" && cat > "$f"`, { input: content ?? "" });
	return { text: `wrote ${Buffer.byteLength(content ?? "")} bytes to ${rp}` };
}

/** Exact-text replacement; each oldText must match exactly once in the original file; edits must not overlap. @param {string} original @param {TextEdit[]} edits */
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

/** @param {string} vm @param {{ path?: string, edits?: TextEdit[], oldText?: string, newText?: string | null }} params @param {SignalOpts} [opts] @returns {Promise<ToolResult>} */
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
		throw new Error(`${/** @type {Error} */ (cause).message}; commit outcome may be unknown; reread before retrying`, { cause });
	}
	return { text: `edited ${rp}: ${list.length} replacement(s)` };
}

// ---------------------------------------------------------------- copy

// A server that runs on the control plane (HTTP MCP) must not hand an agent that machine's files:
// boxery's state there holds every VM's proxy token, the LLM keys and the management ssh key.
export const LOCAL_COPY_DISABLED =
	"vm_copy local: endpoints are disabled on this server: it runs on the boxery control plane, and local: would be that machine's files (where boxery keeps its credentials), not yours. " +
	"Copy between VMs (NAME:/path), or ask the user to start the server with --copy-root DIR to allow local: paths inside DIR.";

export const isWithin = (/** @type {string} */ p, /** @type {string} */ dir) => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/**
 * Paths no agent request reaches (a confined local: endpoint, even inside its root; a vm_grant file):
 * boxery's own state (BOXERY_CONF and other ~/.config/boxery* profiles, BOXERY_HOME, registered
 * profile directories) and the user's keys and agent credentials (~/.ssh, ~/.gnupg, ~/.pi). Each is
 * given lexically and, when it exists, by its real path. → [{dir, keys}]: keys marks ~/.ssh and
 * ~/.gnupg, whose use ssh-agent stands in for.
 * @param {string[]} [extra] @returns {{ dir: string, keys: boolean }[]}
 */
export function deniedDirs(extra = []) {
	const home = homedir();
	const config = path.join(home, ".config");
	let profiles = /** @type {string[]} */ ([]), hosts = /** @type {string[]} */ ([]);
	try { profiles = readdirSync(config).filter((n) => n.startsWith("boxery")).map((n) => path.join(config, n)); } catch {}
	hosts = registeredProfileDirs();
	const keys = [".ssh", ".gnupg"].map((d) => ({ dir: path.join(home, d), keys: true }));
	const own = /** @type {string[]} */ ([process.env.BOXERY_CONF, path.join(config, "boxery"), ...profiles, BOXERY_HOME, ...hosts, path.join(home, ".pi"), ...extra]
		.filter(Boolean)).map((dir) => ({ dir, keys: false }));
	/** @type {Set<string>} */
	const seen = new Set();
	return [...keys, ...own].flatMap(({ dir, keys }) => {
		const p = path.resolve(dir);
		let real;
		try { real = realpathSync(p); } catch {}
		return /** @type {string[]} */ ([p, real].filter((d) => d && !seen.has(d) && seen.add(d))).map((d) => ({ dir: d, keys }));
	});
}
const copyDenied = (/** @type {string[] | undefined} */ extra) => deniedDirs(extra).map((d) => d.dir);

/** realpath of `p`, whose last components may not exist yet. A dangling symlink is refused: a write would follow it. @param {string} p @returns {string} */
function realPathAllowMissing(p) {
	/** @type {string[]} */
	const missing = [];
	for (let cur = p; ; cur = path.dirname(cur)) {
		try {
			return path.join(realpathSync(cur), ...missing.reverse());
		} catch (e) {
			if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT" || cur === path.dirname(cur)) throw e;
			let link = false;
			try { link = lstatSync(cur).isSymbolicLink(); } catch {}
			if (link) throw new Error(`${cur} is a symlink to a missing path`);
			missing.push(path.basename(cur));
		}
	}
}

/** Validate a --copy-root directory → its real path. @param {unknown} dir @param {{ deny?: string[] }} [opts] */
export function copyRoot(dir, { deny = [] } = {}) {
	if (typeof dir !== "string" || !dir) throw new Error("--copy-root needs a directory");
	let real;
	try {
		real = realpathSync(path.resolve(dir.replace(/^~(?=\/|$)/, homedir())));
	} catch {
		throw new Error(`--copy-root: no such directory: ${dir}`);
	}
	if (!statSync(real).isDirectory()) throw new Error(`--copy-root: not a directory: ${dir}`);
	if (copyDenied(deny).some((d) => isWithin(real, d))) throw new Error(`--copy-root: ${real} is inside boxery's own configuration or a key directory`);
	return real;
}

/**
 * A local: policy confined to `root` (a real directory path). check(p) takes a real path and throws
 * unless it is inside the root and neither inside nor containing a denied path.
 * @param {LocalConfinement} confinement
 */
function confineLocal({ root, deny = [] }) {
	const denied = copyDenied(deny);
	const check = (/** @type {string} */ real, shown = real) => {
		if (!isWithin(real, root)) throw new Error(`local:${shown} is outside the copy root ${root}`);
		const hit = denied.find((d) => isWithin(real, d) || isWithin(d, real));
		if (hit) throw new Error(`local:${shown} is or holds ${hit} (boxery's own configuration or keys), which vm_copy never copies`);
	};
	const resolve = (/** @type {string} */ p) => {
		if (String(p).split("/").includes("..")) throw new Error(`local:${p}: ".." is not allowed in local: paths on this server`);
		return path.resolve(root, String(p).replace(/^~(?=\/|$)/, homedir()));
	};
	return {
		root,
		check,
		// The tar producer archives a symlink named on its command line as a link, so the directory
		// it runs in must be real; the entry itself is checked by its target too.
		/** @param {string} p */
		source(p) {
			const lexical = resolve(p);
			let real, dir;
			try {
				real = realpathSync(lexical);
				dir = realpathSync(path.dirname(lexical));
			} catch {
				throw new Error(`local:${p}: no such file or directory`);
			}
			const named = path.join(dir, path.basename(lexical));
			check(named, p);
			check(real, p);
			return named;
		},
		// The destination may not exist yet; its existing part must resolve inside the root.
		/** @param {string} p @param {string} basename */
		destination(p, basename) {
			const real = realPathAllowMissing(resolve(p));
			let isDir = false;
			try { isDir = statSync(real).isDirectory(); } catch {}
			check(real, p);
			if (isDir) check(path.join(real, basename), p);
			return real;
		},
	};
}

/**
 * vm_copy. `local` limits local: endpoints: undefined (any path this process can reach; the CLI, pi
 * and stdio MCP run on the user's own machine), false (refused), or {root, deny} (confined to root:
 * realpath-checked in both directions, no "..", nothing of boxery's own or the user's keys, and VM →
 * local copies never merge into or replace an existing directory, so they can't write through a symlink).
 * @param {{ from: string, to: string }} params @param {CopyOpts} [opts] @returns {Promise<ToolResult>}
 */
export async function copyTool({ from, to }, { current, localCwd = process.cwd(), local, signal } = {}) {
	const host = currentHost();
	const src = { host, ...parseLoc(from, current) };
	const dst = { host, ...parseLoc(to, current) };
	if (local === false && (!src.vm || !dst.vm)) throw new Error(LOCAL_COPY_DISABLED);
	const confined = local ? confineLocal(local) : null;
	const localAbs = (/** @type {string} */ s) => path.resolve(localCwd, String(s).replace(/^~(?=\/|$)/, homedir()));
	// Resolve BOTH endpoints and SSH profiles before creating staging directories or starting work.
	// The stream transport never consults ambient host/session state, including during cleanup.
	/** @param {Loc & { host: HostProfile }} loc @param {string} [basename] @returns {CopyEndpoint} */
	const endpoint = (loc, basename) => {
		if (!loc.vm) {
			if (!confined) return { path: localAbs(loc.path), label: "local" };
			// Re-checked by the transport where it stages and commits (the tree may change meanwhile).
			return basename === undefined
				? { path: confined.source(loc.path), label: "local" }
				: { path: confined.destination(loc.path, basename), label: "local", confine: (/** @type {string} */ real) => confined.check(real) };
		}
		assertName(loc.vm);
		if (!existsSync(loc.host.sshConf)) throw new Error(`boxery not set up (${loc.host.sshConf} missing); run: boxery setup user@host`);
		return { path: loc.path, vm: loc.vm, sshConf: loc.host.sshConf, label: `${loc.host.name}/${loc.vm}` };
	};
	const source = endpoint(src);
	const destination = endpoint(dst, path.posix.basename(source.path));
	const bytes = await streamCopy(source, destination, { signal });
	const fmt = (/** @type {Loc & { host: HostProfile }} */ l, /** @type {CopyEndpoint} */ e) => `${l.vm ? `${l.host.name}/${l.vm}` : "local"}:${e.path}`;
	return { text: `copied ${fmt(src, source)} → ${fmt(dst, destination)} (${bytes} bytes tar)` };
}

// ---------------------------------------------------------------- computer use

// Desktop tools on a headless VM (boxery new --headless) fail with this, not with an X11 error.
const HEADLESS_EXIT = 64;
const X = `[ ! -e ${linux.configDir}/headless ] || exit ${HEADLESS_EXIT}; export DISPLAY=:1; `;
const headlessError = (/** @type {string} */ vm) =>
	new Error(`VM "${vm}" is headless (created with --headless): it has no desktop, so screenshots, mouse/keyboard input and vm_browser don't work there. Use a desktop VM (vm_manage {action:'new'} without headless) for GUI or browser work.`);
/** @param {string} vm @param {string} script @param {SshRunOpts} [opts] */
async function desktopRun(vm, script, opts) {
	const r = await sshRun(vm, script, opts);
	if (r.code === HEADLESS_EXIT) throw headlessError(vm);
	return r;
}
/** @param {string} vm @param {string} script @param {SshRunOpts} [opts] */
async function desktopOk(vm, script, opts) {
	const r = await desktopRun(vm, script, opts);
	if (r.code !== 0) throw new Error(r.stderr.trim() || `command failed (exit ${r.code})`);
	return r.stdout;
}
/** @type {Map<string, number>} */
const screenScale = new Map(); // screenshot px → screen px, per host+VM
const screenKey = (/** @type {string} */ vm) => `${currentHost().dir}\0${vm}`;

/**
 * Screenshot of the VM's desktop, downscaled to maxWidth (model image limits; clicks scale back).
 * jpeg is for the live view (frames many times smaller); `size` gives shot and screen dimensions.
 * @param {string} vm @param {number} [maxWidth] @param {{ jpeg?: boolean }} [opts] @returns {Promise<Screenshot>}
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

const toScreen = (/** @type {string} */ vm, /** @type {unknown} */ n) => Math.round(Number(n) * (screenScale.get(screenKey(vm)) ?? 1600 / 1280));

/** @param {string} vm @param {string} msg @param {boolean | undefined} want @returns {Promise<ToolResult>} */
async function after(vm, msg, want) {
	if (want === false) return { text: msg };
	await sleep(500);
	const s = await screenshot(vm);
	return { text: `${msg}\n${s.text}`, image: s.image };
}

/** @param {string} vm @param {{ x: number, y: number, button?: string, double?: boolean, screenshot?: boolean }} params */
export async function click(vm, { x, y, button, double, screenshot: shot }) {
	const b = /** @type {Record<string, number>} */ ({ left: 1, middle: 2, right: 3 })[button ?? "left"] ?? 1;
	await desktopOk(vm, `${X}xdotool mousemove ${toScreen(vm, x)} ${toScreen(vm, y)} click ${double ? "--repeat 2 " : ""}${b}`);
	return after(vm, `clicked ${button ?? "left"} at (${x}, ${y})`, shot);
}

/** @param {string} vm @param {{ text: string, screenshot?: boolean }} params */
export async function typeText(vm, { text, screenshot: shot }) {
	await desktopOk(vm, `${X}xdotool type --clearmodifiers --delay 8 --file -`, { input: String(text) });
	return after(vm, `typed ${String(text).length} chars`, shot);
}

/** @param {string} vm @param {{ keys: string, screenshot?: boolean }} params */
export async function pressKeys(vm, { keys, screenshot: shot }) {
	const list = String(keys).trim().split(/\s+/);
	if (!list.every((k) => /^[A-Za-z0-9_+\-]+$/.test(k))) throw new Error(`invalid key spec: ${keys}`);
	await desktopOk(vm, `${X}xdotool key --clearmodifiers -- ${list.join(" ")}`);
	return after(vm, `pressed ${list.join(" ")}`, shot);
}

/** @param {string} vm @param {{ x: number, y: number, direction: string, amount?: number, screenshot?: boolean }} params */
export async function scroll(vm, { x, y, direction, amount, screenshot: shot }) {
	const btn = /** @type {Record<string, number>} */ ({ up: 4, down: 5, left: 6, right: 7 })[direction];
	if (!btn) throw new Error("direction must be up, down, left or right");
	const n = Math.max(1, Math.min(50, Math.floor(amount ?? 5)));
	await desktopOk(vm, `${X}xdotool mousemove ${toScreen(vm, x)} ${toScreen(vm, y)} click --repeat ${n} ${btn}`);
	return after(vm, `scrolled ${direction} x${n}`, shot);
}

/** @param {string} vm @param {{ code: string, screenshot?: boolean, timeout?: number }} params @param {SignalOpts} [opts] @returns {Promise<ToolResult>} */
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

/** VMs on the host: [{name, state, ssh_addr, disk_size, disk_used, tunnel, lease, shape, cpus, mem, desktop, grants}]
 *  (fields: docs/cli.md). ssh_addr is "HOST:PORT" as the host reaches the VM; disk_size and disk_used are GiB. */
/** @type {() => Promise<VmInfo[]>} */
export const listVms = async () => /** @type {any} */ (await lifecycle.listVms());

/** VM sizes defined on the host: {default, shapes: {NAME: {cpus, mem, disk}}} (docs/shapes.md). */
/** @type {() => Promise<Shapes>} */
export const listShapes = () => lifecycle.hostJson(["shapes"]);
/** Selected boxery-host's report, not this controller's platform. */
export const backendCapabilities = () => lifecycle.hostJson(["capabilities"]);

/** Snapshots of VM NAME: [{name, created, size}] (docs/cli.md). */
/** @type {(name: string) => Promise<SnapInfo[]>} */
export const listSnaps = (name) => lifecycle.hostJson(["snaps", assertName(name)]);

/** Every image on the host (snapshots, addressed VM@SNAP): [{image, created, size}] (docs/cli.md). */
/** @type {() => Promise<ImageInfo[]>} */
export const listImages = () => lifecycle.hostJson(["images"]);

/** Controller and host versions: {controller: {version, describe}, host: {name, version, describe, install} | null, behind}. */
/** @type {() => Promise<Versions>} */
export const versions = async () => {
	const { controller, host, behind } = await versionInfo();
	return /** @type {Versions} */ ({ controller, host, behind });
};

/** @param {Versions} versions */
export function formatVersions({ controller, host, behind }) {
	const v = (/** @type {VersionInfo} */ x) => `${x.version}${x.describe && x.describe !== x.version ? ` (${x.describe})` : ""}`;
	let def = null;
	try { def = defaultHost(); } catch {}
	const upgrade = host?.name && host.name !== def ? `boxery --host ${host.name} upgrade-host` : "boxery upgrade-host";
	const lines = [`controller: ${v(controller)}`, host ? `host ${host.name}: ${v(host)} (${host.install} install)` : "host: unknown (it predates boxery-host version)"];
	if (behind) lines.push(`The host is older than the controller. Tell the user; they can upgrade it with: ${host ? upgrade : "a manual update (git pull or npm update -g boxery-vm, then boxery-host init) on the host"}`);
	return lines.join("\n");
}

// Age in days and the guest software an image holds (hosts from before build records send neither).
const fmtImageAge = (/** @type {SnapInfo | ImageInfo} */ s) => (s.age_days === undefined && s.guest === undefined ? ""
	: `\t${s.age_days == null ? "-" : `${s.age_days}d`}\t${s.guest?.status ?? "-"}`);

/** @param {string} name @param {SnapInfo[]} snaps */
export function formatSnaps(name, snaps) {
	if (!snaps.length) return `no snapshots of ${name}`;
	return snaps.map((s) => `${s.name}\t${s.created ?? "-"}\t${s.size ?? "-"}${fmtImageAge(s)}`).join("\n");
}

/** @param {ImageInfo[]} images */
export function formatImages(images) {
	if (!images.length) return "no images (snapshots) on the host";
	return images.map((i) => `${i.image}\t${i.created ?? "-"}\t${i.size ?? "-"}${fmtImageAge(i)}`).join("\n");
}

/** @param {unknown} s @returns {string} */
export function assertShape(s) {
	if (typeof s !== "string" || !/^[a-z][a-z0-9-]{0,30}$/.test(s)) throw new Error(`invalid shape name: ${s}`);
	return s;
}

/** @param {Shapes} shapes */
export function formatShapes({ default: def, shapes }) {
	const rows = [["SHAPE", "CPUS", "MEM", "DISK"], ...Object.entries(shapes).map(([n, s]) => [n + (n === def ? " (default)" : ""), String(s.cpus), `${s.mem / 1024} GiB`, `${s.disk} GiB`])];
	const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
	return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ")).join("\n");
}

const fmtGrant = (/** @type {Grant} */ g) => (g.kind === "env" ? `env:${g.var}` : g.kind === "file" ? `file:${g.remote}` : g.kind === "http" ? `http:${g.host}` : g.kind === "llm" ? `llm:${g.provider}` : g.kind);

// The VM's ssh endpoint from the host (HOST:PORT). A running VM whose tunnel isn't up (exe.dev) shows why
// instead. `addr`: hosts from before ssh_addr.
const fmtAddr = (/** @type {VmInfo} */ v) => (v.state === "running" && v.tunnel != null && v.tunnel !== "up" ? `tunnel ${v.tunnel}` : (v.ssh_addr ?? v.addr ?? "-"));
// USED/SIZE in GiB ("0.5/40GiB"), or only the size when the backend can't tell what's used.
const fmtDisk = (/** @type {VmInfo} */ v) => (v.disk_size == null && v.disk_used == null ? "-"
	: `${v.disk_used == null ? "" : `${v.disk_used.toFixed(1)}/`}${v.disk_size ?? "?"}GiB`);

/** Human-readable table for tools and /vm ls. @param {VmInfo[]} vms */
export function formatVms(vms) {
	if (!vms.length) return "(no VMs)";
	const kind = (/** @type {VmInfo} */ v) => (v.desktop === false ? "headless" : "desktop"); // no field: a host from before headless VMs
	const lease = (/** @type {VmInfo} */ v) => v.lease?.state?.toLowerCase() ?? "-"; // hosts from before lowercase lease states
	const guest = vms.some((v) => v.guest) ? (/** @type {VmInfo} */ v) => [v.guest?.status ?? "-"] : () => []; // hosts from before build records: no column
	const rows = [["NAME", "STATE", "SSH", "DISK", "SHAPE", "KIND", "LEASE", ...(vms.some((v) => v.guest) ? ["GUEST"] : []), "GRANTS"],
		...vms.map((v) => [v.name, v.state ?? "-", fmtAddr(v), fmtDisk(v), v.shape ?? "-", kind(v), lease(v), ...guest(v), (v.grants ?? []).map(fmtGrant).join(",") || "-"])];
	const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
	const table = rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : String(c).padEnd(w[i]))).join("  ")).join("\n");
	const outdated = vms.filter((v) => v.guest?.status === "outdated");
	if (!outdated.length) return table;
	// Patching restarts VMs and is the user's call: agents only point it out.
	return `${table}\noutdated guest software: ${outdated.map((v) => `${v.name} (${(v.guest?.reasons ?? []).join(", ")})`).join("; ")}. Tell the user; they can update it with: boxery patch NAME`;
}

/** @param {string} name @param {Grant[]} grants */
export function formatGrants(name, grants) {
	if (!grants.length) return `no grants for ${name}`;
	const line = (/** @type {Grant} */ g) =>
		g.kind === "ssh-agent"
			? "ssh-agent   forward the user's local ssh agent"
			: g.kind === "env"
				? `env:${g.var}${g.cmd ? `   (from: ${g.cmd})` : ""}`
				: g.kind === "http"
					? `http:${g.host}   (${g.auth}${g.readonly ? ", read-only" : ""}; injected by the host proxy, never in the VM)`
					: g.kind === "llm"
						? `llm:${g.provider}   the host proxy's ${g.provider} route (credential stays on the host)`
						: `file:${g.local} → ${g.remote}`;
	return [`grants for ${name}:`, ...grants.map((g) => `  ${line(g)}`)].join("\n");
}

// ---------------------------------------------------------------- grant requests (vm_grant)
//
// An agent asks; the user decides in a prompt the front-end shows (MCP elicitation, pi's confirm
// dialog), which the agent cannot answer. Only what `boxery grant` could add without a --cmd is
// requestable: a command run on the user's machine is theirs to write.

const realOr = (/** @type {string} */ p) => { try { return realpathSync(p); } catch { return p; } };
// A stored file grant counts by the file it reads now: the CLI (and older vm_grant) store paths as given.
const grantedAlready = (/** @type {GrantSpec} */ g, /** @type {Grant[]} */ grants) =>
	g.kind === "ssh-agent"
		? grants.some((x) => x.kind === "ssh-agent")
		: g.kind === "llm"
			? grants.some((x) => x.kind === "llm" && x.provider === g.provider)
			: g.kind === "env"
				? grants.some((x) => x.kind === "env" && x.var === g.var)
				: g.kind === "file"
					? grants.some((x) => x.kind === "file" && realOr(/** @type {string} */ (x.local)) === g.local && x.remote === `${REMOTE_HOME}/${g.remote}`)
					: ["github.com", "api.github.com"].every((h) => grants.some((x) => x.kind === "http" && x.host === h && (!x.readonly || g.readonly)));

/**
 * Wrap a front-end's approve(message) → "accept" | "decline" | "cancel" so a session shows one
 * grant prompt at a time; a request made while one is open fails with e.busy.
 * @template T @template R @param {(request: T) => Promise<R>} approve @returns {(request: T) => Promise<R>}
 */
export function oneAtATime(approve) {
	let open = false;
	return async (message) => {
		if (open) throw Object.assign(new Error("another grant request is waiting for the user"), { busy: true });
		open = true;
		try {
			return await approve(message);
		} finally {
			open = false;
		}
	};
}

/**
 * vm_grant: ask the user to grant VM `vm` something, then apply the shared operation in-process.
 * ctx.approve(message) shows the prompt (absent: the front-end can't prompt, so the user gets the command).
 * @param {string} vm @param {GrantRequestArgs} a @param {{ approve?: Approve, localCwd?: string, signal?: AbortSignal }} [ctx] @returns {Promise<ToolResult>}
 */
export async function grantRequest(vm, a, { approve, localCwd, signal } = {}) {
	const g = parseGrantRequest(a, { localCwd });
	const host = currentHost().name;
	const command = grantCommand("grant", vm, host, g);
	if (g.kind === "env" && process.env[/** @type {string} */ (g.var)] === undefined)
		return { text: `$${g.var} isn't set where boxery runs, so there is nothing to grant. Ask the user to grant it from a command that prints the value, e.g.:\n  ${command} --cmd '…'`, isError: true };
	if (grantedAlready(g, listGrants(vm)))
		return { text: `${vm} already has ${g.spec}; login shells (and vm_bash) have it. If it still fails, the problem is elsewhere: tell the user what you saw.` };
	const manual = `Ask the user to run this on their machine:\n  ${command}`;
	if (!approve) return { text: `This client can't show the user an approval prompt, so nothing was granted. ${manual}`, isError: true };
	let answer;
	try {
		answer = await approve(grantPrompt(vm, host, g, a.reason));
	} catch (e) {
		if (signal?.aborted) throw e;
		if (/** @type {{ busy?: boolean } | undefined} */ (e)?.busy) return { text: "Another grant request is waiting for the user's answer. Wait for it before asking again.", isError: true };
		return { text: `The approval prompt failed (${/** @type {Error | undefined} */ (e)?.message ?? e}), so nothing was granted. ${manual}`, isError: true };
	}
	if (answer !== "accept")
		return { text: `The user ${answer === "decline" ? "declined" : "dismissed"} the request; ${vm} did not get ${g.spec}. Don't ask for it again unless the user brings it up: carry on without it, or ask them how to proceed.` };
	const out = await addGrants(vm, [g], { signal });
	return { text: `The user approved: ${vm} now has ${g.spec}. New login shells (vm_bash runs one) pick it up.\n${out}` };
}

/** @param {string} name */
export async function vmExists(name) {
	return (await listVms()).some((v) => v.name === name);
}

/** Make sure VM `name` exists (create it if not) and answers over ssh. @param {string} name @param {(message: string) => void} [notify] */
export async function ensureVm(name, notify = () => {}) {
	assertName(name);
	if (!(await vmExists(name))) {
		notify(`boxery: creating VM "${name}" (~15s)…`);
		await lifecycle.newVm(name, {}, { timeout: 300_000 });
	}
	await sshOk(name, "true", { timeoutMs: 30_000 });
}

/** The VM a vm_manage action `a` acts on: `a.vm`, which it must name. @param {ManageArgs} a */
export function needVm(a) {
	if (a.vm == null || a.vm === "") throw new Error(`${a.action} needs \`vm\`, the VM to act on`);
	return assertName(a.vm);
}

/** vm_manage actions that don't touch "current VM" state (callers handle use/none). opts.progress: each line of output as it arrives. @param {ManageArgs} a @param {ProgressOpts} [opts] @returns {Promise<string>} */
export async function manage(a, opts = {}) {
	const { action, vm, snapshot, to, shape, from, cpus, mem, disk, headless } = a;
	const need = () => needVm(a);
	const size = () => {
		for (const [k, v] of Object.entries({ cpus, mem, disk })) if (v != null && (!Number.isSafeInteger(v) || v < 1)) throw new Error(`${k} must be a positive integer`);
		return { shape: shape == null || shape === "" ? null : assertShape(shape), cpus, mem, disk };
	};
	const run = progressRun(opts);
	switch (action) {
		case "fork": {
			// to: one name or a list; default one fresh name. Returns "NAME ADDR" per fork.
			const dsts = (Array.isArray(to) ? to : to ? [to] : [newName()]).map((n) => assertName(n));
			if (dsts.length > 8) throw new Error("fork: at most 8 copies at once");
			return run((o) => lifecycle.forkVm(need(), dsts, size(), o), 900_000, `fork ${need()}`);
		}
		case "new":
			{
			const name = vm ? need() : newName();
			return run((o) => lifecycle.newVm(name, { ...size(), from: from ? assertImage(from) : null, headless: !!headless }, o), 300_000, `new ${name}`);
		}
		case "rm":
			return run((o) => lifecycle.rmVm(need(), o), 120_000, `rm ${need()}`);
		case "start":
			return run((o) => lifecycle.startVm(need(), o), 300_000, `start ${need()}`);
		case "stop":
			return run((o) => lifecycle.stopVm(need(), o), 300_000, `stop ${need()}`);
		case "resize": {
			const s = size();
			if (s.cpus == null && s.mem == null && s.disk == null) throw new Error("resize needs cpus, mem and/or disk");
			return run((o) => lifecycle.resizeVm(need(), s, o), 600_000, `resize ${need()}`);
		}
		case "snap":
			return run((o) => lifecycle.snapVm(need(), snapshot ? assertSnap(snapshot) : null, o), 600_000, `snap ${need()}`);
		case "revert":
			return run((o) => lifecycle.revertVm(need(), assertSnap(snapshot), o), 600_000, `revert ${need()}`);
		case "snap-rm":
			return run((o) => lifecycle.snapRm(need(), assertSnap(snapshot), o), 120_000, `snap-rm ${need()}`);
		case "build-base":
			return run((o) => lifecycle.buildBase(o), 1_800_000, "build-base");
		default:
			throw new Error(`unknown action ${action}`);
	}
}

/** Run a lifecycle operation for a tool: what the host printed (its stdout, then its stderr, where it reports
 *  most results: "==> demo removed …") and the grant notes come back as one text, as the CLI used to give
 *  it; progress gets each line as it arrives. A failure says which operation failed, with the host's last lines.
 *  @param {ProgressOpts} opts @returns {(fn: (o: import("./lifecycle.mjs").LifecycleOpts) => Promise<string>, timeout: number, what: string) => Promise<string>} */
function progressRun({ progress } = {}) {
	return async (fn, timeout, what) => {
		/** @type {string[]} */
		const notes = [];
		/** @type {Buffer[]} */
		const errs = [];
		let errSize = 0;
		const onData = (/** @type {Buffer} */ d, /** @type {"stdout" | "stderr"} */ stream) => {
			if (stream === "stderr") { errs.push(d); errSize += d.length; while (errSize > 256 * 1024 && errs.length > 1) errSize -= /** @type {Buffer} */ (errs.shift()).length; }
			const l = progress && lastLine(d); if (l) progress?.(l);
		};
		// What a long run (build-base: download progress, backend logs) wrote is too much for a tool's answer: the
		// last 40 lines, each \r-redrawn line (progress bars) as it ended.
		const stderrText = () => Buffer.concat(errs).toString("utf8").trim().split("\n").map((l) => l.split("\r").filter(Boolean).at(-1) ?? "").slice(-40).join("\n");
		try {
			const out = await fn({ timeout, onData, log: (l) => notes.push(l) });
			return [out, stderrText(), ...notes].filter(Boolean).join("\n").trim();
		} catch (e) {
			const err = /** @type {Error & { fromHost?: boolean }} */ (e);
			const tail = (err.fromHost ? (stderrText() || err.message) : err.message).split("\n").slice(-20).join("\n");
			throw new Error([`boxery ${what}: ${tail}`, ...notes].filter(Boolean).join("\n").trim());
		}
	};
}

// ---------------------------------------------------------------- shared prompt text

/** The agent's standing instructions. host: the session's host name. @param {string | null | undefined} current @param {{ localToolsNote?: string, host?: string }} [opts] */
export function guidance(current, { localToolsNote, host } = {}) {
	const local = localToolsNote ?? "Your other tools (shell, file read/write/edit) act on the user's LOCAL machine, not the VM. Use them only when you deliberately need something local.";
	const hostLine = host ? `Current host: ${host}. VM selections belong only to that host. Every vm_* tool accepts optional host (vm_info {action:'hosts'} lists them).\n` : "";
	if (!current)
		return `${hostLine}boxery: vm_manage creates and vm_info lists remote Linux desktop VMs; vm_bash/vm_read/vm_write/vm_edit/vm_copy and computer-use tools (vm_screenshot, vm_click, vm_type, vm_key, vm_scroll, vm_browser) operate them (pass \`vm\`, or vm_manage {action:'use'} to set a default). ${local}`;
	let restricted = false;
	try { restricted = hostBackend(host) === "openshell"; } catch { /* no registered host in offline callers */ }
	if (restricted) return hostLine + [
		`Project work happens in the policy-enforced OpenShell sandbox "${current}", project directory ${PROJECT}.`,
		"Use vm_bash, vm_read, vm_write, vm_edit, vm_copy and vm_jobs. " + local,
		"This sandbox is non-root: no sudo, desktop, disk snapshots, forks, resizing or Boxery pools. System packages must be baked into its image.",
		"OpenShell manages credentials and egress policy, not Boxery grants. Policy denials are intentional: ask the user for narrowly scoped access; never bypass controls or copy credentials into the sandbox.",
	].join("\n");
	return hostLine + [
		`The user's project work happens in a remote Linux VM named "${current}" (Ubuntu 24.04, user "agent", passwordless sudo), project directory ${PROJECT}.`,
		"Use the vm_* tools for that work: vm_bash, vm_read, vm_write, vm_edit (and vm_copy to move files between this machine and the VM).",
		local,
		"Unless it was created headless, the VM has an XFCE desktop on DISPLAY=:1 the user may be watching; GUI programs started via vm_bash appear there (start them detached: `setsid nohup prog >/dev/null 2>&1 &`). A headless VM has /etc/boxery/headless and no desktop tools.",
		"See and operate it with vm_screenshot, vm_click, vm_type, vm_key, vm_scroll (screenshot-pixel coordinates). For web pages prefer vm_browser (Playwright → Chrome on that desktop).",
		"Access the user granted this VM from their machine (ssh agent for git over ssh, env vars, files such as .env) is already set up in login shells; vm_info {action:'grants'} lists it. " +
			"If something is missing (a 401 from a registry, git asking for credentials), request it with vm_grant, which asks the user. Never copy credentials into the VM with vm_copy or vm_write: they would land on its disk and in its snapshots.",
		`Servers started in the VM are reachable from the user's machine with \`boxery forward ${current} PORT\`. vm_manage creates/removes/snapshots VMs and vm_info lists them; every vm_* tool takes an optional \`vm\`.`,
		"To try several approaches in parallel, or to keep a known-good state before something risky, use vm_manage {action:'fork', vm, to:[...]}: each copy gets the VM's disk (files, installed packages, git state; not running processes) and is a separate VM you address with `vm`. Remove copies you don't need with vm_manage {action:'rm'}.",
	].join("\n");
}

// ---------------------------------------------------------------- pool leases

export const LEASE_TTL = { min: 60, max: 28_800, default: 1800 };
/** @param {string} what @param {number} v @param {number} min @param {number} max */
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
	/** @param {LeaseKeeperOpts} [opts] */
	constructor({ alive = () => true, onLost = () => {}, everyMs = (ttl) => Math.max(20, ttl / 3) * 1000 } = {}) {
		/** @type {Map<string, Lease>} */
		this.leases = new Map(); // lease id → { name, id, ttl, host, expiresAt, timer }
		this.alive = alive;
		this.onLost = onLost;
		this.everyMs = everyMs; // heartbeat interval for a TTL (tests shorten it)
	}

	/** The lease this session holds on VM `name` on `host` (default: the current host), if any. @param {string} name @returns {Lease | null} */
	find(name, host = currentHost()) {
		for (const l of this.leases.values()) if (l.name === name && l.host.name === host.name && l.host.dir === host.dir) return l;
		return null;
	}

	list() {
		return [...this.leases.values()];
	}

	/** @param {{ ttl?: number, wait?: number }} [opts] @returns {Promise<Lease>} */
	async acquire({ ttl = LEASE_TTL.default, wait = 60 } = {}) {
		assertSeconds("ttl", ttl, LEASE_TTL.min, LEASE_TTL.max);
		assertSeconds("wait", wait, 0, 3600);
		const host = currentHost();
		const r = await acquireLease({ ttl, wait });
		/** @type {Lease} */
		const lease = { name: r.name, id: r.id, ttl, host, expiresAt: Date.now() + ttl * 1000, timer: null };
		this.leases.set(lease.id, lease);
		this.#schedule(lease);
		return lease;
	}

	/** @param {Lease} lease */
	#schedule(lease) {
		clearInterval(/** @type {NodeJS.Timeout} */ (lease.timer));
		lease.timer = setInterval(() => void this.#heartbeat(lease), this.everyMs(lease.ttl));
		lease.timer.unref?.();
	}

	/** @param {Lease} lease */
	async #heartbeat(lease) {
		if (!this.leases.has(lease.id) || !this.alive(lease)) return;
		try {
			await withHost(lease.host, () => this.#renew(lease, lease.ttl));
		} catch (e) {
			if (this.#forget(lease)) this.onLost(lease, e);
		}
	}

	/** @param {Lease} lease @param {number} ttl */
	async #renew(lease, ttl) {
		const r = await renewLease(lease.id, ttl);
		lease.ttl = ttl;
		lease.expiresAt = Date.now() + ttl * 1000;
		return r;
	}

	/** @param {Lease} lease */
	#forget(lease) {
		clearInterval(/** @type {NodeJS.Timeout} */ (lease.timer));
		return this.leases.delete(lease.id);
	}

	/** Renew now (optionally with a new TTL, which later heartbeats keep). A failed renewal loses the lease. @param {string} name @param {number | null} [ttl] */
	async renew(name, ttl) {
		const lease = this.find(name);
		if (!lease) throw new Error(`this session holds no lease on ${name}`);
		if (ttl != null) assertSeconds("ttl", ttl, LEASE_TTL.min, LEASE_TTL.max);
		try {
			await this.#renew(lease, ttl ?? lease.ttl);
		} catch (e) {
			this.#forget(lease);
			throw new Error(`lease on ${name} is gone (${/** @type {Error} */ (e).message}); the VM may already be reset`);
		}
		this.#schedule(lease);
		return lease;
	}

	/** Give the lease back; the host resets the VM to its clean image. @param {string} name */
	async release(name) {
		const lease = this.find(name);
		if (!lease) throw new Error(`this session holds no lease on ${name}`);
		this.#forget(lease);
		return releaseLease(lease.id);
	}

	/** Release every lease (session end). Never throws: a lease the host already dropped is just forgotten. */
	async releaseAll() {
		await Promise.all(this.list().map((l) => (this.#forget(l), withHost(l.host, () => releaseLease(l.id)).catch(() => {}))));
	}
}

/** @param {Lease[]} leases @param {string | null} [current] */
export function formatLeases(leases, current) {
	if (!leases.length) return "this session holds no leases";
	const now = Date.now();
	return leases
		.map((l) => `${l.name}\t${l.id}\texpires in ${Math.max(0, Math.round((l.expiresAt - now) / 1000))}s (ttl ${l.ttl}s, renewed automatically)${l.name === current ? "\tcurrent" : ""}`)
		.join("\n");
}
