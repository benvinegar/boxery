// boxery cp FROM TO: the CLI front-end of vm_copy. It runs the same TOOLS entry as the MCP server and the
// pi extension, so locations, host routing and the transfer itself cannot drift (docs/copy.md).
import { constants } from "node:os";
import * as core from "../core/boxery-core.mjs";
import { TOOLS } from "../core/boxery-tools.mjs";
import { die, quit, say } from "./lib.mjs";
/** @import { Tool } from "../core/boxery-tools.mjs" */
/** @import { HostProfile } from "../core/boxery-core.mjs" */

// The CLI has no current VM: a bare path is on this machine, like cp and scp. One that only looks
// bare because its VM name is invalid (Demo:x, my_vm:x) is a typo, not a local file name.
/** @param {string} l */
const local = (l) => {
	if (!core.isBarePath(l)) return l;
	if (/^[^/]*:/.test(l)) die(`"${l}" is not a valid location (VM names are lowercase letters, digits and -); for a local path, write local:${l}`);
	return `local:${l}`;
};

/** @param {HostProfile} host @param {string[]} locs */
export async function copy(host, locs) {
	// Ctrl-C cancels like an MCP cancellation: stop both ends and remove staging before exiting.
	const abort = new AbortController();
	let interrupted = 0;
	const handlers = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]).map((sig) => /** @type {[NodeJS.Signals, () => void]} */ ([sig, () => { interrupted = 128 + constants.signals[sig]; abort.abort(); }]));
	for (const [sig, h] of handlers) process.once(sig, h);
	const tool = /** @type {Tool} */ (TOOLS.find((t) => t.name === "vm_copy"));
	try {
		const [from, to] = locs.map(local);
		const r = await core.withHost(host, () => tool.run(/** @type {any} */ (null) /* noVm: ignored */, { from, to }, /** @type {any} */ ({ localCwd: process.cwd(), signal: abort.signal }) /* no session: vm_copy needs none */));
		say(r.text);
	} catch (/** @type {any} */ e) {
		if (interrupted) { process.stderr.write(`boxery: ${e.message}\n`); quit(interrupted); }
		die(e.message);
	} finally { for (const [sig, h] of handlers) process.off(sig, h); }
}
