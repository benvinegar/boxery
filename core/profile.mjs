// A host profile from Node: its config (where boxery-host is and how to reach it), commands on that host,
// its ssh_config and shared ssh connections. The CLI's Bash equivalents are in controller/profile.sh;
// the ssh_config text and quoting are core/ssh-config.mjs, shared with it.
// (Imports boxery-core, which imports this module through leases/grants: fine while nothing here runs at load.)
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentHost } from "./boxery-core.mjs";
import { DEFAULT_HOST_BIN, checkTarget, localHostBin, parseConfig, remoteCommand, renderSshConfig } from "./ssh-config.mjs";
/** @import { HostProfile } from "./boxery-core.mjs" */
/** @import { Target } from "./ssh-config.mjs" */

const MAX_OUTPUT = 10 * 1024 * 1024;
const VALID_NAME = /^[a-z][a-z0-9-]{0,30}$/, VALID_LEASE = /^l-[0-9a-f]{32}$/;

/** A profile's target, and the environment host commands get: the caller's, or the one sourcing the
 *  config leaves exported. @typedef {Target & { env: NodeJS.ProcessEnv }} ProfileConfig */

const profileLib = fileURLToPath(new URL("../controller/profile.sh", import.meta.url));
// Exactly as the CLI loads a profile (set -eu; select_profile sources config), then the values and the
// exported environment, NUL-separated (compgen -e and ${!v}: Bash 3.2).
// END marks a complete answer: a config that `exit`s or `return`s early must not read as an empty one.
const SOURCE = 'set -eu; . "$1"; select_profile "$2" "$3" >&2; printf "%s\\0" "$HOST" "$HOST_BIN" "$HOST_PROFILE" "$IDENTITY"; while IFS= read -r v; do printf "%s=%s\\0" "$v" "${!v}"; done < <(compgen -e); printf "END\\0"';

/**
 * Read the profile's config. Plain assignments to the controller's settings (what `boxery setup` writes)
 * are parsed; any other config is a trusted shell file, which bash sources as the CLI does.
 * @param {HostProfile} [host] @param {{ signal?: AbortSignal }} [opts] @returns {Promise<ProfileConfig>}
 */
export async function profileConfig(host = currentHost(), { signal } = {}) {
	const file = path.join(host.dir, "config");
	// A sourced config costs a bash per call, which adds up in a long-lived MCP server or pi session:
	// remember its result for a minute while the file is unchanged. Within that minute, changes to what it
	// reads besides itself (sourced files, $(…), the environment) aren't seen. A file modified in the last
	// two seconds isn't remembered: a same-size edit within one timestamp tick would look unchanged.
	const st = statSync(file, { throwIfNoEntry: false });
	const stamp = st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` : "none";
	const cached = sourced.get(file);
	if (cached?.stamp === stamp && Date.now() - cached.at < 60_000) return cached.config;
	const parsed = parseConfig(st ? readFileSync(file, "utf8") : "");
	if (parsed) {
		return Object.freeze({ host: parsed.HOST ?? "", hostBin: parsed.HOST_BIN ?? DEFAULT_HOST_BIN, hostProfile: parsed.HOST_PROFILE ?? "", identity: parsed.IDENTITY ?? "", env: process.env });
	}
	const out = await new Promise((resolve, reject) => execFile("bash", ["-c", SOURCE, "boxery-config", profileLib, host.name, host.dir], { maxBuffer: MAX_OUTPUT, timeout: 30_000, signal },
		(e, stdout, stderr) => (e ? reject(e.name === "AbortError" ? e : new Error(`could not load ${file}: ${(stderr || e.message).trim()}`)) : resolve(stdout))));
	const fields = /** @type {string} */ (out).split("\0").slice(0, -1);
	if (fields.length < 5 || fields.at(-1) !== "END") throw new Error(`could not load ${file}: it stopped before the end (exit or return?)`);
	// compgen -e lists only plain names: exported functions and odd names keep the caller's values.
	/** @type {NodeJS.ProcessEnv} */
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)));
	for (const kv of fields.slice(4, -1)) { const i = kv.indexOf("="); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1); }
	const config = Object.freeze({ host: fields[0], hostBin: fields[1], hostProfile: fields[2], identity: fields[3], env: Object.freeze(env) });
	if (st && Date.now() - st.mtimeMs > 2000) sourced.set(file, { stamp, at: Date.now(), config });
	return config;
}
/** @type {Map<string, { stamp: string, at: number, config: ProfileConfig }>} */
const sourced = new Map();

/** @param {HostProfile} host @param {ProfileConfig} c */
function needHost(host, c) {
	if (!c.host) throw Object.assign(new Error(`host ${host.name} is not configured; run: boxery setup user@host|local --name ${host.name}`), { fromHost: false });
	checkTarget(c);
}

/** raw: stdout as is (default: trimmed). config: the profile's, already loaded.
 *  @typedef {{ input?: string, signal?: AbortSignal, host?: HostProfile, timeout?: number, stderr?: "pipe" | "inherit", raw?: boolean, config?: ProfileConfig }} HostRunOpts */

/**
 * boxery-host ARGS on the profile's host (directly for HOST=local, else over ssh), with stdin `input`.
 * Resolves with trimmed stdout (raw: as is). A timeout or abort signal stops that process (for a remote
 * host: its ssh; the command on the host keeps running). It settles a second after the command exits and
 * its output goes quiet (at most 10 s after it exits), even if something it started still holds that output open. stderr "inherit" passes diagnostics through
 * (the CLI): a failure that exited on its own is then `reported`. Otherwise stderr is the error
 * message. A failure of the host command (exit status, or it could not start) is `fromHost`, with its
 * `exitCode` and `stdout`; an abort is the AbortError itself.
 * @param {string[]} args @param {HostRunOpts} [opts] @returns {Promise<string>}
 */
export async function hostRun(args, { input, signal, host = currentHost(), timeout = 120_000, stderr = "pipe", raw = false, config } = {}) {
	const c = config ?? await profileConfig(host, { signal });
	needHost(host, c);
	const [cmd, argv] = c.host === "local"
		? [localHostBin(c.hostBin, c.env.HOME ?? homedir()), [...(c.hostProfile ? ["--profile", c.hostProfile] : []), ...args]]
		: ["ssh", ["-o", "LogLevel=ERROR", "--", c.host, remoteCommand(c, args)]];
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, argv, { stdio: ["pipe", "pipe", stderr], signal, env: c.env });
		// Our own timer, not spawn's: that one is never cleared when the command can't start (ENOENT), and
		// would hold this process open for the whole timeout.
		// (Also cuts the pipes: once the command has exited, kill() does nothing to what holds them.)
		const timer = timeout > 0 ? setTimeout(() => { child.kill(); if (exited) cut(); }, timeout) : undefined;
		const done = () => clearTimeout(timer);
		// Something the command started (a backend's daemon, a killed ssh's leftovers) may keep our pipes
		// open after it exits: don't wait for that ('close' then follows). Only after a second with no output,
		// and after a poll of the pipes (setImmediate), so what the command wrote is never cut off.
		// A hard limit too: something that keeps writing after the command exited must not hold us forever.
		let exited = false, quiet = /** @type {NodeJS.Timeout | undefined} */ (undefined), hard = quiet;
		const cut = () => setImmediate(() => { child.stdout?.destroy(); child.stderr?.destroy(); });
		const settleSoon = () => { clearTimeout(quiet); quiet = setTimeout(cut, 1000).unref(); };
		child.on("exit", () => { exited = true; settleSoon(); hard = setTimeout(cut, 10_000).unref(); });
		/** @type {Buffer[]} */
		const out = [];
		/** @type {Buffer[]} */
		const err = [];
		let size = 0, errSize = 0, failed = false;
		child.stdout?.on("data", (/** @type {Buffer} */ d) => { if (exited) settleSoon(); size += d.length; if (size > MAX_OUTPUT) { child.kill(); cut(); } else out.push(d); });
		child.stderr?.on("data", (/** @type {Buffer} */ d) => { if (exited) settleSoon(); if (errSize < 64 * 1024) { errSize += d.length; err.push(d); } });
		child.on("error", (e) => {
			failed = true; done();
			const code = /** @type {NodeJS.ErrnoException} */ (e).code;
			reject(code === "ENOENT" || code === "EACCES" ? Object.assign(new Error(`cannot run ${cmd}: ${e.message}`), { fromHost: true, exitCode: 127 }) : e);
		});
		child.on("close", (code, sig) => {
			done(); clearTimeout(quiet); clearTimeout(hard);
			if (failed) return;
			const text = Buffer.concat(out).toString("utf8");
			if (code === 0) return resolve(raw ? text : text.trim());
			const why = Buffer.concat(err).toString("utf8").trim();
			reject(Object.assign(new Error(why || `boxery-host ${args[0] ?? ""} failed (${sig ? `signal ${sig}` : `exit ${code}`})`), {
				exitCode: code ?? (sig ? 128 : 1), reported: stderr === "inherit" && code !== null, fromHost: true, stdout: text,
			}));
		});
		child.stdin?.on("error", () => {}); // EPIPE if the command exits before reading
		child.stdin?.end(input);
	});
}

/** Does the host support something its `help` shows (PATTERN)? Remembered in the profile as MARKER once it
 *  does, like the CLI's host_pins_keys (which reads `help` whatever its exit status). A host that doesn't
 *  is remembered for 10 minutes in this process only: it may be upgraded. recheck: ask again, and forget
 *  the marker if it no longer does (a host downgraded, or HOST pointed at an older one).
 *  @param {HostProfile} host @param {ProfileConfig} c @param {string} marker @param {RegExp} pattern
 *  @param {{ signal?: AbortSignal, recheck?: boolean }} [opts] */
async function hostSupports(host, c, marker, pattern, { signal, recheck = false } = {}) {
	const file = path.join(host.dir, marker), key = `${file}\0${c.host}`;
	if (!recheck && existsSync(file)) return true;
	if (!c.host) return false;
	if (!recheck && (unsupported.get(key) ?? 0) > Date.now()) return false;
	const help = await hostRun(["help"], { host, config: c, timeout: 60_000, raw: true, signal }).catch((e) => {
		if (e?.name === "AbortError") throw e;
		return String(e?.stdout ?? "");
	});
	if (pattern.test(help)) { writeFileSync(file, ""); unsupported.delete(key); return true; }
	rmSync(file, { force: true });
	unsupported.set(key, Date.now() + 10 * 60_000);
	return false;
}
/** marker + host → until when it is known not to support it @type {Map<string, number>} */
const unsupported = new Map();
/** Forget what this process learned about hosts' features (tests: a stub host "upgraded" in place). */
export const forgetHostFeatures = () => unsupported.clear();
/** Does the host pin VM host keys (boxery-host known-hosts, #70)? @param {HostProfile} host @param {ProfileConfig} c */
const hostPinsKeys = (host, c) => hostSupports(host, c, "host-pins-keys", /^ {2}known-hosts NAME/m);
/** Does the host answer acquire/renew with --json? recheck: see hostSupports.
 *  @param {{ host?: HostProfile, signal?: AbortSignal, recheck?: boolean }} [opts] */
export async function hostLeaseJson({ host = currentHost(), signal, recheck } = {}) {
	return hostSupports(host, await profileConfig(host, { signal }), "host-lease-json", /^ {2}renew LEASE \[--ttl S\] \[--json\]/m, { signal, recheck });
}

/** The leases and ssh-agent grants ssh_config names. Stricter than the CLI's
 *  write_ssh_config: a lease record without one valid name and id, or a grant file that isn't a VM name,
 *  is skipped rather than written into ssh_config (neither is ever made by boxery). Leases in file (id)
 *  order, grants in VM order, both in C order (the CLI's globs follow the locale). @param {string} dir */
function sshConfigEntries(dir) {
	const list = (/** @type {string} */ d) => (existsSync(d) ? readdirSync(d).sort() : []);
	const leases = list(path.join(dir, "leases")).filter((f) => f.endsWith(".lease") && !f.startsWith(".")).flatMap((f) => {
		let text = "";
		try { text = readFileSync(path.join(dir, "leases", f), "utf8"); } catch { return []; }
		const name = /^name=(.*)$/m.exec(text)?.[1] ?? "", id = /^id=(.*)$/m.exec(text)?.[1] ?? "";
		return VALID_NAME.test(name) && VALID_LEASE.test(id) ? [{ name, id }] : [];
	});
	const agentVms = list(path.join(dir, "grants")).filter((vm) => VALID_NAME.test(vm)).filter((vm) => {
		try { return readFileSync(path.join(dir, "grants", vm), "utf8").split("\n").some((l) => l.split("\t")[0] === "ssh-agent"); } catch { return false; }
	});
	return { leases, agentVms };
}

/** Rewrite the profile's ssh_config from its config, leases and grants, like the CLI's write_ssh_config
 *  (which doesn't check the target either: hostRun does, before running anything). Published whole
 *  (rename): other boxery processes and ssh -F read it meanwhile. config: the profile's, already loaded.
 *  @param {{ host?: HostProfile, config?: ProfileConfig }} [opts] */
export async function writeSshConfig({ host = currentHost(), config } = {}) {
	const c = config ?? await profileConfig(host);
	const pins = await hostPinsKeys(host, c);
	const text = renderSshConfig({ ...c, dir: host.dir, home: c.env.HOME ?? homedir(), pins, ...sshConfigEntries(host.dir) });
	mkdirSync(host.dir, { recursive: true });
	const tmp = `${host.sshConf}.tmp.${process.pid}`;
	try {
		writeFileSync(tmp, text);
		renameSync(tmp, host.sshConf);
	} finally { rmSync(tmp, { force: true }); }
}

/** Close VM's shared (ControlMaster) connection: after a reset it points at a dead session. Never fails.
 *  @param {string} vm @param {{ host?: HostProfile, timeout?: number, config?: ProfileConfig }} [opts] */
export async function closeMaster(vm, { host = currentHost(), timeout = 30_000, config } = {}) {
	const env = config ? config.env : await profileConfig(host).then((c) => c.env, () => process.env);
	await new Promise((resolve) => {
		const child = spawn("ssh", ["-F", host.sshConf, "-O", "exit", `${vm}.boxery`], { stdio: "ignore", env });
		const timer = timeout > 0 ? setTimeout(() => child.kill(), timeout) : undefined;
		child.on("error", () => { clearTimeout(timer); resolve(undefined); });
		child.on("close", () => { clearTimeout(timer); resolve(undefined); });
	});
}
