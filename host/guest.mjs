// ssh from the host into its VMs as `agent`, with the host's own management key. Like backend calls,
// every ssh stays in the caller's process group; its stdout goes to our stderr (never our output).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { hostAlias, hostKeyFile } from "./hostkeys.mjs";
/** @import { Writable } from "node:stream" */
/** @import { EndpointProblem } from "./backend.mjs" */

/** @typedef {{ host: string, port: string | number, name?: string }} GuestEndpoint */
/** @typedef {ReturnType<typeof createGuest>} Guest */

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
// Replaces authorized_keys atomically (the guest never sees a half-written file).
const WRITE_KEYS = "umask 077; mkdir -p ~/.ssh && cat >~/.ssh/authorized_keys.boxery && mv ~/.ssh/authorized_keys.boxery ~/.ssh/authorized_keys";

/** @param {{ conf: string, env?: NodeJS.ProcessEnv }} opts */
export function createGuest({ conf, env = process.env }) {
	const key = path.join(conf, "mgmt_ed25519");
	const opts = ["-o", "IdentitiesOnly=yes", "-o", `IdentityFile=${key}`, "-o", "BatchMode=yes", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=5"];
	// The VM's pinned host key (hostkeys.mjs), checked strictly. A VM without a record is refused (ssh:
	// "No ED25519 host key is known"); there is no way to reach a VM without checking its key.
	const hostKeyOpts = (/** @type {string | undefined} */ name) => {
		if (!name) throw new Error("guest ssh needs the VM's name (its pinned host key)");
		return ["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${hostKeyFile(conf, name)}`, "-o", "GlobalKnownHostsFile=/dev/null",
			"-o", `HostKeyAlias=${hostAlias(name)}`, "-o", "CheckHostIP=no", "-o", "UpdateHostKeys=no"];
	};

	/** Run COMMAND in VM NAME's guest at {host, port}; resolves with its exit status (255 = ssh failed,
	 *  also when the guest's host key isn't NAME's) and, with capture, its stdout (else it goes to our stderr).
	 *  @param {GuestEndpoint} ep @param {string} command @param {{ input?: string | null, quiet?: boolean, capture?: boolean }} opts
	 *  @returns {Promise<{ code: number, out: string }>} */
	function exec({ host, port, name }, command, { input, quiet = false, capture = false }) {
		return new Promise((resolve, reject) => {
			const child = spawn("ssh", [...opts, ...hostKeyOpts(name), "-p", String(port), `agent@${host}`, command], {
				env, stdio: [input == null ? "ignore" : "pipe", capture ? "pipe" : quiet ? "ignore" : 2, quiet ? "ignore" : 2],
			});
			/** @type {Buffer[]} */
			const chunks = [];
			child.stdout?.on("data", (/** @type {Buffer} */ d) => chunks.push(d));
			child.on("error", reject);
			child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), out: Buffer.concat(chunks).toString("utf8") }));
			if (input != null) {
				/** @type {Writable} */ (child.stdin).on("error", () => {}); // a guest that exits early must not crash us (EPIPE)
				/** @type {Writable} */ (child.stdin).end(input);
			}
		});
	}
	/** Run COMMAND in the guest; resolves with its exit status. @param {GuestEndpoint} ep @param {string} command
	 *  @param {{ input?: string | null, quiet?: boolean }} [opts] @returns {Promise<number>} */
	const run = async (ep, command, opts = {}) => (await exec(ep, command, opts)).code;

	/** This host's public key; the key pair is created on first use (works without an ssh-agent). */
	function hostPubkey() {
		if (!existsSync(key)) {
			const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `boxery-host@${hostname()}`, "-f", key], { env, stdio: ["ignore", 2, 2] });
			if (r.status !== 0) throw new Error("could not create the host's management key");
		}
		return readFileSync(`${key}.pub`, "utf8").trim();
	}
	/** Keys registered by controllers (`add-key`). */
	function registeredKeys() {
		try { return readFileSync(path.join(conf, "authorized_keys"), "utf8").split("\n").filter(Boolean); }
		catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return []; throw e; }
	}

	return {
		run,
		/** Run COMMAND in the guest and collect its stdout (its stderr is discarded).
		 *  @param {GuestEndpoint} ep @param {string} command @param {{ input?: string | null }} [opts] */
		output: (ep, command, { input } = {}) => exec(ep, command, { input, quiet: true, capture: true }),
		hostPubkey,
		registeredKeys,
		/** Pet VMs accept the host and every registered controller. */
		petKeys: () => [...new Set([hostPubkey(), ...registeredKeys()])].filter(Boolean).sort(),
		/** Wait until sshd answers. tries × 2 s (BOXERY_SSH_WAIT_TRIES, default 180 = 6 min). problem: async
		 *  () => null | {fatal, message}, asked after each failed try: give up at once when it is fatal (there
		 *  is no way in), and say why on a timeout. prepare: run before each try.
		 *  @param {GuestEndpoint} ep @param {number} [tries] @param {() => Promise<EndpointProblem | null>} [problem]
		 *  @param {() => Promise<void>} [prepare] */
		async waitSsh(ep, tries = Number(env.BOXERY_SSH_WAIT_TRIES || 180), problem = async () => null, prepare = async () => {}) {
			/** @type {EndpointProblem | null} */
			let why = null;
			for (let i = 0; i < tries; i++) {
				await prepare(); // e.g. pin the VM's host key once it can be read (hostkeys.mjs)
				if (await run(ep, "true", { quiet: true }) === 0) return;
				why = await problem();
				if (why?.fatal) throw new Error(why.message);
				if (i < tries - 1) await sleep(2000);
			}
			throw new Error(`timed out waiting for ssh on ${ep.host}:${ep.port}${why?.message ? `: ${why.message}` : ""}`);
		},
		/** authorized_keys in the guest := exactly these keys. @param {GuestEndpoint} ep @param {string[]} keys */
		async setKeys(ep, keys) {
			if (await run(ep, WRITE_KEYS, { input: `${keys.join("\n")}\n` }) !== 0) throw new Error(`could not set ssh keys on ${ep.host}:${ep.port}`);
		},
	};
}
