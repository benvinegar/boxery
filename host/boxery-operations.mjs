#!/usr/bin/env node
// Short SQLite transactions arbitrate resource locks; no transaction spans a VM operation.
// A supervisor owns every worker process group. A successor kills an abandoned group BEFORE
// replaying its durable intents. Workers wait on fd 3 until their identity is committed.
// The supervisor runs in the calling boxery-host process; the worker is `boxery-host.mjs __worker …`.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backup, identity, machineBootId, open, PS_ENV, restore as restoreStore, tx as transaction, VALID_NAME } from "./boxery-leases.mjs";
import { SETTINGS } from "./config.mjs";
/** @import { DatabaseSync } from "node:sqlite" */
/** @import { Writable } from "node:stream" */

/** A row of `operations`: one supervised command, its locks (`resources`, JSON) and journaled settings (`env`, JSON). @typedef {{ id: string, command: string, resources: string, env: string, owner: number, owner_start: string, boot: string, child: number | null, child_start: string | null, created_at: number }} OperationRow */
/** A journaled intent (data decoded). @typedef {{ id: string, kind: string, data: string[] }} Intent */
/** tokens.json entry: a pet's secret, or a pool VM's current lease's. @typedef {string | { secret: string, lease: string }} Token */
/** holdExclusive(): the host-wide lock, held. @typedef {{ release(): void, snapshot(file: string): void, restore(file: string): void }} Hold */

const HOST = fileURLToPath(new URL("./boxery-host.mjs", import.meta.url));
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const assertName = (/** @type {string} */ n) => { if (!VALID_NAME.test(n ?? "")) throw new Error(`invalid VM name: ${n}`); return n; };
// Unlike lease test clocks (BOXERY_BOOT_ID), process fencing must use the actual machine boot identity.
const BOOT = machineBootId();
export { identity };
const alive = (/** @type {OperationRow} */ r) => r.boot === BOOT && identity(r.owner) === r.owner_start;

/** @param {string} command @param {string[]} args */
export function resources(command, args) {
	/** @type {string[]} */
	let names = [];
	if (["new", "fork"].includes(command)) {
		for (let i = 0; i < args.length; i++) {
			if (["--cpus", "--mem", "--disk", "--shape"].includes(args[i])) { i++; continue; }
			if (command === "new" && args[i] === "--headless") continue;
			if (args[i] === "--from") {
				const image = args[++i];
				if (!/^[a-z][a-z0-9-]{0,30}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(image ?? "")) throw new Error("invalid image name");
				names.push(image.split("@")[0]);
			} else if (args[i].startsWith("-")) throw new Error(`unknown flag ${args[i]}`);
			else names.push(assertName(args[i]));
		}
	} else if (command === "pool") {
		if (["add", "rm"].includes(args[0])) names = [assertName(args[1])];
	} else if (command === "pin") names = [assertName(args.find((a) => !a.startsWith("-")) ?? "")];
	else if (command === "patch") names = [assertName(args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--wait") ?? "")];
	else if (["start", "stop", "resize", "rm", "delete", "snap", "snap-rm", "revert", "edge-set"].includes(command)) names = [assertName(args[0])];
	return [...new Set(names)].sort();
}

/** @param {DatabaseSync} db @param {string} id */
const row = (db, id) => /** @type {OperationRow | undefined} */ (db.prepare("SELECT * FROM operations WHERE id=?").get(id));
/** @param {DatabaseSync} db @param {string} id @returns {Intent[]} */
export const actions = (db, id) => /** @type {{ id: string, kind: string, data: string }[]} */ (db.prepare("SELECT id, kind, data FROM operation_intents WHERE operation_id=? ORDER BY seq DESC").all(id)).map((r) => ({ ...r, data: JSON.parse(r.data) }));

// Used by workers (boxery-host.mjs and the lease runtime); ownership and storage stay here.
/** @param {DatabaseSync} db @param {string | undefined} operationId @param {string} kind @param {string[]} data */
export function recordIntent(db, operationId, kind, data) {
	const op = row(db, /** @type {string} */ (operationId));
	if (!op || !alive(op)) throw new Error("operation no longer owns its locks");
	const id = randomUUID();
	db.prepare("INSERT INTO operation_intents(id, operation_id, kind, data) VALUES(?,?,?,?)").run(id, /** @type {string} */ (operationId), kind, JSON.stringify(data));
	return id;
}
/** @param {DatabaseSync} db @param {string | undefined} operationId @param {string} intentId */
export function completeIntent(db, operationId, intentId) {
	db.prepare("DELETE FROM operation_intents WHERE id=? AND operation_id=?").run(intentId, /** @type {string} */ (operationId));
}

/** @param {Pick<OperationRow, "child" | "child_start" | "boot">} r */
function stopAbandoned(r) {
	if (!r.child || r.boot !== BOOT) return;
	const current = identity(r.child);
	if (current && current !== r.child_start) return; // reused PID, not our worker
	try { process.kill(-r.child, "SIGKILL"); } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ESRCH") throw e; }
	// A killed leader may leave descendants behind; don't release the resource until all
	// non-zombie group members have exited. A timeout fails closed, retaining the journal.
	for (let i = 0; i < 100; i++) {
		const p = spawnSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8", env: PS_ENV });
		if (p.status !== 0) throw new Error("cannot inspect abandoned worker process group");
		if (!p.stdout.split("\n").some((s) => { const [g, st] = s.trim().split(/\s+/); return Number(g) === r.child && st && !st.startsWith("Z"); })) return;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	}
	throw new Error(`worker group ${r.child} did not stop; recovery deferred`);
}

/** @param {DatabaseSync} db @param {OperationRow} op @param {string[]} args @returns {Promise<number>} */
async function worker(db, op, args, recovery = false) {
	/** @type {NodeJS.ProcessEnv} */
	const env = { ...process.env, BOXERY_OPERATION_ID: op.id, BOXERY_LOCKS: `:${JSON.parse(op.resources).join(":")}:` };
	for (const [key, value] of Object.entries(JSON.parse(op.env))) {
		if (value == null) delete env[key];
		else env[key] = value;
	}
	// The worker reads the gate, then closes fd 3: a daemon it starts (Lima's hostagent, via limactl
	// start) must not hold the pipe open, or "close" never fires here.
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", HOST, "__worker", ...args], {
		env, detached: true, stdio: [recovery ? "ignore" : "inherit", "inherit", "inherit", "pipe"],
	});
	// Install listeners before opening the gate (a fast child may exit immediately).
	/** @type {Promise<number>} */
	const ended = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
	});
	/** @type {Writable} */ (child.stdio[3]).on("error", () => {});
	const start = identity(/** @type {number} */ (child.pid));
	if (!start) { /** @type {Writable} */ (child.stdio[3]).end(); await ended; throw new Error("worker exited before registration"); }
	db.prepare("UPDATE operations SET child=?, child_start=? WHERE id=?").run(/** @type {number} */ (child.pid), start, op.id);
	/** @type {Writable} */ (child.stdio[3]).end("go\n");
	const forward = (/** @type {NodeJS.Signals} */ signal) => { try { process.kill(-(/** @type {number} */ (child.pid)), signal); } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ESRCH") throw e; } };
	const term = () => forward("SIGTERM"), interrupt = () => forward("SIGINT");
	process.on("SIGTERM", term); process.on("SIGINT", interrupt);
	try { return await ended; }
	finally {
		process.off("SIGTERM", term); process.off("SIGINT", interrupt);
		// Never leave background backend commands running after a worker exits.
		stopAbandoned({ ...op, child: /** @type {number} */ (child.pid), child_start: start });
		db.prepare("UPDATE operations SET child=NULL, child_start=NULL WHERE id=?").run(op.id);
	}
}

/** @param {DatabaseSync} db @param {string} id @param {string} conf */
function finish(db, id, conf) {
	// Keep the journal until temporary seed/work files are gone too.
	rmSync(path.join(conf, "work", id), { recursive: true, force: true });
	transaction(db, () => {
		db.prepare("DELETE FROM operation_locks WHERE operation_id=?").run(id);
		db.prepare("DELETE FROM operation_intents WHERE operation_id=?").run(id);
		db.prepare("DELETE FROM operations WHERE id=?").run(id);
	});
}
/** @param {DatabaseSync} db @param {OperationRow} op @param {string} conf */
async function recover(db, op, conf) {
	if (actions(db, op.id).length) {
		process.stderr.write(`==> recovering abandoned ${op.command} (${op.id})\n`);
		if (await worker(db, op, ["__recover"], true) !== 0 || actions(db, op.id).length) throw new Error(`recovery failed for ${op.id}; journal retained`);
	}
	finish(db, op.id, conf);
}

// The host-wide resource: held by `boxery-host upgrade` while it replaces code and services.
// It conflicts with every operation, and every operation conflicts with it.
export const ALL = "*";
/** @param {string[]} held @param {string[]} wanted */
export const conflictsWith = (held, wanted) => held.includes(ALL) || wanted.includes(ALL) || held.some((n) => wanted.includes(n));

// Claim all resources atomically, including fork source/destinations and image readers.
// Recovery takes ownership of the OLD operation and its complete lock set before doing work.
/** @param {DatabaseSync} db @param {string[]} wanted @param {string} command @param {Record<string, string | null>} env @param {string} conf @returns {Promise<OperationRow | null | undefined>} */
async function acquire(db, wanted, command, env, conf, reconcile = false) {
	const owner = process.pid, ownerStart = /** @type {string} */ (identity(owner));
	for (;;) {
		const result = transaction(db, () => {
			const rows = /** @type {OperationRow[]} */ (db.prepare("SELECT * FROM operations ORDER BY created_at, id").all());
			const conflicts = reconcile ? rows : rows.filter((r) => conflictsWith(JSON.parse(r.resources), wanted));
			const abandoned = conflicts.find((r) => !alive(r));
			if (abandoned) {
				stopAbandoned(abandoned);
				db.prepare("UPDATE operations SET owner=?, owner_start=?, boot=?, child=NULL, child_start=NULL WHERE id=?").run(owner, ownerStart, BOOT, abandoned.id);
				return { recovery: row(db, abandoned.id) };
			}
			if (reconcile) return { done: true }; // leave live operations alone
			if (conflicts.length) return {};
			const id = randomUUID();
			db.prepare("INSERT INTO operations(id, command, resources, env, owner, owner_start, boot, created_at) VALUES(?,?,?,?,?,?,?,?)")
				.run(id, command, JSON.stringify(wanted), JSON.stringify(env), owner, ownerStart, BOOT, Date.now());
			for (const n of wanted) db.prepare("INSERT INTO operation_locks(resource, operation_id) VALUES(?,?)").run(n, id);
			return { operation: row(db, id) };
		});
		if (result.recovery) { await recover(db, result.recovery, conf); continue; }
		if (result.done) return null;
		if (result.operation) return result.operation;
		await sleep(50);
	}
}

/**
 * Hold the host-wide lock of profile CONF in this process (used by `boxery-host upgrade`).
 * The lock row is published first, so operations that start from now on wait behind it; then this
 * waits (until `deadline`, ms since epoch) for the operations already in flight to finish, recovering
 * any that were abandoned. Returns null on timeout, having withdrawn the lock. If the holder dies,
 * the next operation reclaims the lock as abandoned (it has no intents to replay).
 * While held, `snapshot(file)` copies the store and `restore(file)` puts that copy back (on rollback).
 * @returns {Promise<Hold | null>}
 */
export async function holdExclusive(/** @type {string} */ conf, /** @type {number} */ deadline) {
	conf = path.resolve(conf);
	const db = open(path.join(conf, "leases.db"));
	const owner = process.pid, ownerStart = /** @type {string} */ (identity(owner)), createdAt = Date.now();
	let id = /** @type {string | null} */ (null);
	const publish = () => {
		db.prepare("INSERT INTO operations(id, command, resources, env, owner, owner_start, boot, created_at) VALUES(?,?,?,?,?,?,?,?)")
			.run(id, "upgrade", JSON.stringify([ALL]), JSON.stringify({ BOXERY_CONF: conf }), owner, ownerStart, BOOT, createdAt);
		db.prepare("INSERT INTO operation_locks(resource, operation_id) VALUES(?,?)").run(ALL, id);
	};
	try {
		for (;;) {
			const result = transaction(db, () => {
				const others = /** @type {OperationRow[]} */ (db.prepare("SELECT * FROM operations WHERE id IS NOT ? ORDER BY created_at, id").all(id));
				const abandoned = others.find((r) => !alive(r));
				if (abandoned) {
					stopAbandoned(abandoned);
					db.prepare("UPDATE operations SET owner=?, owner_start=?, boot=?, child=NULL, child_start=NULL WHERE id=?").run(owner, ownerStart, BOOT, abandoned.id);
					return { recovery: row(db, abandoned.id) };
				}
				if (id == null) {
					if (others.some((r) => JSON.parse(r.resources).includes(ALL))) return {}; // another upgrade
					id = randomUUID();
					publish();
					return {};
				}
				return { drained: others.length === 0 };
			});
			if (result.recovery) { await recover(db, result.recovery, conf); continue; }
			if (result.drained) {
				const held = /** @type {string} */ (id);
				return {
					release() { finish(db, held, conf); db.close(); },
					/** Copy the store to FILE. The copy leaves out this hold: restored by hand, it is an idle host. */
					snapshot: (/** @type {string} */ file) => backup(db, file, (copy) => {
						copy.prepare("DELETE FROM operation_locks WHERE operation_id=?").run(held);
						copy.prepare("DELETE FROM operations WHERE id=?").run(held);
					}),
					/** Put the store back as FILE has it, still held by this process. */
					restore: (/** @type {string} */ file) => restoreStore(db, file, publish),
				};
			}
			if (Date.now() > deadline) { if (id) finish(db, id, conf); db.close(); return null; }
			await sleep(50);
		}
	} catch (e) {
		if (id) finish(db, id, conf);
		db.close();
		throw e;
	}
}

// Persist only backend routing settings (config.mjs SETTINGS), never arbitrary variables or credentials.
/** @param {string} conf @param {NodeJS.ProcessEnv} env */
const journaled = (conf, env) => ({ BOXERY_CONF: conf, ...Object.fromEntries(SETTINGS.map((k) => [k, env[k] ?? null])) });
/** @param {string} conf */
function openStore(conf) {
	mkdirSync(conf, { recursive: true, mode: 0o700 });
	return open(path.join(conf, "leases.db"));
}

/** Run `boxery-host.mjs __worker ARGS…` holding NAMES (all of them, atomically) for its whole lifetime.
 * Recovers abandoned operations on those resources first. Resolves with the worker's exit status;
 * a worker that left intents behind is compensated under the same locks and reported as failed.
 * @param {{ conf: string, names: string[], command: string, args: string[], env?: NodeJS.ProcessEnv }} opts */
export async function supervise({ conf, names, command, args, env = process.env }) {
	const db = openStore(conf);
	try {
		const op = /** @type {OperationRow} */ (await acquire(db, [...new Set(names)].sort(), command, journaled(conf, env), conf));
		const rc = await worker(db, op, args);
		if (actions(db, op.id).length) {
			await recover(db, op, conf);
			return rc || 1;
		}
		finish(db, op.id, conf);
		return rc;
	} finally { db.close(); }
}

/** Recover every abandoned operation on this host; live operations are left alone. */
export async function reconcileAbandoned(/** @type {string} */ conf) {
	const db = openStore(conf);
	try { await acquire(db, [], "reconcile", {}, conf, true); } finally { db.close(); }
}

/** tokens.json[NAME]: "SECRET" (a pet), {secret, lease} (a pool VM's current lease), or undefined.
 * @param {string} conf @param {string} name @returns {Token | undefined} */
export function readToken(conf, name) {
	try { return JSON.parse(readFileSync(path.join(conf, "tokens.json"), "utf8"))[name]; }
	catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return undefined; throw e; }
}

/** tokens.json[NAME] := VALUE (undefined deletes). A short transaction serializes read/modify/rename.
 * @param {DatabaseSync} db @param {string} conf @param {string} name @param {Token | undefined} value */
export function updateToken(db, conf, name, value) {
	transaction(db, () => {
		const file = path.join(conf, "tokens.json");
		/** @type {Record<string, Token>} */
		let tokens;
		try { tokens = JSON.parse(readFileSync(file, "utf8")); }
		catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; tokens = {}; }
		assertName(name);
		if (value === undefined) delete tokens[name];
		else tokens[name] = value;
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, JSON.stringify(tokens), { mode: 0o600 });
		renameSync(tmp, file);
	});
}
