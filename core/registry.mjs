// The host registry and setting a host up, shared by the CLI (boxery setup, host add/use/rm, backend) and the
// tools (vm_manage host_add/host_rm). BOXERY_HOME/host-registry/NAME → a profile directory; default-host →
// NAME. Registry files are data, read without following links (boxery-core.mjs); profile configs are
// trusted shell files (profile.mjs).
//
// How a run talks to its caller is the IO it is given: the CLI's is the terminal (the host's init and
// checks pass through, and may ask); a tool's captures everything as text and never shares stdio (MCP's
// stdout is its protocol), so nothing asks.
import { spawn } from "node:child_process";
import { accessSync, closeSync, existsSync, constants as fsConstants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants, homedir } from "node:os";
import path from "node:path";
import { BOXERY_HOME, defaultHost, resolveHost } from "./boxery-core.mjs";
import { hostRun, profileConfig, stopHostCommands, writeSshConfig } from "./profile.mjs";
import { DEFAULT_HOST_BIN, VALID_DEST, checkTarget, literal, localHostBin, remotePath, sshIncludeValue } from "./ssh-config.mjs";
/** @import { HostProfile } from "./boxery-core.mjs" */
/** @import { ProfileConfig, HostRunOpts } from "./profile.mjs" */

const REGISTRY = path.join(BOXERY_HOME, "host-registry");
export const VALID_ALIAS = /^[a-z][a-z0-9-]{0,30}$/;

/** A registry or setup failure: its message is for the person. exitCode: what the CLI exits with. */
export class RegistryError extends Error {
	/** @param {string} message @param {number} [exitCode] */
	constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}
/** @param {string} message @returns {never} */
const fail = (message) => { throw new RegistryError(message); };

/**
 * How setup talks: say (results, stdout), note (warnings, stderr), and whether the host's own commands
 * share the caller's terminal (terminal: the CLI) or are captured (a tool).
 * @typedef {{ say: (line: string) => void, note: (line: string) => void, terminal: boolean, progress?: (line: string) => void }} RegistryIO
 */
/** A tool's IO: everything into one text (the tool's answer), each line also as progress. @param {(line: string) => void} [progress] */
export function textIO(progress) {
	/** @type {string[]} */
	const lines = [];
	const add = (/** @type {string} */ l) => { lines.push(l); const t = l.trim().split("\n").at(-1); if (t) progress?.(t.slice(0, 200)); };
	return { io: /** @type {RegistryIO} */ ({ say: add, note: add, terminal: false, progress }), text: () => lines.join("\n").trim() };
}

/** @param {string} name */
export const needAlias = (name) => (VALID_ALIAS.test(name ?? "") ? name : fail(`invalid host name: ${name ?? ""}`));
/** Only an absent path means "nothing there"; a symlink (even a dangling one) is something. @param {string} p */
const present = (p) => { try { lstatSync(p); return true; } catch { return false; } };
/** @param {string} p */
const plainPath = (p) => (/[\n\t\r]/.test(p) ? fail("paths cannot contain line breaks or tabs") : p);
/** Write FILE whole (rename), so readers never see half of it. @param {string} file @param {string} text */
function publish(file, text) {
	const tmp = `${file}.tmp.${process.pid}`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}
/** The default host, its registration checked as a strict one-line data file (an error if malformed). */
export function checkedDefault() {
	const def = defaultHost();
	if (def != null) resolveHost(def);
	return def;
}
/** Is NAME registered (an entry exists, valid or not)? @param {string} name */
export const isRegistered = (name) => present(path.join(REGISTRY, name));

/** A host command's output: in the terminal (the CLI), or captured into the IO. @param {RegistryIO} io @param {string[]} args
 *  @param {HostProfile} host @param {ProfileConfig} c @param {HostRunOpts} [o] */
async function hostSays(io, args, host, c, o = {}) {
	if (io.terminal) return hostRun(args, { host, config: c, timeout: 0, stdin: o.input === undefined ? "inherit" : "pipe", stdout: "inherit", stderr: "inherit", ...o });
	// A tool: never the caller's stdio. No stdin (nothing can be asked), output captured for its answer.
	/** @type {Buffer[]} */
	const all = [];
	try {
		const out = await hostRun(args, { host, config: c, timeout: 600_000, ...o, onData: (d) => { all.push(d); const l = d.toString("utf8").trim().split("\n").at(-1); if (l) io.progress?.(l.slice(0, 200)); } });
		return out;
	} finally {
		const text = Buffer.concat(all).toString("utf8").trim();
		if (text) io.note(text.split("\n").map((l) => l.split("\r").filter(Boolean).at(-1) ?? "").slice(-40).join("\n"));
	}
}

/** A command on this machine (the local host's help, ssh to a remote one): its exit status. In the terminal
 *  its stderr is shown; for a tool it is captured. @param {RegistryIO} io @param {string} cmd @param {string[]} args @param {NodeJS.ProcessEnv} env */
function check(io, cmd, args, env) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "ignore", io.terminal ? "inherit" : "pipe"], env });
		// A tool's call must end (and give the registry back): two minutes at most. A person can Ctrl-C.
		const timer = io.terminal ? undefined : setTimeout(() => { io.note(`boxery: ${cmd} took over 2 minutes; stopped`); child.kill(); }, 120_000);
		let err = "";
		child.stderr?.on("data", (d) => { if (err.length < 16_384) err += d; });
		child.on("error", (e) => { clearTimeout(timer); io.note(`boxery: cannot run ${cmd}: ${e.message}`); resolve(127); });
		child.on("close", (code) => { clearTimeout(timer); if (err.trim()) io.note(err.trim()); resolve(code ?? 1); });
	});
}

/**
 * Configure the profile in HOST.dir for DEST: check the host, create its host-side profile (backend),
 * register this machine's ssh key, then write config and ssh_config. CONFIG: what the profile's config
 * said before (its HOST_BIN and HOST_PROFILE stay unless the options change them).
 * @param {{ name: string, dir: string, sshConf: string }} host @param {ProfileConfig} config @param {string} dest
 * @param {{ key?: string, hostBin?: string, hostProfile?: string, backend?: string, setupProfile?: string }} opts @param {RegistryIO} io
 */
export async function setup(host, config, dest, { key = "", hostBin = config.hostBin, hostProfile = config.hostProfile, backend = "", setupProfile = "" }, io) {
	if (backend) {
		hostProfile ||= setupProfile;
		if (!hostProfile) fail("--backend creates a host profile: pass --profile NAME (boxery host add NAME DEST --backend B uses NAME)");
		if (!VALID_ALIAS.test(backend)) fail(`invalid backend: ${backend}`);
	}
	/** @type {ProfileConfig} */
	const c = { ...config, host: dest, hostBin, hostProfile, identity: "" };
	try { checkTarget(c); } catch (e) { fail(/** @type {Error} */ (e).message); }
	const env = c.env;
	const hp = /** @type {HostProfile} */ (host);
	if (dest === "local") {
		io.say("==> local mode: the VM host is this machine");
		const bin = localHostBin(hostBin, env.HOME ?? homedir());
		let executable = false;
		try { accessSync(bin, fsConstants.X_OK); executable = statSync(bin).isFile(); } catch { /* missing or not executable by us */ }
		if (!executable) fail(`${bin} not found; run host/boxery-host init here first`);
		if (await check(io, bin, ["help"], env) !== 0) fail(`cannot run ${bin}`);
	} else {
		io.say(`==> checking ssh to ${dest}`);
		// (A tool can't answer a password or host-key prompt: BatchMode. The CLI's user can.)
		if (await check(io, "ssh", ["-o", "LogLevel=ERROR", ...(io.terminal ? [] : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30"]), "--", dest, `${remotePath(hostBin)} help >/dev/null`], env) !== 0)
			fail(`cannot run ${hostBin} on ${dest} (is it installed? did you run boxery-host init?)`);
	}
	/** @param {string[]} a @param {HostRunOpts} [o] */
	const h = (a, o = {}) => hostRun(a, { host: hp, config: c, timeout: io.terminal ? 0 : 600_000, ...o });
	if (backend) {
		io.say(`==> creating host profile ${hostProfile} (${backend} backend; its own state, proxy port and services)`);
		await hostSays(io, ["init", "--backend", backend], hp, c)
			.catch(() => fail(`boxery-host --profile ${hostProfile} init --backend ${backend} failed on ${dest} (see above); fix it and re-run, init is safe to repeat`));
	} else if (hostProfile) {
		await h(["help"], { stderr: io.terminal ? "inherit" : "pipe" }).catch(() => fail(`cannot use host profile ${hostProfile} on ${dest}`));
	}
	// Check boxery-host, not the controller; old hosts remain registrable with a warning.
	const help = await h(["help"], { raw: true }).catch((e) => String(e?.stdout ?? ""));
	if (help.includes("capabilities")) {
		await hostSays(io, ["capabilities", "--check"], hp, c).catch(() => fail("host backend requirements not met (see above); fix them before setup"));
	} else io.note("==> warning: host predates capability checks; upgrade it for backend preflight");
	const authBackend = await h(["backend"]).catch(() => "");
	let identity = "";
	if (authBackend === "openshell") io.say("==> OpenShell gateway authenticates access; no guest SSH key registration needed");
	else {
		const home = env.HOME ?? homedir();
		const pub = key || (["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"].map((k) => path.join(home, ".ssh", k)).find((k) => existsSync(k)) ?? "");
		let isFile = false;
		try { isFile = statSync(pub).isFile(); } catch { /* missing */ }
		if (!isFile) fail("no ssh public key found; pass --key");
		identity = plainPath(pub.replace(/\.pub$/, ""));
		io.say(`==> registering ${pub} with host (applies to VMs created from now on)`);
		// (A failure the host has already explained, in the terminal, ends with its exit status and no more words.)
		await hostSays(io, ["add-key"], hp, c, { input: readFileSync(pub, "utf8") }).catch((e) => { throw new RegistryError(e.reported ? "" : e.message, e.exitCode ?? 1); });
	}
	mkdirSync(host.dir, { recursive: true });
	publish(path.join(host.dir, "config"), `HOST=${literal(dest)}\nHOST_BIN=${literal(hostBin)}\nIDENTITY=${literal(identity)}\n${hostProfile ? `HOST_PROFILE=${literal(hostProfile)}\n` : ""}`);
	const written = { ...c, identity };
	await writeSshConfig({ host: hp, config: written });
	const b = await recordBackend(hp, written);
	if (b) io.say(`==> backend: ${b}`);
	// Only the default host gets the global Include: several profiles' *.boxery aliases would be ambiguous.
	const def = checkedDefault();
	if (def && def !== host.name) {
		io.say(`==> not the default host: use boxery --host ${host.name} ssh VM (do not globally Include multiple profiles' *.boxery aliases)`);
	} else if (host.sshConf.includes("%")) {
		// Older OpenSSH treats Include's % literally; newer clients expand percent tokens. -F reads it as is.
		io.say(`==> config path contains %; use boxery ssh VM or ssh -F ${literal(host.sshConf)} VM.boxery instead of a global Include`);
	} else {
		const include = `Include ${sshIncludeValue(host.sshConf)}`;
		const userConfig = path.join(env.HOME ?? homedir(), ".ssh", "config");
		let lines = /** @type {string[]} */ ([]);
		try { if (statSync(userConfig).isFile()) lines = readFileSync(userConfig, "utf8").split("\n"); } catch { /* none, or unreadable: recommend it */ }
		if (!lines.includes(include) && !lines.includes(`Include ${host.sshConf}`)) {
			io.say("==> add this line to the TOP of ~/.ssh/config so 'ssh NAME.boxery', VS Code, Zed etc. work:");
			io.say(`    ${include}`);
		}
	}
	if (b === "openshell") io.say(`==> done. Try: boxery --host ${host.name} new demo --headless (no desktop or build-base)`);
	else if (backend) io.say(`==> done. Headless VMs work now; desktop VMs need the base image once (~3 min): ${host.name === checkedDefault() ? "boxery build-base" : `boxery --host ${host.name} build-base`}`);
	else io.say("==> done. Try: boxery new demo");
}

/**
 * The host's VM backend, recorded in the profile's `backend` file (one line of data, never sourced) so
 * host listings need no round-trip. A host that predates `boxery-host backend`, or fails, leaves no
 * record rather than a stale one. @param {HostProfile} host @param {ProfileConfig} [config] @returns {Promise<string>}
 */
export async function recordBackend(host, config) {
	const b = await hostRun(["backend"], { host, config: config ?? await profileConfig(host), timeout: 120_000 }).catch(() => "");
	const file = path.join(host.dir, "backend");
	if (VALID_ALIAS.test(b)) { publish(file, `${b}\n`); return b; }
	rmSync(file, { force: true });
	return "";
}

// ---------------------------------------------------------------- the registry lock

/** What must be undone if this process ends while the registry is locked: the lock, and a profile
 *  directory being made. (Synchronous: it also runs inside process.exit.) */
const undo = { lock: "", profile: "" };
const cleanUp = () => { if (undo.profile) rmSync(undo.profile, { recursive: true, force: true }); if (undo.lock) rmSync(undo.lock, { force: true }); undo.profile = ""; undo.lock = ""; };
/** For a long-lived process (MCP) that is about to exit: stop the host commands a registration is running,
 *  and give the registry back. Safe to call with nothing held. */
export async function releaseRegistry() {
	if (!undo.lock) return;
	await stopHostCommands("SIGTERM");
	cleanUp();
}

/** Run FN holding the registry lock. onSignal (the CLI): a signal meanwhile (Ctrl-C at an init prompt)
 *  stops the host commands, removes the lock and a half-made profile, and ends the process as the signal
 *  would (128+N), as Bash's EXIT trap did. A long-lived process (MCP) leaves its signals alone.
 *  @template T @param {() => Promise<T>} fn @param {{ onSignal?: boolean }} [opts] @returns {Promise<T>} */
export async function withRegistryLock(fn, { onSignal = false } = {}) {
	mkdirSync(REGISTRY, { recursive: true });
	const lock = path.join(REGISTRY, ".lock");
	let fd;
	try { fd = openSync(lock, "wx"); }
	catch (e) { fail(/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST" ? "host registry is locked; retry" : `cannot lock the host registry: ${/** @type {Error} */ (e).message}`); }
	closeSync(/** @type {number} */ (fd));
	undo.lock = lock;
	const handlers = onSignal ? /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]).map((sig) => /** @type {[NodeJS.Signals, () => void]} */ ([sig, () => {
		void stopHostCommands(sig).finally(() => { cleanUp(); process.exit(128 + constants.signals[sig]); });
	}])) : [];
	for (const [sig, h] of handlers) process.on(sig, h);
	// However this process ends meanwhile (an MCP server exiting mid-call), the lock doesn't outlive it.
	process.on("exit", cleanUp);
	try { return await fn(); } finally {
		for (const [sig, h] of handlers) process.off(sig, h);
		process.off("exit", cleanUp);
		rmSync(lock, { force: true }); undo.lock = "";
	}
}

/** @param {string} name */
export function setDefault(name) { publish(path.join(BOXERY_HOME, "default-host"), `${name}\n`); }

/**
 * Register host ALIAS (the registry lock held): import an existing profile (configDir, as is), or make
 * one in BOXERY_HOME/profiles/ALIAS by running setup against DEST. The first host becomes the default.
 * @param {string} alias @param {{ configDir?: string, dest?: string, key?: string, hostBin?: string, hostProfile?: string, backend?: string }} spec
 * @param {RegistryIO} io @returns {Promise<string>} the profile directory
 */
export async function addHostLocked(alias, { configDir, dest, ...opts }, io) {
	needAlias(alias);
	if (isRegistered(alias)) fail(`host already registered: ${alias}`);
	/** @type {string} */
	let dir = "";
	if (configDir != null) {
		try { dir = realpathSync(configDir); if (!statSync(dir).isDirectory()) throw new Error(); } catch { fail(`no such config directory: ${configDir}`); }
		if (!["config", "ssh_config"].every((f) => { try { return statSync(path.join(dir, f)).isFile(); } catch { return false; } })) fail(`config and ssh_config required: ${dir}`);
	} else {
		if (dest == null) fail("usage: boxery host add NAME DEST [--key K] [--host-bin PATH] [--backend B] [--profile P] | --config-dir DIR");
		dir = path.join(BOXERY_HOME, "profiles", alias);
		if (present(dir)) fail(`profile data already exists: ${dir} (import it explicitly)`);
		plainPath(dir);
		mkdirSync(dir, { recursive: true });
		undo.profile = dir; // removed on any way out until it is registered
		const host = { name: alias, dir, sshConf: path.join(dir, "ssh_config") };
		/** @type {ProfileConfig} */
		const fresh = { host: "", hostBin: DEFAULT_HOST_BIN, hostProfile: "", identity: "", env: process.env };
		try { await setup(host, fresh, dest, { ...opts, setupProfile: alias }, io); }
		catch (e) { cleanUp(); undo.profile = ""; throw e; }
	}
	plainPath(dir);
	try { publish(path.join(REGISTRY, alias), `${dir}\n`); }
	catch (e) { if (undo.profile) { rmSync(undo.profile, { recursive: true, force: true }); undo.profile = ""; } throw e; }
	undo.profile = "";
	if (checkedDefault() == null) { setDefault(alias); io.say(`registered ${alias} (${dir}); it is the default host`); }
	else io.say(`registered ${alias} (${dir}); select with: boxery host use ${alias}`);
	return dir;
}

/** Forget host ALIAS's registration (the lock held): not its profile data, VMs or grants. Not the default.
 *  @param {string} alias @param {RegistryIO} io */
export function removeHostLocked(alias, io) {
	needAlias(alias);
	// (A symlinked entry is malformed everywhere else; rm may still remove it: it only unlinks.)
	let entry = false;
	try { const st = lstatSync(path.join(REGISTRY, alias)); entry = st.isFile() || st.isSymbolicLink(); } catch { /* absent */ }
	if (!entry) fail(`unknown host: ${alias}`);
	if (checkedDefault() === alias) fail("cannot forget the default host; first run boxery host use OTHER");
	rmSync(path.join(REGISTRY, alias));
	io.say(`forgot ${alias}; profile data, VMs and grants were NOT deleted or revoked`);
}

/** Where a profile's VM host runs, as the CLI resolves it (its config is trusted: sourced if computed). @param {HostProfile} host */
export async function destination(host) {
	try { const { host: dest } = await profileConfig(host); return VALID_DEST.test(dest) ? dest : null; } catch { return null; }
}
