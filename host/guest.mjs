// ssh from the host into its VMs as `agent`, with the host's own management key. Like backend calls,
// every ssh stays in the caller's process group; its stdout goes to our stderr (never our output).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Replaces authorized_keys atomically (the guest never sees a half-written file).
const WRITE_KEYS = "umask 077; mkdir -p ~/.ssh && cat >~/.ssh/authorized_keys.boxery && mv ~/.ssh/authorized_keys.boxery ~/.ssh/authorized_keys";

export function createGuest({ conf, env = process.env }) {
	const key = path.join(conf, "mgmt_ed25519");
	const opts = ["-o", "IdentitiesOnly=yes", "-o", `IdentityFile=${key}`, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
		"-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=5"];

	/** Run COMMAND in the guest at {host, port}; resolves with its exit status (255 = ssh failed). */
	function run({ host, port }, command, { input, quiet = false } = {}) {
		return new Promise((resolve, reject) => {
			const child = spawn("ssh", [...opts, "-p", String(port), `agent@${host}`, command], {
				env, stdio: [input == null ? "ignore" : "pipe", quiet ? "ignore" : 2, quiet ? "ignore" : 2],
			});
			child.on("error", reject);
			child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
			if (input != null) {
				child.stdin.on("error", () => {}); // a guest that exits early must not crash us (EPIPE)
				child.stdin.end(input);
			}
		});
	}

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
		catch (e) { if (e.code === "ENOENT") return []; throw e; }
	}

	return {
		run,
		hostPubkey,
		registeredKeys,
		/** Pet VMs accept the host and every registered controller. */
		petKeys: () => [...new Set([hostPubkey(), ...registeredKeys()])].filter(Boolean).sort(),
		/** Wait until sshd answers. tries × 2 s (BOXERY_SSH_WAIT_TRIES, default 180 = 6 min). */
		async waitSsh(ep, tries = Number(env.BOXERY_SSH_WAIT_TRIES || 180)) {
			for (let i = 0; i < tries; i++) {
				if (await run(ep, "true", { quiet: true }) === 0) return;
				if (i < tries - 1) await sleep(2000);
			}
			throw new Error(`timed out waiting for ssh on ${ep.host}:${ep.port}`);
		},
		/** authorized_keys in the guest := exactly these keys. */
		async setKeys(ep, keys) {
			if (await run(ep, WRITE_KEYS, { input: `${keys.join("\n")}\n` }) !== 0) throw new Error(`could not set ssh keys on ${ep.host}:${ep.port}`);
		},
	};
}
