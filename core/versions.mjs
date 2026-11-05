// This controller's version, the selected host's, and whether the host is behind (boxery version, vm_info
// version). The host answers `boxery-host version --json` (host/boxery-upgrade.mjs).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentHost, defaultHost } from "./boxery-core.mjs";
import { hostRun, profileConfig } from "./profile.mjs";

/** @typedef {{ version: string, describe: string | null }} ControllerVersion */
/** @typedef {{ name: string, version: string, describe: string | null, install: string }} HostVersion */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** package.json's version, plus git describe in a checkout. @returns {ControllerVersion} */
export function controllerVersion(root = ROOT) {
	let version = "unknown", describe = null;
	try { version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version || "unknown"; } catch { /* unknown */ }
	if (existsSync(path.join(root, ".git"))) {
		try { describe = execFileSync("git", ["-C", root, "describe", "--tags", "--always", "--dirty"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { /* no git */ }
	}
	return { version, describe };
}

/** The selected host's version, or null for a host that predates `boxery-host version` (or can't say).
 *  @returns {Promise<HostVersion | null>} */
export async function hostVersion() {
	let j;
	try { j = JSON.parse(await hostRun(["version", "--json"], { timeout: 60_000 })); } catch { return null; }
	if (typeof j?.version !== "string") return null;
	return { name: currentHost().name, version: j.version, describe: typeof j.describe === "string" ? j.describe : null, install: typeof j.install === "string" ? j.install : "unknown" };
}

/** Is release A older than B? (MAJOR.MINOR.PATCH; anything after is ignored) @param {string} a @param {string} b */
export function versionLt(a, b) {
	const parts = (/** @type {string} */ v) => v.replace(/^v/, "").replace(/[^0-9.].*$/, "").split(".").slice(0, 3).map((x) => Number(x) || 0);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
	return false;
}
/** git describe → commits since its tag (v0.7.0-15-gabc → 15; a bare tag → 0; unknown → null). @param {string | null} d */
function describeAhead(d) {
	const m = /^v.*-([0-9]+)-g[0-9a-f]+(-dirty)?$/.exec(d ?? "");
	return m ? Number(m[1]) : d?.startsWith("v") ? 0 : null;
}
/** How the user upgrades HOST from here. @param {string} host */
export function upgradeHint(host) {
	let def = null;
	try { def = defaultHost(); } catch { /* none */ }
	return host === def ? "boxery upgrade-host" : `boxery --host ${host} upgrade-host`;
}
/** A note when the host is behind the controller, else null. @param {ControllerVersion} c @param {{ version: string, describe: string | null }} h @param {string} host */
export function skewNote(c, h, host) {
	let behind = versionLt(h.version, c.version);
	if (!behind && h.version === c.version && c.describe && h.describe) {
		const ca = describeAhead(c.describe), ha = describeAhead(h.describe);
		behind = ca != null && ha != null && c.describe.split("-")[0] === h.describe.split("-")[0] && ha < ca;
	}
	return behind ? `host ${h.describe || h.version} is older than this controller (${c.describe || c.version}); upgrade it: ${upgradeHint(host)}` : null;
}

/** {controller, host, behind, note} for the selected host (host null before setup or for an old host).
 *  @param {{ withHost?: boolean }} [opts] */
export async function versions({ withHost = true } = {}) {
	const controller = controllerVersion();
	if (!withHost) return { controller, host: null, behind: false, note: null };
	const name = currentHost().name;
	const configured = !!(await profileConfig().catch(() => ({ host: "" }))).host;
	if (!configured) return { controller, host: null, behind: false, note: null };
	const host = await hostVersion();
	const note = host ? skewNote(controller, host, name)
		: `host predates 'boxery-host version'; upgrade it by hand (git pull or npm update -g boxery-vm, then boxery-host init), after that: ${upgradeHint(name)}`;
	return { controller, host, behind: !!note, note, configured };
}
