// Lease state machine (host/boxery-leases.mjs): transitions, fencing, expiry, reboot, concurrency.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { promisify } from "node:util";
let L;
try {
	L = await import("../host/boxery-leases.mjs");
} catch (e) {
	if (!String(e?.message).includes("sqlite")) throw e;
}
const it = L ? test : test.skip; // host lease store needs node:sqlite (Node >= 22.13)

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexampleexampleexampleexample lease@test";
const T0 = 1_800_000_000;
let db, file;
const at = (t) => (process.env.BOXERY_NOW = String(t));

beforeEach(() => {
	if (!L) return;
	file = path.join(mkdtempSync(path.join(tmpdir(), "boxery-leases-")), "leases.db");
	db = L.open(file);
	process.env.BOXERY_BOOT_ID = "boot-1";
	at(T0);
	for (const n of ["p1", "p2", "p3"]) L.add(db, n);
});

it("opening an existing lease store migrates incarnation fencing without losing leases", () => {
	const c = L.claim(db, "existing-holder", 600, KEY);
	L.commit(db, c.name, c.gen);
	db.exec("ALTER TABLE vms DROP COLUMN epoch"); // schema before lifecycle coordination
	db.close(); db = L.open(file);
	const r = L.get(db, c.name);
	assert.equal(r.state, "LEASED");
	assert.equal(r.lease_id, c.lease_id);
	assert.equal(r.holder, "existing-holder");
	assert.match(r.epoch, /^[0-9a-f]{32}$/);
	assert.equal(L.list(db).length, 3);
});

it("claim → commit → renew → release → finish: the happy path", () => {
	const c = L.claim(db, "ben@laptop/s1", 600, KEY);
	assert.equal(c.name, "p1");
	assert.equal(L.get(db, "p1").state, "ACQUIRING");
	assert.ok(L.commit(db, c.name, c.gen));
	assert.equal(L.get(db, "p1").state, "LEASED");
	at(T0 + 100);
	assert.equal(L.renew(db, c.lease_id, 900).expires_at, T0 + 100 + 900);
	const r = L.beginReset(db, c.lease_id);
	assert.equal(L.get(db, "p1").state, "RESETTING");
	assert.throws(() => L.renew(db, c.lease_id, 600), /unknown lease/, "lease id dies at release");
	assert.ok(L.finish(db, r.name, r.gen, "FREE"));
	const row = L.get(db, "p1");
	assert.deepEqual([row.state, row.holder, row.pubkey, row.lease_id], ["FREE", null, null, null]);
});

it("claims hand out distinct VMs, least-recently-used first, and null when exhausted", () => {
	const names = [1, 2, 3].map(() => L.claim(db, "h", 600, KEY).name);
	assert.deepEqual(names.sort(), ["p1", "p2", "p3"]);
	assert.equal(L.claim(db, "h", 600, KEY), null);
});

it("TTL is clamped to [60s, 8h]", () => {
	assert.equal(L.claim(db, "h", 1, KEY).expires_at, T0 + L.TTL_MIN);
	assert.equal(L.claim(db, "h", 10 ** 9, KEY).expires_at, T0 + L.TTL_MAX);
});

it("input validation: holder and public key", () => {
	assert.throws(() => L.claim(db, "bad holder; rm", 600, KEY), /invalid holder/);
	assert.throws(() => L.claim(db, "h", 600, "not a key"), /invalid ssh public key/);
	assert.throws(() => L.claim(db, "h", 600, `${KEY}\nssh-ed25519 AAAA second`), /invalid ssh public key/);
});

it("expired leases can't be renewed and are reaped", () => {
	const c = L.claim(db, "h", 600, KEY);
	L.commit(db, c.name, c.gen);
	at(T0 + 601);
	assert.throws(() => L.renew(db, c.lease_id, 600), /expired/);
	const due = L.due(db);
	assert.deepEqual(
		due.map((d) => [d.name, d.reason]),
		[["p1", "expired"]],
	);
	assert.equal(L.get(db, "p1").state, "RESETTING");
	assert.deepEqual(L.due(db), [], "a fresh RESETTING row is not reaped twice");
});

it("a host reboot voids every lease (boot id fencing)", () => {
	const c = L.claim(db, "h", 3600, KEY);
	L.commit(db, c.name, c.gen);
	process.env.BOXERY_BOOT_ID = "boot-2";
	assert.throws(() => L.renew(db, c.lease_id, 600), /rebooted/);
	assert.deepEqual(L.due(db).map((d) => d.reason), ["host rebooted"]);
});

it("generation fencing: a stale commit or finish loses", () => {
	const c = L.claim(db, "h", 600, KEY);
	at(T0 + L.STALE_SECS + 1); // acquirer crashed mid-way; reaper takes over
	const [d] = L.due(db);
	assert.equal(d.reason, "stale ACQUIRING");
	assert.equal(L.commit(db, c.name, c.gen), false, "late commit after the reaper is rejected");
	assert.equal(L.finish(db, d.name, d.gen - 1, "FREE"), false, "old generation can't finish");
	assert.ok(L.finish(db, d.name, d.gen, "FREE"));
	assert.equal(L.get(db, "p1").state, "FREE");
	assert.throws(() => L.beginResetName(db, c.name, c.gen), /fenced/);
});

it("stale RESETTING (crashed reset) is retried; BROKEN is never handed out", () => {
	const c = L.claim(db, "h", 600, KEY);
	L.commit(db, c.name, c.gen);
	L.beginReset(db, c.lease_id); // ...and the resetter dies
	at(T0 + L.STALE_SECS + 1);
	const [d] = L.due(db);
	assert.equal(d.reason, "stale RESETTING");
	assert.ok(L.finish(db, d.name, d.gen, "BROKEN"));
	const names = [1, 2, 3].map(() => L.claim(db, "h", 600, KEY)?.name ?? null);
	assert.ok(!names.includes("p1"), "BROKEN VM was claimed");
});

it("observed reset candidates are revalidated after renewal and pool reincarnation", () => {
	const c = L.claim(db, "h", 600, KEY);
	L.commit(db, c.name, c.gen);
	at(T0 + 601);
	const [observed] = L.candidates(db);
	assert.equal(observed.state, "LEASED", "observation does not change state");
	// A renewal that won before the reaper obtained its lock changes the deadline, not generation.
	at(T0 + 500);
	L.renew(db, c.lease_id, 900);
	at(T0 + 601);
	assert.deepEqual(L.due(db, observed.name, observed.gen, observed.epoch), []);
	L.remove(db, c.name, true);
	L.add(db, c.name);
	const replacement = L.get(db, c.name);
	assert.notEqual(replacement.epoch, observed.epoch);
	// Even a matching numeric generation from a removed/re-added row is not the same VM epoch.
	db.prepare("UPDATE vms SET state='RESETTING', gen=?, updated_at=0 WHERE name=?").run(observed.gen, c.name);
	assert.deepEqual(L.due(db, observed.name, observed.gen, observed.epoch), []);
});

it("claims skip resource-locked VMs even after reset commits FREE", () => {
	db.prepare("INSERT INTO operation_locks(resource, operation_id) VALUES('p1', 'reset-in-progress')").run();
	assert.equal(L.claim(db, "h", 600, KEY).name, "p2");
	db.prepare("DELETE FROM operation_locks WHERE resource='p1'").run();
	assert.equal(L.claim(db, "h", 600, KEY).name, "p1");
});

it("a delayed acquire cannot commit an expired or pre-reboot lease", () => {
	const c = L.claim(db, "h", 600, KEY);
	at(T0 + 600);
	assert.equal(L.commit(db, c.name, c.gen), false);
	at(T0);
	process.env.BOXERY_BOOT_ID = "boot-2";
	assert.equal(L.commit(db, c.name, c.gen), false);
});

it("remove refuses leased VMs unless forced", () => {
	const c = L.claim(db, "h", 600, KEY);
	L.commit(db, c.name, c.gen);
	assert.throws(() => L.remove(db, "p1"), /LEASED/);
	assert.ok(L.remove(db, "p1", true));
	assert.equal(L.get(db, "p1"), null);
});

it("concurrent claims from separate processes never share a VM", async () => {
	const run = promisify(execFile);
	const mod = new URL("../host/boxery-leases.mjs", import.meta.url).href;
	const claim = `const L = await import(${JSON.stringify(mod)}); const [f, h, t, k] = process.argv.slice(1);
		process.stdout.write(JSON.stringify(L.claim(L.open(f), h, t, k)));`;
	for (const n of ["p4", "p5", "p6", "p7", "p8"]) L.add(db, n); // 8 total
	const env = { ...process.env, BOXERY_NOW: String(T0), BOXERY_BOOT_ID: "boot-1" };
	const results = await Promise.all(
		Array.from({ length: 12 }, (_, i) =>
			run(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", claim, file, `h${i}`, "600", KEY], { env }).then((r) => JSON.parse(r.stdout)),
		),
	);
	const got = results.filter(Boolean).map((r) => r.name);
	assert.equal(got.length, 8, "exactly 8 of 12 claims succeed");
	assert.equal(new Set(got).size, 8, "no VM handed out twice");
});
