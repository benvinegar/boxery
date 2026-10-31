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
// CLI (used by host/boxery-host; prints JSON):
//   node boxery-leases.mjs DB add NAME | remove NAME [--force] | get NAME | list
//   node boxery-leases.mjs DB claim HOLDER TTL PUBKEY        → {name,gen,lease_id,expires_at} | null
//   node boxery-leases.mjs DB commit NAME GEN                → ACQUIRING(gen) → LEASED; exit 3 if fenced
//   node boxery-leases.mjs DB renew LEASE_ID TTL             → {name,expires_at}
//   node boxery-leases.mjs DB begin-reset LEASE_ID           → {name,gen}   (release)
//   node boxery-leases.mjs DB begin-reset-name NAME GEN      → {name,gen}   (after a failed acquire; fenced)
//   node boxery-leases.mjs DB due                            → [{name,gen,reason}], already moved to RESETTING
//   node boxery-leases.mjs DB finish NAME GEN FREE|BROKEN    → exit 3 if fenced
// Env (tests): BOXERY_NOW (epoch seconds), BOXERY_BOOT_ID.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

export const TTL_MIN = 60;
export const TTL_MAX = 8 * 3600;
export const STALE_SECS = 300; // an ACQUIRING/RESETTING row older than this is assumed abandoned

export const now = () => Number(process.env.BOXERY_NOW ?? Math.floor(Date.now() / 1000));
export function bootId() {
	if (process.env.BOXERY_BOOT_ID) return process.env.BOXERY_BOOT_ID;
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); // Linux
	} catch {
		return `boot-${Math.round((Date.now() / 1000 - os.uptime()) / 60)}`; // macOS: boot time, minute precision
	}
}
const clampTtl = (t) => Math.max(TTL_MIN, Math.min(TTL_MAX, Math.floor(Number(t) || 1800)));
const HOLDER = /^[A-Za-z0-9._@:/+-]{1,128}$/;
const PUBKEY = /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/=]{20,} ?[^\n]{0,200}$/;

// Changing journal mode can return SQLITE_BUSY immediately (it doesn't always honour busy_timeout).
function retryBusy(fn) {
	for (let i = 0; ; i++) {
		try {
			return fn();
		} catch (e) {
			if (!/locked|busy/i.test(String(e?.message)) || i >= 200) throw e;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + Math.random() * 50);
		}
	}
}

export function open(file) {
	// timeout = SQLite busy timeout, applied at open: concurrent openers wait for locks (including the
	// one-time switch to WAL and CREATE TABLE) instead of failing with "database is locked".
	const db = new DatabaseSync(file, { timeout: 15000 });
	db.exec("PRAGMA busy_timeout = 15000");
	retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
	retryBusy(() => db.exec(`
		CREATE TABLE IF NOT EXISTS vms (
			name TEXT PRIMARY KEY,
			state TEXT NOT NULL CHECK (state IN ('FREE','ACQUIRING','LEASED','RESETTING','BROKEN')),
			gen INTEGER NOT NULL DEFAULT 0,
			lease_id TEXT UNIQUE,
			holder TEXT, pubkey TEXT,
			acquired_at INTEGER, expires_at INTEGER, boot_id TEXT,
			updated_at INTEGER NOT NULL
		);`));
	return db;
}

function tx(db, fn) {
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

export function add(db, name) {
	db.prepare("INSERT INTO vms (name, state, gen, updated_at) VALUES (?, 'FREE', 0, ?)").run(name, now());
	return get(db, name);
}

export function get(db, name) {
	return db.prepare("SELECT * FROM vms WHERE name = ?").get(name) ?? null;
}

export function list(db) {
	const t = now();
	return db
		.prepare("SELECT name, state, gen, holder, acquired_at, expires_at FROM vms ORDER BY name")
		.all()
		.map((r) => ({ ...r, expires_in: r.state === "LEASED" ? r.expires_at - t : null }));
}

export function remove(db, name, force = false) {
	return tx(db, () => {
		const r = get(db, name);
		if (!r) throw new Error(`${name} is not a pool VM`);
		if (!force && !["FREE", "BROKEN"].includes(r.state)) throw new Error(`${name} is ${r.state}; release it first (or --force)`);
		db.prepare("DELETE FROM vms WHERE name = ?").run(name);
		return { name };
	});
}

/** FREE → ACQUIRING for the least recently used free VM. Returns null when the pool is exhausted. */
export function claim(db, holder, ttl, pubkey) {
	if (!HOLDER.test(holder ?? "")) throw new Error(`invalid holder "${holder}"`);
	if (!PUBKEY.test(pubkey ?? "")) throw new Error("invalid ssh public key");
	const t = now();
	const exp = t + clampTtl(ttl);
	return tx(db, () => {
		const r = db.prepare("SELECT name, gen FROM vms WHERE state = 'FREE' ORDER BY updated_at, name LIMIT 1").get();
		if (!r) return null;
		const lease = `l-${randomBytes(16).toString("hex")}`;
		db.prepare(
			`UPDATE vms SET state='ACQUIRING', gen=gen+1, lease_id=?, holder=?, pubkey=?, acquired_at=?, expires_at=?, boot_id=?, updated_at=?
			 WHERE name=? AND gen=? AND state='FREE'`,
		).run(lease, holder, pubkey, t, exp, bootId(), t, r.name, r.gen);
		return { name: r.name, gen: r.gen + 1, lease_id: lease, expires_at: exp };
	});
}

/** ACQUIRING(gen) → LEASED. False if someone else moved the row on (e.g. the reaper). */
export function commit(db, name, gen) {
	const r = db
		.prepare("UPDATE vms SET state='LEASED', gen=gen+1, updated_at=? WHERE name=? AND gen=? AND state='ACQUIRING'")
		.run(now(), name, Number(gen));
	return r.changes === 1;
}

export function renew(db, leaseId, ttl) {
	const t = now();
	return tx(db, () => {
		const r = db.prepare("SELECT * FROM vms WHERE lease_id = ?").get(leaseId);
		if (!r) throw new Error("unknown lease (released, expired and reset, or never existed)");
		if (r.state !== "LEASED") throw new Error(`lease is ${r.state}`);
		if (r.expires_at <= t) throw new Error("lease expired");
		if (r.boot_id !== bootId()) throw new Error("host rebooted; lease is void");
		const exp = t + clampTtl(ttl);
		db.prepare("UPDATE vms SET expires_at=?, updated_at=? WHERE name=?").run(exp, t, r.name);
		return { name: r.name, expires_at: exp };
	});
}

const toResetting = (db, name, gen) =>
	db
		.prepare(
			"UPDATE vms SET state='RESETTING', gen=gen+1, lease_id=NULL, pubkey=NULL, expires_at=NULL, updated_at=? WHERE name=? AND gen=?",
		)
		.run(now(), name, gen).changes === 1;

/** Release: LEASED/ACQUIRING with this lease → RESETTING. The lease id stops working immediately. */
export function beginReset(db, leaseId) {
	return tx(db, () => {
		const r = db.prepare("SELECT name, gen, state FROM vms WHERE lease_id = ?").get(leaseId);
		if (!r || !["LEASED", "ACQUIRING"].includes(r.state)) throw new Error("unknown or inactive lease");
		toResetting(db, r.name, r.gen);
		return { name: r.name, gen: r.gen + 1 };
	});
}

/** After a failed acquire: ACQUIRING(gen) → RESETTING, only if nobody else touched the row. */
export function beginResetName(db, name, gen) {
	return tx(db, () => {
		const r = get(db, name);
		if (!r || r.gen !== Number(gen) || r.state !== "ACQUIRING") throw new Error("fenced: row changed");
		toResetting(db, name, r.gen);
		return { name, gen: r.gen + 1 };
	});
}

/** Rows that need a reset, claimed for it (moved to RESETTING with a fresh generation). */
export function due(db) {
	const t = now();
	const boot = bootId();
	return tx(db, () => {
		const out = [];
		for (const r of db.prepare("SELECT * FROM vms").all()) {
			let reason = null;
			if (r.state === "LEASED" && r.expires_at <= t) reason = "expired";
			else if (r.state === "LEASED" && r.boot_id !== boot) reason = "host rebooted";
			else if (["ACQUIRING", "RESETTING"].includes(r.state) && r.updated_at < t - STALE_SECS) reason = `stale ${r.state}`;
			if (reason && toResetting(db, r.name, r.gen)) out.push({ name: r.name, gen: r.gen + 1, reason });
		}
		return out;
	});
}

/** RESETTING(gen) → FREE | BROKEN. False if fenced (a newer reset took over). */
export function finish(db, name, gen, state) {
	if (!["FREE", "BROKEN"].includes(state)) throw new Error("finish: state must be FREE or BROKEN");
	const r = db
		.prepare(
			"UPDATE vms SET state=?, gen=gen+1, lease_id=NULL, holder=NULL, pubkey=NULL, acquired_at=NULL, expires_at=NULL, boot_id=NULL, updated_at=? WHERE name=? AND gen=? AND state='RESETTING'",
		)
		.run(state, now(), name, Number(gen));
	return r.changes === 1;
}

// ---------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
	const [file, op, ...a] = process.argv.slice(2);
	const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
	try {
		if (!file || !op) throw new Error("usage: boxery-leases.mjs DB OP ARGS…");
		const db = open(file);
		switch (op) {
			case "add": out(add(db, a[0])); break;
			case "remove": out(remove(db, a[0], a[1] === "--force")); break;
			case "get": out(get(db, a[0])); break;
			case "list": out(list(db)); break;
			case "claim": out(claim(db, a[0], a[1], a[2])); break;
			case "commit": if (!commit(db, a[0], a[1])) process.exit(3); out({ ok: true }); break;
			case "renew": out(renew(db, a[0], a[1])); break;
			case "begin-reset": out(beginReset(db, a[0])); break;
			case "begin-reset-name": out(beginResetName(db, a[0], a[1])); break;
			case "due": out(due(db)); break;
			case "finish": if (!finish(db, a[0], a[1], a[2])) process.exit(3); out({ ok: true }); break;
			default: throw new Error(`unknown op ${op}`);
		}
	} catch (e) {
		process.stderr.write(`boxery-leases: ${e.message}\n`);
		process.exit(2);
	}
}
