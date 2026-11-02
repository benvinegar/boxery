// What a host command works with: configuration, the backend, guest ssh, the SQLite store, and (inside
// a supervised worker) its operation: held locks and the intent journal (docs/lifecycle.md).
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createBackend } from "./backend.mjs";
import * as leases from "./boxery-leases.mjs";
import { completeIntent, readToken, recordIntent, updateToken } from "./boxery-operations.mjs";
import { loadConfig } from "./config.mjs";
import { createGuest } from "./guest.mjs";
import { ensureHostKey } from "./hostkeys.mjs";
import { loadShapes } from "./shapes.mjs";
import { fail, log } from "./util.mjs";
/** @import { DatabaseSync } from "node:sqlite" */
/** @import { Token } from "./boxery-operations.mjs" */
/** @import { GuestEndpoint } from "./guest.mjs" */

/** The object every host command works with (`rt`). @typedef {ReturnType<typeof createRuntime>} Runtime */

export function createRuntime(env = process.env) {
	const config = loadConfig(env);
	const backends = path.join(config.root, "host", "backends");
	if (!existsSync(path.join(backends, `${config.backend}.sh`))) {
		const have = readdirSync(backends).filter((f) => f.endsWith(".sh")).map((f) => f.slice(0, -3)).sort();
		fail(`unknown backend '${config.backend}' (have: ${have.map((b) => `${b} `).join("")})`);
	}
	/** @type {DatabaseSync | undefined} */
	let db;
	const rt = {
		...config,
		log,
		vms: createBackend(config.env),
		guest: createGuest(config),
		/** Wait for NAME's sshd at EP, asking the backend why it can't be reached (exe: its tunnel). Before
		 *  each try, NAME's host key is refreshed or, if it has none, pinned through a trusted channel
		 *  (hostkeys.mjs); without one, ssh refuses NAME and the timeout says how to pin it.
		 *  @param {string} name @param {GuestEndpoint} ep @param {number} [tries] */
		waitSsh: (name, ep, tries) => {
			/** @type {string | null} */
			let keyProblem = null;
			return rt.guest.waitSsh(ep, tries,
				async () => (await rt.vms.endpointProblem(name)) ?? (keyProblem ? { fatal: false, message: keyProblem } : null),
				async () => { keyProblem = await ensureHostKey(rt, name, ep); });
		},
		db: () => (db ??= leases.open(path.join(config.conf, "leases.db"))),
		close: () => db?.close(),
		shapes: () => loadShapes(config.root, config.conf),
		/** Settings a supervised operation journals (the backend pinned to the one resolved now). */
		operationEnv: () => ({ ...config.env, BOXERY_BACKEND: config.backend }),
		// Inside a worker: the operation and the resources it holds.
		operationId: env.BOXERY_OPERATION_ID,
		holds: (/** @type {string} */ name) => (env.BOXERY_LOCKS ?? "").includes(`:${name}:`),
		requireLock: (/** @type {string} */ name) => { if (!rt.holds(name)) fail(`lifecycle lock required for ${name}`); },
		/** Journal intent after preflight, before side effects; `done` once the unit of work is complete. @param {string} kind @param {...unknown} data */
		intent: (kind, ...data) => recordIntent(rt.db(), rt.operationId, kind, data.map(String)),
		done: (/** @type {string} */ id) => completeIntent(rt.db(), rt.operationId, id),
		token: (/** @type {string} */ name) => readToken(config.conf, name),
		/** @param {string} name @param {Token} value */
		setToken: (name, value) => updateToken(rt.db(), config.conf, name, value),
		deleteToken: (/** @type {string} */ name) => updateToken(rt.db(), config.conf, name, undefined),
		clearEdge: (/** @type {string} */ name) => rmSync(path.join(config.conf, "edge", `${name}.json`), { force: true }),
		/** null when NAME is not in the pool; fails closed if the store can't be read. @param {string} name */
		poolRow: (name) => { try { return leases.get(rt.db(), name); } catch { return fail("lease store error"); } },
	};
	return rt;
}
