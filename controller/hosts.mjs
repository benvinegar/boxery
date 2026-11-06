// boxery setup | host add|ls|show|use|rm | backend: the CLI's side of the host registry. The work is
// core/registry.mjs (shared with vm_manage host_add/host_rm); here: arguments, the terminal (the host's init
// and checks pass through and may ask), and the listing formats.
import { describeHosts, hostBackend, profileFromDirectory, registeredHosts, resolveHost } from "../core/boxery-core.mjs";
import { profileConfig } from "../core/profile.mjs";
import { RegistryError, VALID_ALIAS, addHostLocked, checkedDefault, destination, isRegistered, needAlias, recordBackend, removeHostLocked, setDefault, setup, withRegistryLock } from "../core/registry.mjs";
import { CliError, die, note, say } from "./lib.mjs";
/** @import { HostProfile } from "../core/boxery-core.mjs" */
/** @import { RegistryIO } from "../core/registry.mjs" */

const SETUP_USAGE = "usage: boxery setup user@host|local [--name NAME] [--key ~/.ssh/id_ed25519.pub] [--host-bin PATH] [--profile P] [--backend B]";
const ADD_USAGE = "usage: boxery host add NAME DEST [--key K] [--host-bin PATH] [--backend B] [--profile P] | --config-dir DIR";
/** The CLI's IO: stdout and stderr, and the host's commands share this terminal. @type {RegistryIO} */
const TERMINAL = { say, note, terminal: true };

/** A registry failure as the CLI reports it. @param {() => Promise<unknown> | unknown} fn */
async function cli(fn) {
	try { await fn(); }
	catch (e) {
		if (e instanceof RegistryError) throw new CliError(e.message, e.exitCode);
		throw e;
	}
}

/** setup's and host add's options after DEST. @param {string[]} flags */
function setupFlags(flags) {
	/** @type {{ key?: string, hostBin?: string, hostProfile?: string, backend?: string }} */
	const o = {};
	for (let i = 0; i < flags.length; i += 2) {
		const f = flags[i];
		if (!["--key", "--host-bin", "--profile", "--backend"].includes(f)) die(`unknown flag ${f}`);
		if (i + 1 >= flags.length) die(`${f} needs a value`);
		const v = flags[i + 1];
		if (f === "--key") o.key = v; else if (f === "--host-bin") o.hostBin = v; else if (f === "--profile") o.hostProfile = v; else o.backend = v;
	}
	return o;
}

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
	await cli(async () => {
		needAlias(name);
		if (isRegistered(name)) {
			const host = resolveHost(name);
			await setup(host, await profileConfig(host), rest[0], { ...setupFlags(rest.slice(1)), setupProfile: name }, TERMINAL);
		} else await withRegistryLock(() => addHostLocked(name, { dest: rest[0], ...setupFlags(rest.slice(1)) }, TERMINAL), { onSignal: true });
	});
}

/** `boxery backend`. @param {HostProfile} host @param {string[]} args */
export async function backendCommand(host, args) {
	if (args.length) die("usage: boxery backend");
	const b = await recordBackend(host);
	if (!b) die("could not read the host's backend (does it predate 'boxery-host backend'? see: boxery version)");
	say(b);
}

/** `boxery host ACTION …` (no --host: these act on the registry). @param {string[]} args */
export async function hostCommand(args) {
	const [action = "ls", ...rest] = args;
	if (action === "ls") return hostLs(rest);
	if (action === "show") {
		if (rest.length !== 1) die("usage: boxery host show NAME");
		return cli(() => say(resolveHost(needAlias(rest[0])).dir));
	}
	if (!["add", "use", "rm"].includes(action)) die("usage: boxery host add|ls|show|use|rm");
	if (!rest.length) die(`host ${action} needs a name`);
	const [alias, ...more] = rest;
	await cli(async () => {
		needAlias(alias);
		await withRegistryLock(async () => {
			if (action === "use") {
				if (more.length) die("usage: boxery host use NAME");
				resolveHost(alias);
				checkedDefault(); // never replace malformed selection metadata
				setDefault(alias);
			} else if (action === "rm") {
				if (more.length) die("usage: boxery host rm NAME");
				removeHostLocked(alias, TERMINAL);
			} else {
				if (isRegistered(alias)) die(`host already registered: ${alias}`);
				if (!more.length) die(ADD_USAGE);
				if (more[0] === "--config-dir") {
					if (more.length !== 2) die("usage: boxery host add NAME --config-dir DIR");
					await addHostLocked(alias, { configDir: more[1] }, TERMINAL);
				} else await addHostLocked(alias, { dest: more[0], ...setupFlags(more.slice(1)) }, TERMINAL);
			}
		}, { onSignal: true });
	});
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
