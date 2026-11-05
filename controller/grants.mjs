// boxery grant | revoke | grants | agent-forward, and the approval new --grant and fork --grants need.
// The operations are core/grants.mjs (shared with vm_grant); this front-end owns the person in the loop:
// every new grant is shown on the controlling terminal (/dev/tty) and needs a yes, unless the selected
// profile's config says GRANT_CONFIRM=off (read from the file literally, never from the environment).
import { closeSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { formatGrants, hostBackend } from "../core/boxery-core.mjs";
import { parseGrantArgs } from "../core/grant-approval.mjs";
import { addGrants, applyGrants, grantCommand, grantPrompt, listGrants, revokeGrants, storedSpecs } from "../core/grants.mjs";
import { CliError, VALID_VM, die, needHost, needVm, note, say, warn } from "./lib.mjs";
/** @import { GrantSpec } from "../core/boxery-core.mjs" */
/** @import { Selected } from "./lib.mjs" */

const PUSHED = new Set(["env", "file", "http", "llm"]);
/** Grant commands may ask on this terminal (an env --cmd helper's prompt). */
const interactive = { interactiveCommands: true };

/** @param {Selected} s */
function refuseOpenShell(s) {
	if (hostBackend(s.host) === "openshell") die("OpenShell credentials and egress are managed through OpenShell providers/policy, not Boxery grants");
}

/** Validate SPEC words into canonical specs, before anything is asked or changed. @param {Selected} s @param {string[]} words */
export function prepare(s, words) {
	refuseOpenShell(s);
	try { return parseGrantArgs(words); } catch (e) { return die(/** @type {Error} */ (e).message); }
}

/** GRANT_CONFIRM=off, the last such line of the profile's config, literally. @param {Selected} s */
function unattended(s) {
	let text = "";
	try { text = readFileSync(path.join(s.host.dir, "config"), "utf8"); } catch { return false; }
	const last = text.split("\n").filter((l) => /^\s*GRANT_CONFIRM=/.test(l)).at(-1) ?? "";
	return /^\s*GRANT_CONFIRM=(?:off|'off'|"off")\s*(?:#.*)?$/.test(last);
}

/** Ask the person at this terminal to approve SPECS for VM; a no ends the command. @param {Selected} s @param {string} vm @param {GrantSpec[]} specs */
function ask(s, vm, specs) {
	const prompt = specs.map((g) => grantPrompt(vm, s.host.name, g, undefined)).join("\n\n");
	if (unattended(s)) return;
	let tty;
	try { tty = openSync("/dev/tty", "r+"); }
	catch { die(`grants need a person. Ask the user to run the command below, or use vm_grant:\n${specs.map((g) => grantCommand("grant", vm, s.host.name, g)).join("\n")}`); }
	let answer = "";
	try {
		writeSync(tty, `${prompt}\n\nAllow access? [y/N] `);
		const buf = Buffer.alloc(1);
		for (;;) {
			let n = 0;
			try { n = readSync(tty, buf, 0, 1, null); } catch { break; }
			if (n === 0 || buf[0] === 0x0a) break;
			answer += String.fromCharCode(buf[0]);
		}
	} finally { closeSync(tty); }
	if (!["y", "Y", "yes", "YES"].includes(answer.replace(/\r$/, ""))) die("grant declined; nothing was granted");
}

/** Validate and approve SPEC words for VM (new --grant, grant). @param {Selected} s @param {string} vm @param {string[]} words */
export function confirm(s, vm, words) {
	const specs = prepare(s, words);
	ask(s, vm, specs);
	return specs;
}

/** fork --grants: SRC's grants, revalidated and approved for each DST (none if SRC has none).
 *  @param {Selected} s @param {string} src @param {string[]} dsts @returns {Promise<GrantSpec[]>} */
export async function confirmCopy(s, src, dsts) {
	if (!listGrants(src).length) return [];
	refuseOpenShell(s);
	let specs;
	try { specs = storedSpecs(src); } catch (e) { return die(/** @type {Error} */ (e).message); }
	for (const d of dsts) ask(s, d, specs);
	return specs;
}

/** grant NAME SPEC... [--cmd CMD] … @param {Selected} s @param {string[]} args */
export async function grant(s, args) {
	needHost(s);
	const vm = needVm(args[0]);
	const specs = confirm(s, vm, args.slice(1));
	try { say(await addGrants(vm, specs, interactive)); } catch (e) { die(/** @type {Error} */ (e).message); }
}

/** revoke NAME SPEC...|all @param {Selected} s @param {string[]} args */
export async function revoke(s, args) {
	needHost(s);
	const vm = needVm(args[0]);
	try { say(await revokeGrants(vm, args.slice(1), interactive)); } catch (e) { die(/** @type {Error} */ (e).message); }
}

/** grants NAME [apply [--quiet] | --json] @param {Selected} s @param {string[]} args */
export async function grantsCommand(s, [vm, sub, flag]) {
	needVm(vm);
	try {
		if (sub === "apply") {
			needHost(s); refuseOpenShell(s);
			const out = await applyGrants(vm, interactive);
			if (flag === "--quiet") for (const line of out.split("\n")) { if (line.startsWith("boxery:")) note(line); }
			else say(out);
		} else if (sub === "--json") say(JSON.stringify(listGrants(vm)));
		else if (sub === undefined) say(formatGrants(vm, listGrants(vm)));
		else die("usage: boxery grants NAME [apply [--quiet] | --json]");
	} catch (e) { if (e instanceof CliError) throw e; die(/** @type {Error} */ (e).message); }
}

/** agent-forward NAME on|off @param {Selected} s @param {string[]} args */
export async function agentForward(s, args) {
	if (args.length !== 2) die("usage: boxery agent-forward NAME on|off");
	if (args[1] === "on") return grant(s, [args[0], "ssh-agent"]);
	if (args[1] === "off") return revoke(s, [args[0], "ssh-agent"]);
	die("usage: boxery agent-forward NAME on|off");
}

/** Before a connection that needs them (ssh, attach, run --bg): push VM's pushed grants again (they live in
 *  tmpfs). Quiet but for warnings; never fails the command. @param {Selected} s @param {string} vm */
export async function reapplyQuiet(s, vm) {
	if (!VALID_VM.test(vm)) return;
	try {
		if (!listGrants(vm).some((g) => PUSHED.has(g.kind))) return;
		refuseOpenShell(s);
		const out = await applyGrants(vm, interactive);
		for (const line of out.split("\n")) if (line.startsWith("boxery:")) note(line);
	} catch (e) { warn(/** @type {Error} */ (e).message); }
}
