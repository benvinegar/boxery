// boxery cp FROM TO: the CLI front-end of vm_copy. It runs the same TOOLS entry as the MCP server
// and the pi extension, so locations, host routing and the transfer itself cannot drift (docs/copy.md).
// Run by controller/boxery as: node cp.mjs HOST FROM TO, HOST being the profile it selected.
import { constants } from "node:os";
import * as core from "../core/boxery-core.mjs";
import { TOOLS } from "../core/boxery-tools.mjs";
/** @import { Tool } from "../core/boxery-tools.mjs" */

const [host, ...locs] = process.argv.slice(2);
if (!host || locs.length !== 2) {
	console.error("usage: boxery cp FROM TO");
	process.exit(2);
}
// The CLI has no current VM: a bare path is on this machine, like cp and scp. One that only looks
// bare because its VM name is invalid (Demo:x, my_vm:x) is a typo, not a local file name.
const local = (/** @type {string} */ l) => {
	if (!core.isBarePath(l)) return l;
	if (/^[^/]*:/.test(l)) throw new Error(`"${l}" is not a valid location (VM names are lowercase letters, digits and -); for a local path, write local:${l}`);
	return `local:${l}`;
};

// Ctrl-C cancels like an MCP cancellation: stop both ends and remove staging before exiting.
const abort = new AbortController();
for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
	process.once(sig, () => {
		process.exitCode = 128 + constants.signals[sig];
		abort.abort();
	});
}

const copy = /** @type {Tool} */ (TOOLS.find((t) => t.name === "vm_copy"));
try {
	const [from, to] = locs.map(local);
	const r = await core.withHost(host, () => copy.run(/** @type {any} */ (null) /* noVm: ignored */, { from, to }, /** @type {any} */ ({ localCwd: process.cwd(), signal: abort.signal }) /* no session: vm_copy needs none */));
	console.log(r.text);
} catch (/** @type {any} */ e) {
	console.error(`boxery: ${e.message}`);
	process.exitCode ||= 1;
}
