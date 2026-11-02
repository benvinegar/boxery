// What a host command works with: configuration, the backend, guest ssh, the SQLite store, and (inside
// a supervised worker) its operation: held locks and the intent journal (docs/lifecycle.md).
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createBackend } from "./backend.mjs";
import * as leases from "./boxery-leases.mjs";
import { completeIntent, readToken, recordIntent, updateToken } from "./boxery-operations.mjs";
import { loadConfig } from "./config.mjs";
import { createGuest } from "./guest.mjs";
import { loadShapes } from "./shapes.mjs";
import { fail, log } from "./util.mjs";

export function createRuntime(env = process.env) {
	const config = loadConfig(env);
	const backends = path.join(config.root, "host", "backends");
	if (!existsSync(path.join(backends, `${config.backend}.sh`))) {
		const have = readdirSync(backends).filter((f) => f.endsWith(".sh")).map((f) => f.slice(0, -3)).sort();
		fail(`unknown backend '${config.backend}' (have: ${have.map((b) => `${b} `).join("")})`);
	}
	let db;
	const rt = {
		...config,
		log,
		vms: createBackend(config.env),
		guest: createGuest(config),
		/** Wait for NAME's sshd at EP, asking the backend why it can't be reached (exe: its tunnel). */
		waitSsh: (name, ep, tries) => rt.guest.waitSsh(ep, tries, () => rt.vms.endpointProblem(name)),
		db: () => (db ??= leases.open(path.join(config.conf, "leases.db"))),
		close: () => db?.close(),
		shapes: () => loadShapes(config.root, config.conf),
		/** Settings a supervised operation journals (the backend pinned to the one resolved now). */
		operationEnv: () => ({ ...config.env, BOXERY_BACKEND: config.backend }),
		// Inside a worker: the operation and the resources it holds.
		operationId: env.BOXERY_OPERATION_ID,
		holds: (name) => (env.BOXERY_LOCKS ?? "").includes(`:${name}:`),
		requireLock: (name) => { if (!rt.holds(name)) fail(`lifecycle lock required for ${name}`); },
		/** Journal intent after preflight, before side effects; `done` once the unit of work is complete. */
		intent: (kind, ...data) => recordIntent(rt.db(), rt.operationId, kind, data.map(String)),
		done: (id) => completeIntent(rt.db(), rt.operationId, id),
		token: (name) => readToken(config.conf, name),
		setToken: (name, value) => updateToken(rt.db(), config.conf, name, value),
		deleteToken: (name) => updateToken(rt.db(), config.conf, name, undefined),
		clearEdge: (name) => rmSync(path.join(config.conf, "edge", `${name}.json`), { force: true }),
		/** null when NAME is not in the pool; fails closed if the store can't be read. */
		poolRow: (name) => { try { return leases.get(rt.db(), name); } catch { return fail("lease store error"); } },
	};
	return rt;
}
