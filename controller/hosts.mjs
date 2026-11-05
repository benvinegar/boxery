// boxery setup | host add|ls|show|use|rm | backend: the host registry (BOXERY_HOME/host-registry/NAME →
// profile directory, BOXERY_HOME/default-host → NAME) and each profile's config and ssh_config.
// Registry files are data, read without following links (core/boxery-core.mjs); profile configs are
// trusted shell files (core/profile.mjs).
import { accessSync, closeSync, existsSync, constants as fsConstants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { homedir } from "node:os";
import path from "node:path";
import { BOXERY_HOME, defaultHost, describeHosts, hostBackend, profileFromDirectory, registeredHosts, resolveHost } from "../core/boxery-core.mjs";
import { hostRun, profileConfig, stopHostCommands, writeSshConfig } from "../core/profile.mjs";
import { DEFAULT_HOST_BIN, VALID_DEST, checkTarget, literal, localHostBin, remotePath, sshIncludeValue } from "../core/ssh-config.mjs";
import { die, hostFailed, inherit, note, say } from "./lib.mjs";
/** @import { HostProfile } from "../core/boxery-core.mjs" */
/** @import { ProfileConfig } from "../core/profile.mjs" */

const REGISTRY = path.join(BOXERY_HOME, "host-registry");
const VALID_ALIAS = /^[a-z][a-z0-9-]{0,30}$/;
const SETUP_USAGE = "usage: boxery setup user@host|local [--name NAME] [--key ~/.ssh/id_ed25519.pub] [--host-bin PATH] [--profile P] [--backend B]";
const ADD_USAGE = "usage: boxery host add NAME DEST [--key K] [--host-bin PATH] [--backend B] [--profile P] | --config-dir DIR";

/** @param {string} name */
const needAlias = (name) => (VALID_ALIAS.test(name) ? name : die(`invalid host name: ${name}`));
/** Only an absent path means "nothing there"; a symlink (even a dangling one) is something. @param {string} p */
const present = (p) => { try { lstatSync(p); return true; } catch { return false; } };
/** @param {string} p */
const plainPath = (p) => (/[\n\t\r]/.test(p) ? die("paths cannot contain line breaks or tabs") : p);
/** Write FILE whole (rename), so readers never see half of it. @param {string} file @param {string} text */
function publish(file, text) {
	const tmp = `${file}.tmp.${process.pid}`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/** The default host, its registration checked as a strict one-line data file (an error if malformed). */
function checkedDefault() {
	const def = defaultHost();
	if (def != null) resolveHost(def);
	return def;
}

// ---------------------------------------------------------------- setup

/** The host name setup derives from DEST: local, or DEST's host part (you@hornet.example → hornet). @param {string} dest */
function setupName(dest) {
	if (dest === "local") return "local";
	const d = dest.replace(/^.*@/, "").replace(/\..*$/, "").toLowerCase().replaceAll("_", "-");
	return VALID_ALIAS.test(d) ? d : die(`cannot derive a host name from ${dest}; pass --name NAME`);
}

/** `boxery setup DEST [--name NAME] …`: (re)configure host NAME, registering it first if it is new. @param {string[]} args */
export async function setupNamed(args) {
	// OpenShell onboarding is its own guided flow (controller/setup-openshell.mjs).
	if (args.some((a, i) => a === "openshell" && args[i - 1] === "--backend")) {
		const { setupOpenShell } = await import("./setup-openshell.mjs");
		const { createInterface } = await import("node:readline/promises");
		/** @type {import("node:readline/promises").Interface | undefined} */
		let rl;
		try { await setupOpenShell(args, { ask: async (m) => (rl ??= createInterface({ input: process.stdin, output: process.stderr })).question(m) }); }
		finally { rl?.close(); }
		return;
	}
	if (!args.length) die(SETUP_USAGE);
	let name = "";
	/** @type {string[]} */
	const rest = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--name") { if (i + 1 >= args.length) die("--name needs a value"); name = args[++i]; }
		else if (["--key", "--host-bin", "--profile", "--backend"].includes(a)) { if (i + 1 >= args.length) die(`${a} needs a value`); rest.push(a, args[++i]); }
		else rest.push(a);
	}
	if (!rest.length) die(SETUP_USAGE);
	name ||= setupName(rest[0]);
	needAlias(name);
	if (present(path.join(REGISTRY, name))) {
		const host = resolveHost(name);
		await setup(host, await profileConfig(host), rest, { setupProfile: name });
	} else await hostAdd(name, rest);
}

/**
 * Configure the profile in HOST.dir for DEST: check the host, create its host-side profile (--backend),
 * register this machine's ssh key, then write config and ssh_config. CONFIG: what the profile's config
 * said before (its HOST_BIN and HOST_PROFILE stay unless flags change them).
 * @param {{ name: string, dir: string, sshConf: string }} host @param {ProfileConfig} config @param {string[]} args
 * @param {{ setupProfile?: string }} [opts]
 */
async function setup(host, config, args, { setupProfile = "" } = {}) {
	const [dest, ...flags] = args;
	if (dest == null) die("usage: boxery setup user@host|local [--name NAME] [--key ~/.ssh/id_ed25519.pub] [--host-bin PATH] [--profile P [--backend B]]");
	let pub = "", backend = "", hostBin = config.hostBin, hostProfile = config.hostProfile;
	for (let i = 0; i < flags.length; i += 2) {
		const f = flags[i];
		if (!["--key", "--host-bin", "--profile", "--backend"].includes(f)) die(`unknown flag ${f}`);
		if (i + 1 >= flags.length) die(`${f} needs a value`);
		const v = flags[i + 1];
		if (f === "--key") pub = v; else if (f === "--host-bin") hostBin = v; else if (f === "--profile") hostProfile = v; else backend = v;
	}
	if (backend) {
		hostProfile ||= setupProfile;
		if (!hostProfile) die("--backend creates a host profile: pass --profile NAME (boxery host add NAME DEST --backend B uses NAME)");
		if (!VALID_ALIAS.test(backend)) die(`invalid backend: ${backend}`);
	}
	/** @type {ProfileConfig} */
	const c = { ...config, host: dest, hostBin, hostProfile, identity: "" };
	checkTarget(c);
	const env = c.env;
	if (dest === "local") {
		say("==> local mode: the VM host is this machine");
		const bin = localHostBin(hostBin, env.HOME ?? homedir());
		let executable = false;
		try { accessSync(bin, fsConstants.X_OK); executable = statSync(bin).isFile(); } catch { /* missing or not executable by us */ }
		if (!executable) die(`${bin} not found; run host/boxery-host init here first`);
		if (await inherit(bin, ["help"], { env, stdout: "ignore" }) !== 0) die(`cannot run ${bin}`);
	} else {
		say(`==> checking ssh to ${dest}`);
		if (await inherit("ssh", ["-o", "LogLevel=ERROR", "--", dest, `${remotePath(hostBin)} help >/dev/null`], { env }) !== 0)
			die(`cannot run ${hostBin} on ${dest} (is it installed? did you run boxery-host init?)`);
	}
	/** @param {string[]} a @param {import("../core/profile.mjs").HostRunOpts} [o] */
	const h = (a, o = {}) => hostRun(a, { host: /** @type {HostProfile} */ (host), config: c, timeout: 0, ...o });
	if (backend) {
		say(`==> creating host profile ${hostProfile} (${backend} backend; its own state, proxy port and services)`);
		await h(["init", "--backend", backend], { stdout: "inherit", stderr: "inherit", stdin: "inherit" })
			.catch(() => die(`boxery-host --profile ${hostProfile} init --backend ${backend} failed on ${dest} (see above); fix it and re-run, init is safe to repeat`));
	} else if (hostProfile) {
		await h(["help"], { stderr: "inherit" }).catch(() => die(`cannot use host profile ${hostProfile} on ${dest}`));
	}
	// Check boxery-host, not the controller; old hosts remain registrable with a warning.
	const help = await h(["help"], { raw: true }).catch((e) => String(e?.stdout ?? ""));
	if (help.includes("capabilities")) {
		await h(["capabilities", "--check"], { stdout: "inherit", stderr: "inherit" }).catch(() => die("host backend requirements not met (see above); fix them before setup"));
	} else note("==> warning: host predates capability checks; upgrade it for backend preflight");
	const authBackend = await h(["backend"], { stdin: "pipe" }).catch(() => "");
	let identity = "";
	if (authBackend === "openshell") say("==> OpenShell gateway authenticates access; no guest SSH key registration needed");
	else {
		const home = env.HOME ?? homedir();
		if (!pub) pub = ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"].map((k) => path.join(home, ".ssh", k)).find((k) => existsSync(k)) ?? "";
		let isFile = false;
		try { isFile = statSync(pub).isFile(); } catch { /* missing */ }
		if (!isFile) die("no ssh public key found; pass --key");
		identity = plainPath(pub.replace(/\.pub$/, ""));
		say(`==> registering ${pub} with host (applies to VMs created from now on)`);
		await h(["add-key"], { input: readFileSync(pub, "utf8"), stdout: "inherit", stderr: "inherit" }).catch(hostFailed);
	}
	mkdirSync(host.dir, { recursive: true });
	publish(path.join(host.dir, "config"), `HOST=${literal(dest)}\nHOST_BIN=${literal(hostBin)}\nIDENTITY=${literal(identity)}\n${hostProfile ? `HOST_PROFILE=${literal(hostProfile)}\n` : ""}`);
	const written = { ...c, identity };
	await writeSshConfig({ host: /** @type {HostProfile} */ (host), config: written });
	const b = await recordBackend(/** @type {HostProfile} */ (host), written);
	if (b) say(`==> backend: ${b}`);
	// Only the default host gets the global Include: several profiles' *.boxery aliases would be ambiguous.
	const def = checkedDefault();
	if (def && def !== host.name) {
		say(`==> not the default host: use boxery --host ${host.name} ssh VM (do not globally Include multiple profiles' *.boxery aliases)`);
	} else if (host.sshConf.includes("%")) {
		// Older OpenSSH treats Include's % literally; newer clients expand percent tokens. -F reads it as is.
		say(`==> config path contains %; use boxery ssh VM or ssh -F ${literal(host.sshConf)} VM.boxery instead of a global Include`);
	} else {
		const include = `Include ${sshIncludeValue(host.sshConf)}`;
		const userConfig = path.join(env.HOME ?? homedir(), ".ssh", "config");
		let lines = /** @type {string[]} */ ([]);
		try { if (statSync(userConfig).isFile()) lines = readFileSync(userConfig, "utf8").split("\n"); } catch { /* none, or unreadable: recommend it */ }
		if (!lines.includes(include) && !lines.includes(`Include ${host.sshConf}`)) {
			say("==> add this line to the TOP of ~/.ssh/config so 'ssh NAME.boxery', VS Code, Zed etc. work:");
			say(`    ${include}`);
		}
	}
	if (b === "openshell") say(`==> done. Try: boxery --host ${host.name} new demo --headless (no desktop or build-base)`);
	else if (backend) say(`==> done. Headless VMs work now; desktop VMs need the base image once (~3 min): ${host.name === checkedDefault() ? "boxery build-base" : `boxery --host ${host.name} build-base`}`);
	else say("==> done. Try: boxery new demo");
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

/** `boxery backend`. @param {HostProfile} host @param {string[]} args */
export async function backendCommand(host, args) {
	if (args.length) die("usage: boxery backend");
	const b = await recordBackend(host);
	if (!b) die("could not read the host's backend (does it predate 'boxery-host backend'? see: boxery version)");
	say(b);
}

// ---------------------------------------------------------------- host add|ls|show|use|rm

/** `boxery host ACTION …` (no --host: these act on the registry). @param {string[]} args */
export async function hostCommand(args) {
	const [action = "ls", ...rest] = args;
	if (action === "ls") return hostLs(rest);
	if (action === "show") {
		if (rest.length !== 1) die("usage: boxery host show NAME");
		return say(resolveHost(needAlias(rest[0])).dir);
	}
	if (!["add", "use", "rm"].includes(action)) die("usage: boxery host add|ls|show|use|rm");
	if (!rest.length) die(`host ${action} needs a name`);
	const [alias, ...more] = rest;
	needAlias(alias);
	await withRegistryLock(async () => {
		if (action === "use") {
			if (more.length) die("usage: boxery host use NAME");
			resolveHost(alias);
			checkedDefault(); // never replace malformed selection metadata
			setDefault(alias);
		} else if (action === "rm") {
			if (more.length) die("usage: boxery host rm NAME");
			// (A symlinked entry is malformed everywhere else; rm may still remove it: it only unlinks.)
			let entry = false;
			try { const st = lstatSync(path.join(REGISTRY, alias)); entry = st.isFile() || st.isSymbolicLink(); } catch { /* absent */ }
			if (!entry) die(`unknown host: ${alias}`);
			if (checkedDefault() === alias) die("cannot forget the default host; first run boxery host use OTHER");
			rmSync(path.join(REGISTRY, alias));
			say(`forgot ${alias}; profile data, VMs and grants were NOT deleted or revoked`);
		} else await hostAdd(alias, more, { locked: true });
	});
}

/** What a signal must undo while the registry is locked: the lock, and a profile directory being made. */
const undo = { lock: "", profile: "" };
const cleanUp = () => { if (undo.profile) rmSync(undo.profile, { recursive: true, force: true }); if (undo.lock) rmSync(undo.lock, { force: true }); };

/** Run FN holding the registry lock. A signal meanwhile (Ctrl-C at an init prompt) still removes the lock
 *  and a half-made profile, then ends the command as the signal would (128+N), as Bash's EXIT trap did.
 *  @param {() => Promise<void>} fn */
async function withRegistryLock(fn) {
	mkdirSync(REGISTRY, { recursive: true });
	const lock = path.join(REGISTRY, ".lock");
	let fd;
	try { fd = openSync(lock, "wx"); }
	catch (e) { die(/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST" ? "host registry is locked; retry" : `cannot lock the host registry: ${/** @type {Error} */ (e).message}`); }
	closeSync(fd);
	undo.lock = lock;
	// (The host commands setup runs are stopped first: a TERM sent to us alone would otherwise leave them
	// running, making a profile or registering a key after we said nothing was registered.)
	const handlers = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]).map((sig) => /** @type {[NodeJS.Signals, () => void]} */ ([sig, () => {
		void stopHostCommands(sig).finally(() => { cleanUp(); process.exit(128 + constants.signals[sig]); });
	}]));
	for (const [sig, h] of handlers) process.on(sig, h);
	try { await fn(); } finally {
		for (const [sig, h] of handlers) process.off(sig, h);
		rmSync(lock, { force: true }); undo.lock = "";
	}
}

/** @param {string} name */
function setDefault(name) { publish(path.join(BOXERY_HOME, "default-host"), `${name}\n`); }

/**
 * Register host ALIAS: import an existing profile (--config-dir DIR, as is), or make one in
 * BOXERY_HOME/profiles/ALIAS by running setup against DEST. The first host becomes the default.
 * @param {string} alias @param {string[]} args @param {{ locked?: boolean }} [opts] @returns {Promise<void>}
 */
async function hostAdd(alias, args, { locked = false } = {}) {
	if (!locked) return withRegistryLock(() => hostAdd(alias, args, { locked: true }));
	if (present(path.join(REGISTRY, alias))) die(`host already registered: ${alias}`);
	if (!args.length) die(ADD_USAGE);
	/** @type {string} */
	let dir = "";
	if (args[0] === "--config-dir") {
		if (args.length !== 2) die("usage: boxery host add NAME --config-dir DIR");
		try { dir = realpathSync(args[1]); if (!statSync(dir).isDirectory()) throw new Error(); } catch { die(`no such config directory: ${args[1]}`); }
		if (!["config", "ssh_config"].every((f) => { try { return statSync(path.join(/** @type {string} */ (dir), f)).isFile(); } catch { return false; } }))
			die(`config and ssh_config required: ${dir}`);
	} else {
		dir = path.join(BOXERY_HOME, "profiles", alias);
		if (present(dir)) die(`profile data already exists: ${dir} (import it explicitly)`);
		plainPath(dir);
		mkdirSync(dir, { recursive: true });
		undo.profile = dir; // removed on any way out until it is registered
		const host = { name: alias, dir, sshConf: path.join(dir, "ssh_config") };
		/** @type {ProfileConfig} */
		const fresh = { host: "", hostBin: DEFAULT_HOST_BIN, hostProfile: "", identity: "", env: process.env };
		try { await setup(host, fresh, args, { setupProfile: alias }); }
		catch (e) { cleanUp(); undo.profile = ""; throw e; }
	}
	plainPath(dir);
	try { publish(path.join(REGISTRY, alias), `${dir}\n`); }
	catch (e) { if (undo.profile) { rmSync(undo.profile, { recursive: true, force: true }); undo.profile = ""; } throw e; }
	undo.profile = "";
	if (checkedDefault() == null) { setDefault(alias); say(`registered ${alias} (${dir}); it is the default host`); }
	else say(`registered ${alias} (${dir}); select with: boxery host use ${alias}`);
}

/** Where a profile's VM host runs, as the CLI resolves it (its config is trusted: sourced if computed). @param {HostProfile} host */
async function destination(host) {
	try { const { host: dest } = await profileConfig(host); return VALID_DEST.test(dest) ? dest : null; } catch { return null; }
}

/** `boxery host ls [--json]`: name, default, config dir, where it runs, its recorded backend, other names for it. @param {string[]} args */
async function hostLs(args) {
	const json = args[0] === "--json";
	if (args.length > (json ? 1 : 0)) die("usage: boxery host ls [--json]");
	const def = checkedDefault();
	registeredHosts(); // every registration checked first, as before any is listed
	const rows = await Promise.all(describeHosts().map(async (h) => ({ ...h, default: h.name === def, destination: await destination(profileFromDirectory(h.name, h.dir)), backend: hostBackend(profileFromDirectory(h.name, h.dir)) })));
	if (json) return say(rows.length ? `[\n${rows.map((r) => JSON.stringify({ name: r.name, dir: r.dir, default: r.default, destination: r.destination, backend: r.backend, same_as: r.same_as })).join(",\n")}\n]` : "[]");
	say(["NAME\tDEFAULT\tCONFIG_DIR\tDESTINATION\tBACKEND\tSAME_AS", ...rows.map((r) =>
		[r.name, r.default ? "*" : "", r.dir, r.destination ?? "-", r.backend ?? "-", r.same_as.join(",") || "-"].join("\t"))].join("\n"));
}
