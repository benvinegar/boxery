// The controller's trusted Bash profile plumbing (controller/profile.sh), run from Node: host transport
// (`h`), ssh_config rendering and closing a VM's shared connection. Profile configs are trusted shell
// files, so they are sourced by that one library rather than parsed here. Shared by grants and leases.
// (Imports boxery-core, which imports this module through leases/grants: fine while nothing here runs at load.)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentHost } from "./boxery-core.mjs";
/** @import { HostProfile } from "./boxery-core.mjs" */

const profileLib = fileURLToPath(new URL("../controller/profile.sh", import.meta.url));
const SCRIPT = 'set -eu; source "$1"; select_profile "$2" "$3"; shift 3; action=$1; shift; case $action in host) h_exec "$@" ;; config) write_ssh_config ;; close) drop_master "$1" ;; *) exit 2 ;; esac';
const MAX_OUTPUT = 10 * 1024 * 1024;

/**
 * Run one profile action: `host ARG…` (boxery-host on the profile's host; bash execs it, so a timeout or
 * abort signal reaches it: the host command itself for HOST=local, the ssh for a remote host, whose
 * remote command keeps running), `config` (rewrite ssh_config) or `close NAME`. Resolves with trimmed stdout.
 * stderr "inherit" passes diagnostics through (the CLI): an error that exited on its own is then
 * `reported` (already explained). Otherwise stderr is the error message. Errors from `host` are `fromHost`.
 * @param {string} action @param {string[]} [args]
 * @param {{ input?: string, signal?: AbortSignal, host?: HostProfile, timeout?: number, stderr?: "pipe" | "inherit" }} [opts]
 * @returns {Promise<string>}
 */
export function profileRun(action, args = [], { input, signal, host = currentHost(), timeout = 120_000, stderr = "pipe" } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("bash", ["-c", SCRIPT, "boxery-profile", profileLib, host.name, host.dir, action, ...args], { stdio: ["pipe", "pipe", stderr], timeout, signal });
		/** @type {Buffer[]} */
		const out = [];
		/** @type {Buffer[]} */
		const err = [];
		let size = 0;
		child.stdout?.on("data", (/** @type {Buffer} */ d) => { size += d.length; if (size > MAX_OUTPUT) child.kill(); else out.push(d); });
		let errSize = 0;
		child.stderr?.on("data", (/** @type {Buffer} */ d) => { if (errSize < 64 * 1024) { errSize += d.length; err.push(d); } });
		child.on("error", reject);
		child.on("close", (code, sig) => {
			const stdout = Buffer.concat(out).toString("utf8").trim();
			if (code === 0) return resolve(stdout);
			const why = Buffer.concat(err).toString("utf8").trim();
			const what = action === "host" ? `boxery-host ${args[0] ?? ""}` : action;
			reject(Object.assign(new Error(why || `${what} failed (${sig ? `signal ${sig}` : `exit ${code}`})`), {
				exitCode: code ?? (sig ? 128 : 1), reported: stderr === "inherit" && code !== null, fromHost: action === "host",
			}));
		});
		child.stdin?.on("error", () => {}); // EPIPE if bash exits before reading
		child.stdin?.end(input);
	});
}
