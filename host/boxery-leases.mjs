#!/usr/bin/env node
// boxery lease state: which pool VM is held by whom, until when.
//
// One SQLite row per pool VM (node:sqlite, no dependencies). Every mutation is a BEGIN IMMEDIATE
// transaction, and every state change bumps the row's generation. Side effects (installing a lease
// key, reverting the VM) happen *between* transactions, and their outcome is committed only if the
// generation is still the one the caller saw. So a racing acquire/release/reap resolves to a single
// winner, and a crash between steps leaves a row that the reaper finishes later
// (ACQUIRING/RESETTING older than STALE_SECS gets reset again).
//
//   FREE ──claim──▶ ACQUIRING ──commit──▶ LEASED ──release / expiry / host reboot──▶ RESETTING ──finish──▶ FREE
//                       └──────────── failed key install / stale ─────────────────────▶ RESETTING ──finish──▶ BROKEN
//
// Also the host's shared store primitives: the SQLite schema and its version (leases + operation
// journal, see boxery-operations.mjs), BEGIN IMMEDIATE transactions, the copy an upgrade takes and
// restores, VM names and boot/process identity.
//
// CLI (used by host/boxery-host; prints JSON). Lease transitions themselves run in-process
// (boxery-lifecycle.mjs); the shell only inspects and edits pool membership:
//   node boxery-leases.mjs DB add NAME | remove NAME [--force] | get NAME | list | missing NAME
//   node boxery-leases.mjs DB begin-reset-name NAME GEN      → {name,gen}   (after a failed acquire; fenced)
// Env (tests): BOXERY_NOW (epoch seconds), BOXERY_BOOT_ID.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** @typedef {"FREE" | "ACQUIRING" | "LEASED" | "RESETTING" | "BROKEN"} LeaseState */
/** A pool VM's row in `vms`. @typedef {{ name: string, state: LeaseState, gen: number, lease_id: string | null, holder: string | null, pubkey: string | null, acquired_at: number | null, expires_at: number | null, boot_id: string | null, updated_at: number, epoch: string }} LeaseRow */
/** @typedef {Pick<LeaseRow, "name" | "state" | "gen" | "holder" | "acquired_at" | "expires_at"> & { expires_in: number | null }} LeaseListEntry */
/** What claim() hands the acquirer (state ACQUIRING at `gen`). @typedef {{ name: string, gen: number, epoch: string, lease_id: string, expires_at: number }} Claim */
/** A row moved to RESETTING at `gen`; finish() it with that gen. @typedef {{ name: string, gen: number, epoch: string }} ResetTicket */
/** @typedef {ResetTicket & { reason: string }} DueReset */

export const TTL_MIN = 60;
export const TTL_MAX = 8 * 3600;
export const STALE_SECS = 300; // an ACQUIRING/RESETTING row older than this is assumed abandoned

export const now = () => Number(process.env.BOXERY_NOW ?? Math.floor(Date.now() / 1000));
export const VALID_NAME = /^[a-z][a-z0-9-]{0,30}$/;

// Linux exposes precise kernel start ticks; macOS uses ps lstart in a fixed locale/timezone.
// Zombies no longer execute side effects. Inspection errors other than "not found" fail closed.
export const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };
/** @param {number} pid @returns {string | null} */
export function identity(pid) {
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
			if (["Z", "X"].includes(fields[0])) return null;
			if (!/^\d+$/.test(fields[19] ?? "")) throw new Error("malformed process start time");
			return `linux:${fields[19]}`;
		} catch (e) {
			if (["ENOENT", "ESRCH"].includes(/** @type {any} */ (e).code)) return null;
			throw e;
		}
	}
	const r = spawnSync("ps", ["-p", String(pid), "-o", "stat=", "-o", "lstart="], { encoding: "utf8", env: PS_ENV });
	if (r.error || (r.status !== 0 && r.status !== 1) || (r.status === 1 && r.stderr?.trim())) throw new Error(`cannot inspect process ${pid}`);
	const s = r.stdout?.trim();
	if (r.status !== 0 || !s || s.startsWith("Z")) return null;
	return s.replace(/^\S+\s+/, "");
}

// The machine's boot identity. Linux: the kernel's boot_id. macOS: launchd's start time, which
// (unlike now - uptime) does not move when the wall clock is stepped.
/** @type {string | null | undefined} */
let machineBoot;
/** @returns {string} */
export function machineBootId() {
	if (machineBoot) return machineBoot;
	try { machineBoot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
	catch (e) {
		if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
		machineBoot = identity(1);
		if (!machineBoot) throw new Error("cannot determine host boot identity");
	}
	return machineBoot;
}
/** Lease fencing: a lease taken before a reboot is void. Tests fake reboots with BOXERY_BOOT_ID. */
export const bootId = () => process.env.BOXERY_BOOT_ID || machineBootId();
const clampTtl = (/** @type {unknown} */ t) => Math.max(TTL_MIN, Math.min(TTL_MAX, Math.floor(Number(t) || 1800)));
const HOLDER = /^[A-Za-z0-9._@:/+-]{1,128}$/;
const PUBKEY = /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/=]{20,} ?[^\n]{0,200}$/;

// Changing journal mode can return SQLITE_BUSY immediately (it doesn't always honour busy_timeout).
/** @template T @param {() => T} fn @returns {T} */
function retryBusy(fn) {
	for (let i = 0; ; i++) {
		try {
			return fn();
		} catch (e) {
			if (!/locked|busy/i.test(String(/** @type {Error | undefined} */ (e)?.message)) || i >= 200) throw e;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + Math.random() * 50);
		}
	}
}

// The store's schema version (PRAGMA user_version; 0 = a store from before it was recorded). Every
// schema change bumps it and adds a step to migrate(). Code refuses a store newer than it understands
// instead of misreading it, e.g. after an upgrade that migrated it was rolled back without its copy.
export const SCHEMA_VERSION = 1;
const SCHEMA_V1 = `
	CREATE TABLE IF NOT EXISTS vms (
		name TEXT PRIMARY KEY,
		state TEXT NOT NULL CHECK (state IN ('FREE','ACQUIRING','LEASED','RESETTING','BROKEN')),
		gen INTEGER NOT NULL DEFAULT 0,
		lease_id TEXT UNIQUE,
		holder TEXT, pubkey TEXT,
		acquired_at INTEGER, expires_at INTEGER, boot_id TEXT,
		updated_at INTEGER NOT NULL, epoch TEXT
	);
	CREATE TABLE IF NOT EXISTS operations (
		id TEXT PRIMARY KEY, command TEXT NOT NULL, resources TEXT NOT NULL, env TEXT NOT NULL,
		owner INTEGER NOT NULL, owner_start TEXT NOT NULL, boot TEXT NOT NULL,
		child INTEGER, child_start TEXT, created_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS operation_locks (resource TEXT PRIMARY KEY, operation_id TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS operation_intents (
		seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
		operation_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL
	);`;

/** @param {DatabaseSync} db @returns {number} */
export const schemaVersion = (db, schema = "main") => /** @type {{ user_version: number }} */ (db.prepare(`PRAGMA ${schema}.user_version`).get()).user_version;
/** @param {string} file @param {number} v */
function checkVersion(file, v) {
	if (v <= SCHEMA_VERSION) return;
	throw new Error(`${file} has schema version ${v}, newer than this boxery understands (${SCHEMA_VERSION}): a newer release wrote it. `
		+ "Upgrade boxery, or restore the copy taken before the upgrade (see Upgrading in docs/install.md)");
}
/** @param {DatabaseSync} db @param {string} file */
function migrate(db, file) {
	const v = schemaVersion(db); // again, under the write lock: another opener may have migrated it
	checkVersion(file, v);
	if (v < 1) db.exec(SCHEMA_V1); // a new store, or one from before versioning (same tables)
	if (v !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** @param {string} file */
export function open(file) {
	// timeout = SQLite busy timeout, applied at open: concurrent openers wait for locks (including the
	// one-time switch to WAL and the migration) instead of failing with "database is locked".
	const db = new DatabaseSync(file, { timeout: 15000 });
	try {
		db.exec("PRAGMA busy_timeout = 15000");
		retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
		const v = schemaVersion(db);
		checkVersion(file, v);
		if (v !== SCHEMA_VERSION) retryBusy(() => tx(db, () => migrate(db, file)));
	} catch (e) {
		db.close();
		throw e;
	}
	return db;
}

const quote = (/** @type {string} */ name) => `"${name.replace(/"/g, '""')}"`;
/** A consistent copy of DB at FILE (VACUUM INTO a temp file, then rename), mode 0600.
 * `edit(copy)` may change the copy before it replaces FILE.
 * @param {DatabaseSync} db @param {string} file @param {(copy: DatabaseSync) => void} [edit] */
export function backup(db, file, edit = () => {}) {
	const tmp = `${file}.tmp`;
	rmSync(tmp, { force: true });
	db.prepare("VACUUM INTO ?").run(tmp);
	chmodSync(tmp, 0o600);
	const copy = new DatabaseSync(tmp);
	try { edit(copy); } finally { copy.close(); }
	renameSync(tmp, file);
}

/** Replace DB's schema, rows and version with those of the copy at FILE (from backup()), in one
 * transaction on this connection. Other processes keep their connections and see the copy's contents;
 * swapping the file under them would leave them writing to a deleted one. Every pool row's generation
 * moves past any it had, so a claim made after the copy is fenced rather than issued twice.
 * `then()` runs in the same transaction.
 * @param {DatabaseSync} db @param {string} file @param {() => void} [then] */
export function restore(db, file, then = () => {}) {
	let bump;
	try { bump = 1 + Number(/** @type {{ g: number | null }} */ (db.prepare("SELECT max(gen) g FROM vms").get()).g ?? 0); }
	catch { bump = 1e9; } // the newer schema renamed what we'd read
	db.prepare("ATTACH DATABASE ? AS pre").run(file);
	try {
		tx(db, () => {
			const objects = (/** @type {string} */ schema) => /** @type {{ type: string, name: string, sql: string }[]} */ (db.prepare(`SELECT type, name, sql FROM ${schema}.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`).all());
			// Dropping a table drops its indexes and triggers.
			for (const o of objects("main")) if (o.type === "table" || o.type === "view") db.exec(`DROP ${o.type} IF EXISTS main.${quote(o.name)}`);
			const copy = objects("pre");
			for (const t of copy.filter((o) => o.type === "table")) {
				db.exec(t.sql); // unqualified CREATE: into main
				db.exec(`INSERT INTO main.${quote(t.name)} SELECT * FROM pre.${quote(t.name)}`);
			}
			for (const o of copy.filter((o) => o.type !== "table")) db.exec(o.sql);
			if (db.prepare("SELECT 1 FROM pre.sqlite_master WHERE name='sqlite_sequence'").get()) {
				db.exec("DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence SELECT * FROM pre.sqlite_sequence");
			}
			db.prepare("UPDATE vms SET gen = gen + ?").run(bump);
			db.exec(`PRAGMA main.user_version = ${schemaVersion(db, "pre")}`);
			then();
		});
	} finally {
		db.exec("DETACH DATABASE pre");
	}
}

/** @template T @param {DatabaseSync} db @param {() => T} fn @returns {T} */
export function tx(db, fn) {
	db.exec("BEGIN IMMEDIATE");
	try {
		const r = fn();
		db.exec("COMMIT");
		return r;
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}

/** @param {DatabaseSync} db @param {string} name */
export function add(db, name) {
	db.prepare("INSERT INTO vms (name, state, gen, updated_at, epoch) VALUES (?, 'FREE', 0, ?, ?)").run(name, now(), randomBytes(16).toString("hex"));
	return get(db, name);
}

/** @param {DatabaseSync} db @param {string} name */
export function get(db, name) {
	return /** @type {LeaseRow | undefined} */ (db.prepare("SELECT * FROM vms WHERE name = ?").get(name)) ?? null;
}

/** @param {DatabaseSync} db @param {string} leaseId */
export function find(db, leaseId) {
	return /** @type {LeaseRow | undefined} */ (db.prepare("SELECT * FROM vms WHERE lease_id=?").get(leaseId)) ?? null;
}

/** @param {DatabaseSync} db @returns {LeaseListEntry[]} */
export function list(db) {
	const t = now();
	return /** @type {Omit<LeaseListEntry, "expires_in">[]} */ (db
		.prepare("SELECT name, state, gen, holder, acquired_at, expires_at FROM vms ORDER BY name")
		.all())
		.map((r) => ({ ...r, expires_in: r.state === "LEASED" ? /** @type {number} */ (r.expires_at) - t : null }));
}

/** @param {DatabaseSync} db @param {string} name */
export function remove(db, name, force = false) {
	return tx(db, () => {
		const r = get(db, name);
		if (!r) throw new Error(`${name} is not a pool VM`);
		if (!force && !["FREE", "BROKEN"].includes(r.state)) throw new Error(`${name} is ${r.state}; release it first (or --force)`);
		db.prepare("DELETE FROM vms WHERE name = ?").run(name);
		return { name };
	});
}

/** Every row a holder has, in any state, with its lease id: what a restarted lease holder still owns
 *  (the GitHub runner manager, host/runners.mjs). @param {DatabaseSync} db @param {string} holder */
export function heldBy(db, holder) {
	return /** @type {Pick<LeaseRow, "name" | "state" | "gen" | "lease_id" | "expires_at">[]} */ (db
		.prepare("SELECT name, state, gen, lease_id, expires_at FROM vms WHERE holder = ? ORDER BY name").all(holder));
}

/** FREE → ACQUIRING for the least recently used free VM. Returns null when the pool is exhausted.
 * only: one of these VMs and no other (the runner manager serves the VMs that carry the GitHub runner,
 * never an agent's pool VM). */
/** @param {DatabaseSync} db @param {string | undefined} holder @param {unknown} ttl @param {string | undefined} pubkey @param {string[]} [only] @returns {Claim | null} */
export function claim(db, holder, ttl, pubkey, only) {
	if (!HOLDER.test(holder ?? "")) throw new Error(`invalid holder "${holder}"`);
	if (!PUBKEY.test(pubkey ?? "")) throw new Error("invalid ssh public key");
	if (only && !(Array.isArray(only) && only.length && only.every((n) => VALID_NAME.test(n)))) throw new Error("invalid VM list");
	const t = now();
	const exp = t + clampTtl(ttl);
	return tx(db, () => {
		const r = /** @type {Pick<LeaseRow, "name" | "gen" | "epoch"> | undefined} */ (db.prepare(`SELECT name, gen, epoch FROM vms WHERE state = 'FREE'
			AND NOT EXISTS (SELECT 1 FROM operation_locks WHERE resource=vms.name)
			AND (?1 IS NULL OR name IN (SELECT value FROM json_each(?1)))
			ORDER BY updated_at, name LIMIT 1`).get(only ? JSON.stringify(only) : null));
		if (!r) return null;
		const lease = `l-${randomBytes(16).toString("hex")}`;
		db.prepare(
			`UPDATE vms SET state='ACQUIRING', gen=gen+1, lease_id=?, holder=?, pubkey=?, acquired_at=?, expires_at=?, boot_id=?, updated_at=?
			 WHERE name=? AND gen=? AND state='FREE'`,
		).run(lease, /** @type {string} */ (holder), /** @type {string} */ (pubkey), t, exp, bootId(), t, r.name, r.gen);
		return { name: r.name, gen: r.gen + 1, epoch: r.epoch, lease_id: lease, expires_at: exp };
	});
}

/** ACQUIRING(gen) → LEASED. False if someone else moved the row on (e.g. the reaper). */
/** @param {DatabaseSync} db @param {string} name @param {number | string} gen */
export function commit(db, name, gen) {
	const r = db
		.prepare("UPDATE vms SET state='LEASED', gen=gen+1, updated_at=? WHERE name=? AND gen=? AND state='ACQUIRING' AND expires_at>? AND boot_id=?")
		.run(now(), name, Number(gen), now(), bootId());
	return r.changes === 1;
}

/** @param {DatabaseSync} db @param {string} leaseId @param {unknown} ttl */
export function renew(db, leaseId, ttl) {
	const t = now();
	return tx(db, () => {
		const r = /** @type {LeaseRow | undefined} */ (db.prepare("SELECT * FROM vms WHERE lease_id = ?").get(leaseId));
		if (!r) throw new Error("unknown lease (released, expired and reset, or never existed)");
		if (r.state !== "LEASED") throw new Error(`lease is ${r.state}`);
		if (/** @type {number} */ (r.expires_at) <= t) throw new Error("lease expired");
		if (r.boot_id !== bootId()) throw new Error("host rebooted; lease is void");
		const exp = t + clampTtl(ttl);
		db.prepare("UPDATE vms SET expires_at=?, updated_at=? WHERE name=?").run(exp, t, r.name);
		return { name: r.name, expires_at: exp };
	});
}

/** @param {DatabaseSync} db @param {string} name @param {number} gen */
const toResetting = (db, name, gen) =>
	db
		.prepare(
			"UPDATE vms SET state='RESETTING', gen=gen+1, lease_id=NULL, pubkey=NULL, expires_at=NULL, updated_at=? WHERE name=? AND gen=?",
		)
		.run(now(), name, gen).changes === 1;

/** Release: LEASED/ACQUIRING with this lease → RESETTING. The lease id stops working immediately. */
/** @param {DatabaseSync} db @param {string} leaseId @returns {ResetTicket} */
export function beginReset(db, leaseId) {
	return tx(db, () => {
		const r = /** @type {Pick<LeaseRow, "name" | "gen" | "state" | "epoch"> | undefined} */ (db.prepare("SELECT name, gen, state, epoch FROM vms WHERE lease_id = ?").get(leaseId));
		if (!r || !["LEASED", "ACQUIRING"].includes(r.state)) throw new Error("unknown or inactive lease");
		toResetting(db, r.name, r.gen);
		return { name: r.name, gen: r.gen + 1, epoch: r.epoch };
	});
}

/** After a failed acquire: ACQUIRING(gen) → RESETTING, only if nobody else touched the row. */
/** @param {DatabaseSync} db @param {string} name @param {number | string} gen @returns {ResetTicket} */
export function beginResetName(db, name, gen) {
	return tx(db, () => {
		const r = get(db, name);
		if (!r || r.gen !== Number(gen) || r.state !== "ACQUIRING") throw new Error("fenced: row changed");
		toResetting(db, name, r.gen);
		return { name, gen: r.gen + 1, epoch: r.epoch };
	});
}

/** @param {LeaseRow} r */
function resetReason(r) {
	if (r.state === "LEASED" && /** @type {number} */ (r.expires_at) <= now()) return "expired";
	if (r.state === "LEASED" && r.boot_id !== bootId()) return "host rebooted";
	if (["ACQUIRING", "RESETTING"].includes(r.state) && r.updated_at < now() - STALE_SECS) return `stale ${r.state}`;
	return null;
}

/** Observation only. The host takes the VM lock before claiming a candidate for reset. */
/** @param {DatabaseSync} db */
export function candidates(db) {
	return /** @type {LeaseRow[]} */ (db.prepare("SELECT * FROM vms").all()).filter(resetReason);
}

/** Claim resets. With a candidate, revalidate its generation, incarnation AND deadline under lock. */
/** @param {DatabaseSync} db @param {string | null} [name] @param {number | string} [gen] @param {string} [epoch] */
export function due(db, name, gen, epoch) {
	return tx(db, () => {
		/** @type {DueReset[]} */
		const out = [];
		for (const r of candidates(db)) {
			if (name != null && (r.name !== name || r.gen !== Number(gen) || r.epoch !== epoch)) continue;
			const reason = resetReason(r);
			if (reason && toResetting(db, r.name, r.gen)) out.push({ name: r.name, gen: r.gen + 1, epoch: r.epoch, reason });
		}
		return out;
	});
}

/** RESETTING(gen) → FREE | BROKEN. False if fenced (a newer reset took over). */
/** @param {DatabaseSync} db @param {string} name @param {number | string} gen @param {string} state */
export function finish(db, name, gen, state) {
	if (!["FREE", "BROKEN"].includes(state)) throw new Error("finish: state must be FREE or BROKEN");
	const r = db
		.prepare(
			"UPDATE vms SET state=?, gen=gen+1, lease_id=NULL, holder=NULL, pubkey=NULL, acquired_at=NULL, expires_at=NULL, boot_id=NULL, updated_at=? WHERE name=? AND gen=? AND state='RESETTING'",
		)
		.run(state, now(), name, Number(gen));
	return r.changes === 1;
}

/** The VM vanished from the backend: fence its row (any lease ends) until someone repairs it. */
/** @param {DatabaseSync} db @param {string} name */
export function markMissing(db, name) {
	db.prepare(`UPDATE vms SET state='BROKEN', gen=gen+1, lease_id=NULL, holder=NULL,
		pubkey=NULL, acquired_at=NULL, expires_at=NULL, boot_id=NULL, updated_at=?
		WHERE name=? AND state!='BROKEN'`).run(now(), name);
	return get(db, name);
}

// ---------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
	const [file, op, ...a] = process.argv.slice(2);
	const out = (/** @type {unknown} */ v) => process.stdout.write(`${JSON.stringify(v)}\n`);
	try {
		if (!file || !op) throw new Error("usage: boxery-leases.mjs DB OP ARGS…");
		const db = open(file);
		switch (op) {
			case "add": out(add(db, a[0])); break;
			case "remove": out(remove(db, a[0], a[1] === "--force")); break;
			case "get": out(get(db, a[0])); break;
			case "missing": out(markMissing(db, a[0])); break;
			case "list": out(list(db)); break;
			case "begin-reset-name": out(beginResetName(db, a[0], a[1])); break;
			default: throw new Error(`unknown op ${op}`);
		}
	} catch (e) {
		process.stderr.write(`boxery-leases: ${/** @type {Error} */ (e).message}\n`);
		process.exit(2);
	}
}
