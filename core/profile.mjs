// The controller's trusted Bash profile plumbing (controller/profile.sh), run from Node: host transport
// (`h`), ssh_config rendering and closing a VM's shared connection. Profile configs are trusted shell
// files, so they are sourced by that one library rather than parsed here. Shared by grants and leases.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentHost } from "./boxery-core.mjs";
/** @import { HostProfile } from "./boxery-core.mjs" */

const profileLib = fileURLToPath(new URL("../controller/profile.sh", import.meta.url));
const SCRIPT = 'set -eu; source "$1"; select_profile "$2" "$3"; shift 3; action=$1; shift; case $action in host) h "$@" ;; need) need_host ;; config) write_ssh_config ;; close) drop_master "$1" ;; *) exit 2 ;; esac';
const MAX_OUTPUT = 10 * 1024 * 1024;

/**
 * Run one profile action: `host ARG…` (boxery-host on the profile's host), `config` (rewrite ssh_config),
 * `close NAME`, or `need` (fails, saying how to set it up, when the profile has no host). Resolves with trimmed stdout. stderr "inherit" passes the host's diagnostics through
 * (the CLI); otherwise they are the error message on failure.
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
		child.stderr?.on("data", (/** @type {Buffer} */ d) => { if (err.reduce((n, b) => n + b.length, 0) < 64 * 1024) err.push(d); });
		child.on("error", reject);
		child.on("close", (code, sig) => {
			const stdout = Buffer.concat(out).toString("utf8").trim();
			if (code === 0) return resolve(stdout);
			const why = Buffer.concat(err).toString("utf8").trim();
			reject(Object.assign(new Error(why || `${action === "host" ? `boxery-host ${args[0] ?? ""}` : action} failed (${sig ? `signal ${sig}` : `exit ${code}`})`), { exitCode: code ?? 1 }));
		});
		child.stdin?.on("error", () => {}); // EPIPE if bash exits before reading
		child.stdin?.end(input);
	});
}
