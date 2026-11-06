// boxery: the controller CLI, on your machine. controller/boxery is the shim that starts it. Every command's
// work is shared with the MCP server and the pi extension (core/): lifecycle (core/lifecycle.mjs), leases
// (core/leases.mjs), grants (core/grants.mjs), copies (vm_copy) and the host profile (core/profile.mjs).
// What is only the CLI's lives here: argument parsing, the terminal (grant approval, ssh, attach, desktop),
// and output formats (docs/cli.md), which are the same as the Bash controller's were.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOXERY_HOME, defaultHost, profileFromDirectory, resolveHost, withHost } from "../core/boxery-core.mjs";
import * as lifecycle from "../core/lifecycle.mjs";
import { refreshSshConfig } from "../core/profile.mjs";
import { literal, literalArgs, remotePath } from "../core/ssh-config.mjs";
import { controllerVersion, hostVersion, skewNote, upgradeHint } from "../core/versions.mjs";
import { backendCommand, hostCommand, setupNamed } from "./hosts.mjs";
import { CliError, VALID_SNAP, VALID_VM, commandLine, die, hasRawBytes, hostFailed, hostPass, inherit, needHost, needVm, note, rawTail, say, select, vmSsh, vmSshCapture, warn } from "./lib.mjs";
import { RUN_EXAMPLES, USAGE } from "./usage.mjs";
/** @import { Selected } from "./lib.mjs" */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Lifecycle options for the CLI: the host's output and stdin pass through; notes go to stderr. @returns {import("../core/lifecycle.mjs").LifecycleOpts} */
const passthrough = () => ({ stdin: "inherit", stdout: "inherit", stderr: "inherit", timeout: 0, log: note, say });
/** Run a lifecycle operation; its failure ends the command as the host's does. @param {() => Promise<unknown>} fn */
async function lc(fn) { try { await fn(); } catch (e) { hostFailed(e); } }

// ---------------------------------------------------------------- grants (approval is this front-end's)

/** The grant operations, in-process (controller/grants.mjs is their CLI shape). */
const grants = () => import("./grants.mjs");

// ---------------------------------------------------------------- commands

/** @typedef {(s: Selected, args: string[]) => Promise<unknown>} Command */
// (Commands are typed one by one below: their returns are void.)

/** new NAME [--shape S] [--cpus N --mem MiB --disk GiB] [--from IMAGE] [--headless [--layers L,...]] [--grant SPEC]... [--agent-forward] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdNew(s, args) {
	let name = "", from = null, headless = false, layers = null;
	/** @type {Record<string, string>} */
	const size = {};
	/** @type {string[]} */
	const specs = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i], v = args[i + 1];
		if (a === "--from") { if (!/^[a-z][a-z0-9-]{0,30}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v ?? "")) die(`invalid image name: ${v ?? ""} (use VM@SNAP)`); from = v; i++; }
		else if (a === "--grant") { if (v == null) die("--grant needs a value"); specs.push(v); i++; }
		else if (a === "--agent-forward") specs.push("ssh-agent");
		else if (a === "--headless") headless = true;
		else if (a === "--layers") { if (v == null) die("--layers needs a value"); if (!/^[a-z0-9,-]+$/.test(v)) die(`invalid layer list: ${v}`); layers = v; i++; }
		else if (a === "--shape") { if (v == null) die("--shape needs a value"); if (!VALID_VM.test(v)) die(`invalid shape name: ${v}`); size.shape = v; i++; }
		else if (["--cpus", "--mem", "--disk"].includes(a)) { if (v == null) die(`${a} needs a value`); if (!/^[0-9]+$/.test(v)) die(`${a} must be a number`); size[a.slice(2)] = v; i++; }
		else if (a.startsWith("-")) die(`unknown flag ${a}`);
		else name = a;
	}
	needVm(name);
	// Validate and approve the whole batch before creating anything.
	const approved = specs.length ? await (await grants()).confirm(s, name, specs) : [];
	await lc(() => lifecycle.newVm(name, { ...size, from, headless, layers, grants: approved }, passthrough()));
}

/** fork SRC DST... [--shape S] [--cpus N --mem MiB --disk GiB] [--grants] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdFork(s, args) {
	let src = "", copyGrants = false;
	/** @type {string[]} */
	const dsts = [];
	/** @type {Record<string, string>} */
	const size = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i], v = args[i + 1];
		if (["--cpus", "--mem", "--disk"].includes(a)) { if (v == null) die(`${a} needs a value`); if (!/^[0-9]+$/.test(v)) die(`${a} must be a number`); size[a.slice(2)] = v; i++; }
		else if (a === "--shape") { if (v == null) die("--shape needs a value"); if (!VALID_VM.test(v)) die(`invalid shape name: ${v}`); size.shape = v; i++; }
		else if (a === "--grants") copyGrants = true;
		else if (a.startsWith("-")) die(`unknown flag ${a}`);
		else { needVm(a); if (!src) src = a; else dsts.push(a); }
	}
	if (!src || !dsts.length) die("usage: boxery fork SRC DST... [--shape S] [--cpus N --mem MiB --disk GiB] [--grants]");
	const g = await grants();
	const approved = copyGrants ? await g.confirmCopy(s, src, dsts) : [];
	await lc(() => lifecycle.forkVm(src, dsts, { ...size, grants: approved }, passthrough()));
}

/** ls [--json] [--refresh] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdLs(s, args) {
	let json = false, refresh = false;
	for (const a of args) { if (a === "--json") json = true; else if (a === "--refresh") refresh = true; else die("usage: boxery ls [--json] [--refresh]"); }
	needHost(s);
	if (json) {
		/** @type {unknown[]} */
		let vms;
		try { vms = await lifecycle.listVms({ refresh }, { stderr: "inherit" }); } catch (e) { hostFailed(e); }
		return say(vms.length ? `[\n${vms.map((v) => JSON.stringify(v)).join(",\n")}\n]` : "[]");
	}
	try { say(await lifecycle.listTable({ refresh }, { stderr: "inherit" })); } catch (e) { hostFailed(e); }
}

/** patch NAME|--all [--wait S] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdPatch(s, args) {
	if (args[0] !== "--all") needVm(args[0]);
	await lc(() => lifecycle.patch(args, passthrough()));
}

/** run [--bg] NAME [--bg] [--cwd DIR] [--] CMD [ARG...] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdRun(s, args) {
	let bg = false;
	if (args[0] === "--bg") { bg = true; args = args.slice(1); }
	const usage = "usage: boxery run [--bg] NAME [--bg] [--cwd DIR] [--] CMD [ARG...]   (a shell line: ... bash -c 'A | B')";
	if (!args.length || ["-h", "--help"].includes(args[0])) {
		say(usage); process.stdout.write(RUN_EXAMPLES);
		if (!args.length) throw new CliError("", 1);
		return;
	}
	const name = needVm(args[0]);
	// The bytes of every word from NAME on, by position (the command line's own, for words that aren't UTF-8).
	const raw = rawTail(args);
	let cwd = "", i = 1;
	/** @type {Buffer} */
	let cwdRaw = Buffer.alloc(0);
	for (; i < args.length; i++) {
		if (args[i] === "--cwd") { if (!args[i + 1]) die(usage); cwd = args[++i]; cwdRaw = raw[i]; }
		else if (args[i] === "--bg") bg = true;
		else if (args[i] === "--") { i++; break; }
		else break;
	}
	const argv = args.slice(i), argvRaw = raw.slice(i);
	if (!argv.length) die(usage);
	if (bg) {
		await (await grants()).reapplyQuiet(s, name);
		const { startJob } = await import("./jobs.mjs");
		const id = await startJob(s, name, argvRaw, cwd ? cwdRaw : null);
		say(id);
		note(`boxery: started ${id} on ${name}   logs: boxery logs ${name} ${id} -f   wait: boxery wait ${name} ${id}`);
		literalNote(name, argv);
		return;
	}
	let line = literalArgs(argv);
	if (!cwd) line = `cd ~/project 2>/dev/null; ${line}`;
	else if (cwd.startsWith("/") || cwd === "~" || cwd.startsWith("~/")) line = `cd -- ${remotePath(cwd)} && ${line}`;
	else line = `cd -- ${remotePath(`~/project/${cwd}`)} && ${line}`;
	// Bytes that aren't UTF-8 can't be in our ssh's argv (Node encodes it): send that line base64.
	if (hasRawBytes([...argvRaw, cwdRaw])) line = `eval "$(printf %s ${rawLine(argvRaw, cwd ? cwdRaw : null).toString("base64")} | base64 -d)"`;
	const rc = await vmSsh(s, [`${name}.boxery`, line]);
	// The usual mistake is a whole command line in one argument; say how to run it instead.
	if (rc === 127 && /\s/.test(argv[0])) warn(`hint: run takes the command and its arguments separately; for a shell line use: boxery run ${name} bash -c ${literal(argv[0])}`);
	literalNote(name, argv);
	if (rc) throw new CliError("", rc);
}

/** run's remote command line as bytes, for arguments that aren't UTF-8: the same line, built from bytes.
 *  @param {Buffer[]} argv @param {Buffer | null} cwd */
function rawLine(argv, cwd) {
	const lit = (/** @type {Buffer} */ b) => Buffer.concat([Buffer.from("'"), Buffer.from(b.toString("latin1").replaceAll("'", "'\\''"), "latin1"), Buffer.from("'")]);
	const words = Buffer.concat(argv.flatMap((a, i) => [Buffer.from(i ? " " : ""), lit(a)]));
	const starts = (/** @type {string} */ p) => cwd?.subarray(0, p.length).equals(Buffer.from(p));
	const cd = !cwd ? Buffer.from("cd ~/project 2>/dev/null; ")
		: cwd.equals(Buffer.from("~")) ? Buffer.from('cd -- "$HOME" && ')
		: starts("~/") ? Buffer.concat([Buffer.from('cd -- "$HOME"/'), lit(cwd.subarray(2)), Buffer.from(" && ")])
		: starts("/") ? Buffer.concat([Buffer.from("cd -- "), lit(cwd), Buffer.from(" && ")])
		: Buffer.concat([Buffer.from('cd -- "$HOME"/'), lit(Buffer.concat([Buffer.from("project/"), cwd])), Buffer.from(" && ")]);
	return Buffer.concat([cd, words]);
}

/** A literal ~ or $VAR is the one argv mistake that exits 0, so point at the shell form. Commands that take
 *  code ($NF in awk, $_ in perl, a bash -c line) are skipped. @param {string} name @param {string[]} argv */
function literalNote(name, argv) {
	if (["bash", "sh", "dash", "zsh", "awk", "gawk", "mawk", "perl", "jq", "sed", "python", "python3", "node", "ruby"].includes(path.basename(argv[0]))) return;
	const a = argv.find((x) => x === "~" || x.startsWith("~/") || /\$[A-Z]/.test(x) || x.includes("${"));
	if (a !== undefined) warn(`note: ${literal(a)} was passed literally (run does not expand ~ or $VAR); to expand it in the VM: boxery run ${name} bash -c '…'`);
}

/** attach NAME [pi|opencode|shell] [session] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdAttach(s, [name = "", tool = "pi", sess = tool]) {
	needVm(name);
	if (!/^[A-Za-z0-9._-]+$/.test(sess)) die(`invalid session name: ${sess}`);
	const run = { pi: "pi", opencode: "opencode", shell: "bash -l" }[tool] ?? tool;
	await (await grants()).reapplyQuiet(s, name);
	// tmux keeps the agent alive when you disconnect (laptop sleep, network change).
	const rc = await vmSsh(s, ["-t", `${name}.boxery`, `cd ~/project 2>/dev/null; tmux has-session -t '${sess}' 2>/dev/null || tmux new-session -d -s '${sess}' -c ~/project "bash -lc '${run}; exec bash -l'"; exec tmux attach -t '${sess}'`]);
	if (rc) throw new CliError("", rc);
}

/** desktop NAME [--no-open]: core/desktop.mjs's session, its tunnel in this terminal. @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdDesktop(s, [vm, noOpen]) {
	const name = needVm(vm);
	const { openUrl, prepareDesktop, tunnelArgs } = await import("../core/desktop.mjs");
	/** @type {Awaited<ReturnType<typeof prepareDesktop>>} */
	let d;
	try { d = await prepareDesktop(name); } catch (e) { die(/** @type {Error} */ (e).message); }
	if (d.warning) warn(d.warning);
	say(`==> desktop for ${name} at ${d.url}  (Ctrl-C to close the tunnel)`);
	if (noOpen !== "--no-open") setTimeout(() => void openUrl(d.url).then((ok) => { if (!ok) say(`open: ${d.url}`); }), 1500).unref();
	await exitWith(inherit("ssh", tunnelArgs(name, d.port), { env: s.config.env }));
}

/** forward NAME PORT [LOCALPORT] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdForward(s, [name = "", rport = "", lport = rport]) {
	needVm(name);
	for (const p of [rport, lport]) if (!/^[0-9]{1,5}$/.test(p)) die("usage: boxery forward NAME PORT [LOCALPORT]");
	say(`==> localhost:${lport} -> ${name}:${rport}  (Ctrl-C to stop)`);
	await exitWith(vmSsh(s, ["-N", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${lport}:127.0.0.1:${rport}`, `${name}.boxery`]));
}
/** End the command with what P (a terminal command) exited with. @param {Promise<number>} p */
async function exitWith(p) { const rc = await p; if (rc) throw new CliError("", rc); }

/** sessions NAME [--json] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdSessions(s, [vm, flag]) {
	const name = needVm(vm);
	if (flag === undefined) return exitWith(vmSsh(s, [`${name}.boxery`, 'tmux ls 2>/dev/null || echo "(no tmux sessions)"']));
	if (flag !== "--json") die("usage: boxery sessions NAME [--json]");
	const r = await vmSshCapture(s, [`${name}.boxery`, "tmux ls -F '#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}' 2>/dev/null; true"]);
	if (r.code !== 0) die(`cannot reach ${name}`);
	const num = (/** @type {string} */ v) => (/^-?[0-9]+$/.test(v) ? Number(v) : null);
	const rows = r.stdout.split("\n").filter(Boolean).map((l) => {
		const [sn, w = "", c = "", at = ""] = l.split("\t");
		// (control characters other than tab and newline were dropped, as the Bash JSON writer did)
		return JSON.stringify({ name: sn.replace(/[\u0001-\u0008\u000b-\u001f]/g, ""), windows: num(w), created: num(c), attached: !["", "0"].includes(at) });
	});
	say(rows.length ? `[\n${rows.join(",\n")}\n]` : "[]");
}

/** prompt NAME "task" — a headless pi task in a detached tmux window, logged to ~/project/.boxery/ @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdPrompt(s, [name = "", ...words]) {
	needVm(name);
	const prompt = words.join(" ");
	if (!prompt) die('usage: boxery prompt NAME "task..."');
	const d = new Date(), p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
	const id = `task-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
	const b64 = Buffer.from(prompt).toString("base64");
	// Ship the prompt base64-encoded and write a tiny runner script: no nested shell quoting.
	const script = `set -e; d=~/project/.boxery; mkdir -p $d; echo ${b64} | base64 -d > $d/${id}.prompt
		printf '%s\\n' '#!/bin/bash -l' 'cd ~/project' 'pi -p "$(cat .boxery/${id}.prompt)" </dev/null 2>&1 | tee .boxery/${id}.log' 'echo "[boxery] task finished (exit \${PIPESTATUS[0]})" | tee -a .boxery/${id}.log' 'exec bash -l' > $d/${id}.sh
		chmod +x $d/${id}.sh; tmux new-session -d -s ${id} -c ~/project $d/${id}.sh`;
	await exitWith(vmSsh(s, [`${name}.boxery`, script]));
	say(`started ${id} on ${name} — watch: boxery attach ${name} pi ${id}   log: boxery run ${name} cat project/.boxery/${id}.log`);
}

/** cp FROM TO: vm_copy's own code. Needs only the profile's ssh_config, not the host. @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdCp(s, args) {
	if (args.length !== 2) die("usage: boxery cp FROM TO   (FROM/TO: local:PATH | NAME:PATH | HOST/NAME:PATH | PATH = local)");
	for (const a of args) if (a.startsWith("-")) die(`cp takes no options (directories copy recursively); for a local path starting with -, use local:${a}`);
	const { copy } = await import("./cp.mjs");
	await copy(s.host, args);
}

/** version [--json] @param {Selected | null} s @param {string[]} args */
async function cmdVersion(s, args) {
	const json = args[0] === "--json";
	if (args.length && !json) die("usage: boxery version [--json]");
	const c = controllerVersion(ROOT);
	let h = null, noteText = null;
	if (s?.config.host) {
		h = await withHost(s.host, hostVersion);
		noteText = h ? skewNote(c, h, s.host.name) : `host predates 'boxery-host version'; upgrade it by hand (git pull or npm update -g boxery-vm, then boxery-host init), after that: ${upgradeHint(s.host.name)}`;
	}
	if (json) return say(JSON.stringify({ controller: c, host: h ? { name: h.name, version: h.version, describe: h.describe, install: h.install } : null, behind: !!noteText }));
	say(`controller  ${c.version}${c.describe ? ` (${c.describe})` : ""}`);
	if (h) say(`host        ${h.version}${h.describe ? ` (${h.describe})` : ""}  ${h.install} install  [${s?.host.name}]`);
	else if (s?.config.host) say(`host        unknown  [${s.host.name}]`);
	if (noteText) warn(noteText);
}

/** upgrade-host [--check] [--ref REF] [--wait S] [--reinit] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdUpgradeHost(s, args) {
	needHost(s);
	if (!await withHost(s.host, hostVersion))
		die(`the boxery on ${s.config.host} predates 'upgrade'. Upgrade it once by hand: on ${s.config.host}, git pull --ff-only in the checkout (or npm update -g boxery-vm), then boxery-host init for each profile`);
	await hostPass(s, ["upgrade", ...args]);
}

/** ssh NAME [cmd...] @param {Selected} s @param {string[]} args @returns {Promise<void>} */
async function cmdSsh(s, [name = "", ...rest]) {
	needVm(name);
	await (await grants()).reapplyQuiet(s, name);
	await exitWith(vmSsh(s, ["-t", `${name}.boxery`, ...rest]));
}

/** Every command that runs against a selected host (host, setup and help are handled before one is selected). @type {Record<string, Command>} */
export const COMMANDS = {
	rm: async (s, [n]) => { needHost(s); await lc(() => lifecycle.rmVm(needVm(n), passthrough())); },
	stop: async (s, [n]) => { needHost(s); await lc(() => lifecycle.stopVm(needVm(n), passthrough())); },
	start: async (s, [n]) => { needHost(s); await lc(() => lifecycle.startVm(needVm(n), passthrough())); },
	// A resize restarts a running VM: the connection is stale afterwards and tmpfs grants are gone.
	resize: async (s, [n, ...rest]) => {
		needHost(s); needVm(n);
		/** @type {Record<string, string>} */
		const size = {};
		for (let i = 0; i < rest.length; i += 2) {
			if (!["--cpus", "--mem", "--disk"].includes(rest[i]) || rest[i + 1] == null) { await hostPass(s, ["resize", n, ...rest]); return; } // the host says what's wrong
			size[rest[i].slice(2)] = rest[i + 1] ?? "";
		}
		await lc(() => lifecycle.resizeVm(n, size, passthrough()));
	},
	// A revert restores the snapshot's tmpfs too: grants are always reconciled to the current ones.
	revert: async (s, [n, snap]) => { needHost(s); if (!VALID_SNAP.test(snap ?? "")) die(`invalid snapshot name: ${snap ?? ""}`); await lc(() => lifecycle.revertVm(needVm(n), snap, passthrough())); },
	snap: async (s, args) => { needHost(s); if (args[1] && !VALID_SNAP.test(args[1])) die(`invalid snapshot name: ${args[1]}`); await hostPass(s, ["snap", ...args]); },
	new: async (s, args) => { needHost(s); await cmdNew(s, args); },
	fork: async (s, args) => { needHost(s); await cmdFork(s, args); },
	"snap-rm": async (s, args) => { needHost(s); if (!args[1] || !VALID_SNAP.test(args[1])) die("usage: boxery snap-rm NAME SNAP"); await hostPass(s, ["snap-rm", ...args]); },
	images: async (s, args) => hostPass(s, ["images", ...args]),
	// Re-pin a VM's ssh host key on the host (a VM made before keys were pinned, or whose record was lost).
	pin: async (s, args) => {
		needHost(s); const n = needVm(args[0]);
		if (!["", "--from-guest"].includes(args[1] ?? "") || args.length > 2) die("usage: boxery pin NAME [--from-guest]");
		await lc(() => lifecycle.pinVm(n, { fromGuest: args[1] === "--from-guest" }, passthrough()));
	},
	"build-base": async (s, args) => { needHost(s); if (args.length) die("usage: boxery build-base"); await lc(() => lifecycle.buildBase(passthrough())); },
	backends: async (s, args) => hostPass(s, ["backends", ...args]),
	capabilities: async (s, args) => hostPass(s, ["capabilities", ...args]),
	shapes: async (s, args) => { needHost(s); if (!(args.length === 0 || (args.length === 1 && args[0] === "--json"))) die("usage: boxery shapes [--json]"); await hostPass(s, ["shapes", ...args]); },
	ls: cmdLs,
	list: cmdLs,
	patch: async (s, args) => { needHost(s); await cmdPatch(s, args); },
	snaps: async (s, args) => { needHost(s); needVm(args[0]); await hostPass(s, ["snaps", ...args]); },
	"proxy-log": async (s, args) => hostPass(s, ["proxy-log", ...args]),
	version: async (s, args) => cmdVersion(s, args),
	backend: async (s, args) => { needHost(s); await backendCommand(s.host, args); },
	"upgrade-host": cmdUpgradeHost,
	ssh: async (s, args) => { needHost(s); await cmdSsh(s, args); },
	cp: cmdCp,
	run: async (s, args) => { needHost(s); await cmdRun(s, args); },
	jobs: async (s, args) => { needHost(s); await (await import("./jobs.mjs")).jobs(s, args); },
	logs: async (s, args) => { needHost(s); await (await import("./jobs.mjs")).logs(s, args); },
	wait: async (s, args) => { needHost(s); await (await import("./jobs.mjs")).waitJob(s, args); },
	kill: async (s, args) => { needHost(s); await (await import("./jobs.mjs")).kill(s, args); },
	attach: async (s, args) => { needHost(s); await cmdAttach(s, args); },
	desktop: async (s, args) => { needHost(s); await cmdDesktop(s, args); },
	forward: async (s, args) => { needHost(s); await cmdForward(s, args); },
	acquire: async (s, args) => { needHost(s); await (await import("./leases.mjs")).leaseCommand(s, "acquire", args); },
	renew: async (s, args) => { needHost(s); await (await import("./leases.mjs")).leaseCommand(s, "renew", args); },
	release: async (s, args) => { needHost(s); await (await import("./leases.mjs")).leaseCommand(s, "release", args); },
	leases: async (s, args) => (await import("./leases.mjs")).leaseCommand(s, "leases", args),
	pool: async (s, args) => { needHost(s); await lc(() => lifecycle.pool(args, passthrough())); },
	// GitHub Actions runners on the host's pool (docs/github-runners.md): `once` (local runners) runs here with
	// this machine's gh login; the rest (host runners) is passed through, and `token` reads stdin.
	runners: async (s, args) => {
		needHost(s);
		if (args[0] === "once") return (await import("./runners-once.mjs")).runnersOnce(s, args.slice(1));
		await hostPass(s, ["runners", ...args]);
	},
	grant: async (s, args) => { needHost(s); await (await grants()).grant(s, args); },
	revoke: async (s, args) => { needHost(s); await (await grants()).revoke(s, args); },
	grants: async (s, args) => (await grants()).grantsCommand(s, args),
	"agent-forward": async (s, args) => (await grants()).agentForward(s, args),
	sessions: async (s, args) => { needHost(s); await cmdSessions(s, args); },
	prompt: async (s, args) => { needHost(s); await cmdPrompt(s, args); },
};

// ---------------------------------------------------------------- dispatch

/** @param {string[]} argv */
async function main(argv) {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 13)) die(`need Node >= 22.13 (this is ${process.version}); install a newer one, or set BOXERY_NODE`);
	if (/[\n\t\r]/.test(BOXERY_HOME)) die("paths cannot contain line breaks or tabs");
	let explicit = "", pinned = "";
	if (argv[0] === "--host") {
		if (argv.length < 3) die("usage: boxery --host NAME COMMAND");
		explicit = argv[1];
		if (!explicit) die("invalid host name");
		argv = argv.slice(2);
		// Internal (MCP/pi): --profile-dir binds the directory they resolved, not a registry entry that could change.
		if (argv[0] === "--profile-dir") {
			if (argv.length < 3) die("usage: boxery --host NAME --profile-dir DIR COMMAND");
			pinned = argv[1]; argv = argv.slice(2);
		}
	}
	const [cmd = "help", ...args] = argv;
	if (["help", "-h", "--help"].includes(cmd)) { process.stdout.write(USAGE + RUN_EXAMPLES); return; }
	if (cmd === "host") { if (explicit) die("--host does not apply to host management"); return hostCommand(args); }
	if (cmd === "setup") { if (explicit) die("setup takes --name NAME, not --host"); return setupNamed(args); }
	// Internal (tests): __skew CTL_VERSION CTL_DESCRIBE HOST_VERSION HOST_DESCRIBE [HOST_NAME]
	if (cmd === "__skew") { const n = skewNote({ version: args[0], describe: args[1] || null }, { version: args[2], describe: args[3] || null }, args[4] ?? ""); if (n) say(n); return; }
	// Before setup there is no host to select; version still reports the controller.
	if (cmd === "version" && !explicit && defaultHost() == null) return cmdVersion(null, args);
	const name = explicit || defaultHost();
	if (!name) die("no host configured; run: boxery setup user@host|local (or boxery host use NAME)");
	if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) die(`invalid host name: ${name}`);
	let dir;
	if (pinned) {
		if (!path.isAbsolute(pinned)) die(`invalid profile directory: ${pinned}`);
		if (/[\n\t\r]/.test(pinned)) die("paths cannot contain line breaks or tabs");
		dir = pinned;
	} else {
		// A registration whose profile was never set up (no config yet) is a host to configure, as before.
		try { dir = resolveHost(name).dir; }
		catch (e) {
			if (!/^incomplete profile:/.test(/** @type {Error} */ (e).message)) throw e;
			die(`host ${name} is not configured; run: boxery setup user@host|local --name ${name}`);
		}
	}
	const command = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
	if (!command) { process.stdout.write(USAGE + RUN_EXAMPLES); throw new CliError("", 1); }
	const s = await select(name, dir);
	await withHost(s.host, async () => {
		await refreshSshConfig({ host: s.host, warn: note });
		await command(s, args);
	});
}

/** Commands handled before a host is selected. */
export const PRE_HOST = ["help", "host", "setup", "version"];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// (stdout/stderr may be gone, e.g. `boxery ls | head`: a write error then ends quietly)
	for (const s of [process.stdout, process.stderr]) s.on("error", () => { process.exitCode ||= 1; });
	try {
		await main(commandLine());
	} catch (e) {
		const err = /** @type {Error & { exitCode?: number }} */ (e);
		if (!(err instanceof CliError) || err.message) process.stderr.write(`boxery: ${err.message.replace(/^boxery: /, "")}\n`);
		process.exitCode = err.exitCode ?? 1;
		// A terminal command (ssh, a tunnel) ended by Ctrl-C, a TERM, HUP or PIPE: end by it too, so callers see
		// WIFSIGNALED as with an exec'd ssh. (Not core-dumping signals: that would dump this process's core too.)
		const sig = (await import("./lib.mjs")).killedBy;
		if (sig && ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"].includes(sig) && err instanceof CliError && err.exitCode === 128 + (constants.signals[sig] ?? 0)) {
			for (const name of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"])) process.removeAllListeners(name);
			process.kill(process.pid, sig);
		}
	}
}
