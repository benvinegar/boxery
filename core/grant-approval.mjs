// User-facing pi grant commands and flags: validate a whole batch, then ask via pi's dialog.
import { currentHost } from "./boxery-core.mjs";
import { parseGrantSpec, grantPrompt, grantCommand, addGrants } from "./grants.mjs";
/** @import { GrantSpec, Approve } from "./boxery-core.mjs" */
/** CLI-style spec arguments, also used by pi's user commands (not agent-supplied commands).
 * @param {string[]} words @returns {GrantSpec[]}
 */
export function parseGrantArgs(words) {
	if (!words.length) throw new Error("grant needs at least one spec");
	const out = [];
	for (let i = 0; i < words.length;) {
		/** @type {{ spec: string, cmd?: string, auth?: string, readonly: boolean }} */
		const a = { spec: words[i++], readonly: false };
		while (i < words.length && words[i].startsWith("--")) {
			const flag = words[i++];
			if (flag === "--readonly") a.readonly = true;
			else if (flag === "--cmd" || flag === "--auth") {
				if (i >= words.length) throw new Error(`${flag} needs a value`);
				if (flag === "--cmd") a.cmd = words[i++]; else a.auth = words[i++];
			} else throw new Error(`unknown flag ${flag}`);
		}
		out.push(parseGrantSpec(a, { cli: true }));
	}
	return out;
}
/** Preflight before allocating any VM/lease. Pool callers use VM as a placeholder until acquired.
 * @param {string} vm @param {string[]} words @param {Approve | undefined} approve
 */
export function prepareUserGrants(vm, words, approve) {
	const specs = parseGrantArgs(words);
	requireApprover(vm, specs, approve);
	return specs;
}
/** @param {string} vm @param {GrantSpec[]} specs @param {Approve | undefined} approve */
function requireApprover(vm, specs, approve) {
	if (!approve) throw new Error(`Grants need a person. Ask the user to run:\n${specs.map((g) => grantCommand("grant", vm, currentHost().name, g)).join("\n")}`);
	return approve;
}
/** Approval without side effects, for lifecycle front-ends that must create only after approval.
 * @param {string} vm @param {GrantSpec[]} specs @param {Approve | undefined} approve
 */
export async function approveGrantSpecs(vm, specs, approve) {
	const ask = requireApprover(vm, specs, approve);
	for (const g of specs) if (await ask(grantPrompt(vm, currentHost().name, g)) !== "accept") return false;
	return true;
}
/** @param {string} vm @param {string[]} words @param {Approve | undefined} approve */
export async function requestUserGrants(vm, words, approve) {
	const specs = prepareUserGrants(vm, words, approve);
	if (!await approveGrantSpecs(vm, specs, approve)) return "Grant declined; nothing was granted.";
	return addGrants(vm, specs);
}
