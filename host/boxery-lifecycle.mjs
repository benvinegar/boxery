// Lease runtime: binds lease-workflows.mjs (policy) to SQLite, the operation journal, backend effects
// and the supervisor. Each locked step runs in a supervised worker (`__call CALLBACK …`) that holds the
// VM's lifecycle lock; the held-lock entry points below check that lock before acting.
import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import * as leases from "./boxery-leases.mjs";
import { copyBuildRecord } from "./build-info.mjs";
import { reconcileAbandoned, supervise } from "./boxery-operations.mjs";
import { restoreVm } from "./images.mjs";
import { LeaseWorkflows } from "./lease-workflows.mjs";
import { setLeaseKeys } from "./pool.mjs";
import { reconcileDrift } from "./recovery.mjs";
import { issueToken } from "./seed.mjs";
/** @import { Runtime } from "./runtime.mjs" */

/** @typedef {"get" | "find" | "claim" | "commit" | "beginReset" | "finish" | "candidates" | "due" | "renew"} StoreMethod */
/** boxery-leases.mjs bound to one database. @typedef {{ [K in StoreMethod]: (typeof leases)[K] extends (db: any, ...a: infer A) => infer R ? (...a: A) => R : never }} Store */

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const nameOf = (/** @type {string} */ name) => {
	if (!leases.VALID_NAME.test(name ?? "")) throw new Error(`invalid name '${name ?? ""}' (use [a-z][a-z0-9-]*)`);
	return name;
};
const leaseOf = (/** @type {string} */ id) => {
	if (!/^l-[0-9a-f]{32}$/.test(id ?? "")) throw new Error("invalid lease id");
	return id;
};

/** @template {Record<string, string | number>} T @param {string[]} args @param {T} defaults @param {Record<string, keyof T & string>} flags @returns {T} */
export function parseOptions(args, defaults, flags) {
	const result = /** @type {Record<string, string | number>} */ ({ ...defaults });
	for (let i = 0; i < args.length; i++) {
		if (!Object.hasOwn(flags, args[i])) throw new Error(`unknown flag ${args[i]}`);
		const key = flags[args[i]];
		const value = args[++i];
		if (value == null) throw new Error(`${args[i - 1]} needs a value`);
		const text = ["holder", "only"].includes(key); // the rest are numbers
		if (!text && !/^\d+$/.test(value)) throw new Error(`${args[i - 1]} must be a number`);
		result[key] = text ? value : Number(value);
	}
	return /** @type {T} */ (result);
}

/** --json anywhere in ARGS: [true, ARGS without it]. @param {string[]} args @returns {[boolean, string[]]} */
const jsonFlag = (args) => [args.includes("--json"), args.filter((a) => a !== "--json")];

/** Write to stdout; false if nobody reads it any more (EPIPE: the client is gone). @param {string} text @returns {Promise<boolean>} */
function writeOut(text) {
	return new Promise((resolve) => {
		// The 'error' event can follow the write callback (host/cli.mjs keeps a listener for it too).
		const gone = () => resolve(false);
		process.stdout.once("error", gone);
		process.stdout.write(text, (e) => { process.stdout.off("error", gone); resolve(!e); });
	});
}

/**
 * Release a lease whose client left before it got it. In a child of its own whose output goes to
 * CONF/lease-orphans.log: ours went to the client, and is closed (a backend writing to it during the
 * reset would die of SIGPIPE, and the VM end up BROKEN).
 * @param {Runtime} rt @param {string} name @param {string} lease
 */
async function releaseOrphan(rt, name, lease) {
	const logFile = path.join(rt.conf, "lease-orphans.log");
	const fd = openSync(logFile, "a", 0o600);
	try {
		writeSync(fd, `${new Date().toISOString()} ${name}: the client left before it got lease ${lease}; releasing it\n`);
		const host = fileURLToPath(new URL("./boxery-host.mjs", import.meta.url));
		const code = await new Promise((resolve) => {
			const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", host, "release", lease], { stdio: ["ignore", fd, fd], env: process.env });
			child.on("error", () => resolve(127));
			child.on("close", (c) => resolve(c ?? 1));
		});
		if (code !== 0) writeSync(fd, `${new Date().toISOString()} ${name}: release of ${lease} failed (exit ${code}); the reaper resets it when it expires\n`);
	} finally { closeSync(fd); }
}

/** @returns {Promise<string>} */
function publicKey() {
	return new Promise((resolve, reject) => {
		const input = createInterface({ input: process.stdin, terminal: false });
		input.once("error", reject);
		input.once("line", (line) => {
			resolve(line); input.close();
			// readline.close() leaves the underlying pipe open. We consumed the only input
			// this command needs; a client retaining its write end must not keep Node alive.
			process.stdin.pause();
			process.stdin.unref?.();
		});
		input.once("close", () => resolve(""));
	});
}

/** acquire | renew | release | reap | reconcile, and the held-lock entry points
 * (reset, install-held, release-held, reset-held, reap-held). rt: runtime.mjs
 * @param {Runtime} rt @param {string} command @param {string[]} args */
export async function runLifecycle(rt, command, args) {
	const db = rt.db();
	const requireLock = (/** @type {string} */ name) => rt.requireLock(nameOf(name));
	/** @param {string} name @param {string} callback @param {unknown[]} argv */
	const lock = async (name, callback, argv) => {
		const rc = await supervise({ conf: rt.conf, names: [nameOf(name)], command: callback, args: ["__call", callback, ...argv.map(String)], env: rt.operationEnv() });
		// The worker reported its own error.
		if (rc !== 0) throw Object.assign(new Error(`${callback} ${name} failed`), { exitCode: rc, reported: true });
	};
	const store = /** @type {Store} */ (Object.fromEntries(/** @type {StoreMethod[]} */ (["get", "find", "claim", "commit", "beginReset", "finish", "candidates", "due", "renew"])
		.map((method) => [method, (/** @type {any[]} */ ...argv) => /** @type {(...a: any[]) => unknown} */ (leases[method])(db, ...argv)])));
	const backend = {
		clearEdge: async (/** @type {string} */ name) => rt.clearEdge(nameOf(name)),
		issueToken: (/** @type {string} */ name, /** @type {string} */ lease) => issueToken(rt, nameOf(name), leaseOf(lease)),
		revokeToken: async (/** @type {string} */ name) => rt.deleteToken(nameOf(name)),
		/** @param {string} name @param {string} label */
		async restore(name, label) {
			await restoreVm(rt.vms, nameOf(name), label, { quiet: true });
			copyBuildRecord(rt.conf, `${name}@${label}`, name); // back to the clean image's software
		},
		waitReady: async (/** @type {string} */ name) => rt.waitSsh(nameOf(name), await rt.vms.waitEndpoint(nameOf(name), { quiet: true }), Number(rt.env.BOXERY_SSH_WAIT_TRIES || 45)),
		/** @param {string} name */
		async stepClock(name) {
			if (await rt.guest.run(await rt.vms.sshEndpoint(nameOf(name)), `sudo date -u -s @${now()} >/dev/null 2>&1; true`) !== 0) throw new Error(`${name}: could not reach the guest`);
		},
		setKeys: (/** @type {string} */ name, /** @type {string | undefined} */ pubkey) => setLeaseKeys(rt, nameOf(name), pubkey),
	};
	const journal = { intent: (/** @type {string} */ kind, /** @type {string[]} */ data) => rt.intent(kind, ...data), done: (/** @type {string} */ id) => rt.done(id) };
	/** @type {LeaseWorkflows} */
	let flows;
	const reclaim = async () => {
		await reconcileAbandoned(rt.conf);
		await flows.reapCandidates();
		await reconcileDrift({ backend: rt.vms, db, conf: rt.conf, lock });
	};
	flows = new LeaseWorkflows({ store, backend, journal, lock, reclaim, now, sleep, log: rt.log });
	switch (command) {
		case "acquire": {
			// --only A,B: lease one of these pool VMs and no other (the GitHub runner manager, host/runners.mjs).
			// --json: {"name","lease_id","expires_at"} (docs/cli.md); without it the line "NAME LEASE_ID EXPIRES" older controllers read.
			const [json, rest] = jsonFlag(args);
			const { only, ...options } = parseOptions(rest, { holder: "", ttl: 1800, wait: 0, only: "" }, { "--holder": "holder", "--ttl": "ttl", "--wait": "wait", "--only": "only" });
			const claim = await flows.acquire({ ...options, ...(only ? { only: only.split(",").map(nameOf) } : {}), pubkey: await publicKey() });
			const reply = json ? `${JSON.stringify({ name: claim.name, lease_id: claim.lease_id, expires_at: claim.expires_at })}\n` : `${claim.name} ${claim.lease_id} ${claim.expires_at}\n`;
			// A client that left while we waited (Ctrl-C, a timeout: ssh gone, nobody reading) would never learn
			// of this lease, nor renew or release it. Its reply can't be written then: give the VM back.
			if (!await writeOut(reply)) {
				await releaseOrphan(rt, claim.name, claim.lease_id);
				throw Object.assign(new Error("the client left before it got its lease (released it)"), { exitCode: 1 });
			}
			break;
		}
		case "renew": {
			const [json, rest] = jsonFlag(args);
			const id = leaseOf(rest[0]);
			const { ttl } = parseOptions(rest.slice(1), { ttl: 1800 }, { "--ttl": "ttl" });
			const row = store.renew(id, ttl);
			process.stdout.write(json ? `${JSON.stringify({ name: row.name, lease_id: id, expires_at: row.expires_at })}\n` : `${row.name} ${row.expires_at}\n`);
			break;
		}
		case "release": await flows.release(leaseOf(args[0])); break;
		case "reap": case "reconcile": await reclaim(); break;
		case "reset": // takes the VM's lock itself (private entry point `__call lease_reset`)
			await lock(nameOf(args[0]), "_lease_reset", args); break;
		case "install-held":
			requireLock(args[0]); await flows.install(...(/** @type {Parameters<LeaseWorkflows["install"]>} */ (args))); break;
		case "release-held": {
			const row = store.find(leaseOf(args[0]));
			if (!row) throw Object.assign(new Error("unknown or inactive lease"), { exitCode: 2 });
			requireLock(row.name); await flows.releaseHeld(args[0]); break;
		}
		case "reset-held":
			requireLock(args[0]); await flows.reset(...(/** @type {Parameters<LeaseWorkflows["reset"]>} */ (args))); break;
		case "reap-held":
			requireLock(args[0]); await flows.reapHeld(...(/** @type {Parameters<LeaseWorkflows["reapHeld"]>} */ (args))); break;
		default: throw new Error(`unknown lifecycle command: ${command}`);
	}
}
