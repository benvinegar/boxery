// Lease runtime: binds lease-workflows.mjs (policy) to SQLite, the operation journal, backend effects
// and the supervisor. Each locked step runs in a supervised worker (`__call CALLBACK …`) that holds the
// VM's lifecycle lock; the held-lock entry points below check that lock before acting.
import { createInterface } from "node:readline";
import * as leases from "./boxery-leases.mjs";
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
		restore: (/** @type {string} */ name, /** @type {string} */ label) => restoreVm(rt.vms, nameOf(name), label, { quiet: true }),
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
			const { only, ...options } = parseOptions(args, { holder: "", ttl: 1800, wait: 0, only: "" }, { "--holder": "holder", "--ttl": "ttl", "--wait": "wait", "--only": "only" });
			const claim = await flows.acquire({ ...options, ...(only ? { only: only.split(",").map(nameOf) } : {}), pubkey: await publicKey() });
			process.stdout.write(`${claim.name} ${claim.lease_id} ${claim.expires_at}\n`);
			break;
		}
		case "renew": {
			const id = leaseOf(args[0]);
			const { ttl } = parseOptions(args.slice(1), { ttl: 1800 }, { "--ttl": "ttl" });
			const row = store.renew(id, ttl);
			process.stdout.write(`${row.name} ${row.expires_at}\n`);
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
