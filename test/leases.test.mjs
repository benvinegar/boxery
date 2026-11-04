// Lease state machine (host/boxery-leases.mjs): transitions, fencing, expiry, reboot, concurrency.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

it("claim --only: one of the listed VMs or none (the runner manager never takes an agent's VM); heldBy finds a holder's rows", () => {
	assert.equal(L.claim(db, "github-runner", 600, KEY, ["p3", "nope"]).name, "p3");
	assert.equal(L.claim(db, "github-runner", 600, KEY, ["p3"]), null, "p3 is taken; p1 and p2 are not candidates");
	assert.equal(L.claim(db, "someone", 600, KEY).name, "p1", "no list: any free VM");
	assert.throws(() => L.claim(db, "h", 600, KEY, ["Bad Name"]), /invalid VM list/);
	assert.throws(() => L.claim(db, "h", 600, KEY, []), /invalid VM list/);
	assert.deepEqual(L.heldBy(db, "github-runner").map((r) => [r.name, r.state, /^l-/.test(r.lease_id)]), [["p3", "ACQUIRING", true]]);
	assert.deepEqual(L.heldBy(db, "nobody"), []);
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

// Schema version (PRAGMA user_version) and the copy `boxery-host upgrade` takes and restores.
const raw = async (f) => new (await import("node:sqlite")).DatabaseSync(f);
const columns = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const tables = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const TABLES = ["operation_intents", "operation_locks", "operations", "vm_records", "vms"];

it("a new store records the schema version", () => {
	assert.equal(L.schemaVersion(db), L.SCHEMA_VERSION);
	assert.deepEqual(tables(db), TABLES);
});

it("a store from before versioning (user_version 0) migrates without losing rows", () => {
	const c = L.claim(db, "h", 600, KEY);
	L.commit(db, c.name, c.gen);
	db.exec("PRAGMA user_version = 0");
	db.close();
	db = L.open(file);
	assert.equal(L.schemaVersion(db), L.SCHEMA_VERSION);
	assert.equal(L.get(db, c.name).state, "LEASED");
	assert.equal(L.renew(db, c.lease_id, 600).name, c.name);
});

// v1 → v2: each VM's record files ($CONF/vm-kind/NAME, vm-os/NAME, vm-shapes/NAME.json) become vm_records rows.
const conf = () => path.dirname(file);
/** Turn the open store back into a version-V one without vm_records, with these files beside it. */
async function oldStore(v, files) {
	db.close();
	const d = await raw(file);
	d.exec(`DROP TABLE vm_records; PRAGMA user_version = ${v}`);
	d.close();
	for (const [f, content] of Object.entries(files)) {
		mkdirSync(path.join(conf(), path.dirname(f)), { recursive: true });
		writeFileSync(path.join(conf(), f), content);
	}
}
const rows = () => db.prepare("SELECT * FROM vm_records ORDER BY name").all().map((r) => ({ ...r }));
/** @param {string} name @param {string} kind @param {string} os @param {string | null} [shape] @param {number | null} [cpus] @param {number | null} [mem] @param {number | null} [disk] */
const rec = (name, kind, os, shape = null, cpus = null, mem = null, disk = null) => ({ name, kind, os, shape, cpus, mem, disk });

it("v1 → v2 imports the record files, with defaults for the records a VM lacks, and retires them", async () => {
	const c = L.claim(db, "h", 600, KEY);
	L.commit(db, c.name, c.gen);
	const files = {
		"vm-kind/full": "headless\n", "vm-os/full": "linux\n", "vm-shapes/full.json": '{"shape":"large","cpus":8,"mem":16384,"disk":80}\n',
		"vm-kind/kindonly": "headless\n",
		"vm-os/osonly": "linux\n",
		"vm-shapes/custom.json": '{"shape":null,"cpus":2,"mem":2048,"disk":10}\n',
		"vm-kind/torn": "desktop\n", "vm-shapes/torn.json": '{"shape":"sm',
		"vm-kind/odd": "\n", "vm-os/odd": "\n",
		"vm-kind/half.tmp": "headless\n", "vm-shapes/half.json.123.tmp": "{}", "vm-shapes/Bad Name.json": "{}",
	};
	await oldStore(1, files);
	db = L.open(file);
	assert.equal(L.schemaVersion(db), 2);
	assert.deepEqual(rows(), [
		rec("custom", "desktop", "linux", null, 2, 2048, 10),
		rec("full", "headless", "linux", "large", 8, 16384, 80),
		rec("kindonly", "headless", "linux"),
		rec("odd", "desktop", "linux"),
		rec("osonly", "desktop", "linux"),
		rec("torn", "desktop", "linux"),
	]);
	for (const [f, content] of Object.entries(files)) {
		const [dir, ...rest] = f.split("/");
		assert.equal(existsSync(path.join(conf(), dir)), false, `${dir} retired`);
		assert.equal(readFileSync(path.join(conf(), `${dir}.imported`, ...rest), "utf8"), content, `${f} kept as it was`);
	}
	assert.equal(L.get(db, c.name).state, "LEASED", "lease rows are kept");
	db.close();
	db = L.open(file); // opening again imports nothing again
	assert.equal(rows().length, 6);
	// A store recreated later (deleted by hand) doesn't bring the retired records back.
	db.close();
	for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
	db = L.open(file);
	assert.deepEqual(rows(), []);
});

it("v1 → v2: a record file that can't be read counts as missing; the store still opens", async () => {
	await oldStore(1, { "vm-kind/locked": "headless\n", "vm-os/locked": "linux\n", "vm-os/dir/x": "" });
	chmodSync(path.join(conf(), "vm-kind/locked"), 0o000);
	try {
		db = L.open(file);
		assert.equal(L.schemaVersion(db), 2);
		// root reads the file anyway; anyone else gets the default kind
		const kind = process.getuid?.() === 0 ? "headless" : "desktop";
		assert.deepEqual(rows(), [rec("dir", "desktop", "linux"), rec("locked", kind, "linux")]);
	} finally { chmodSync(path.join(conf(), "vm-kind.imported/locked"), 0o644); }
});

it("v1 → v2 with no record files, and a store from before versioning with some", async () => {
	await oldStore(1, {});
	db = L.open(file);
	assert.equal(L.schemaVersion(db), L.SCHEMA_VERSION);
	assert.deepEqual(rows(), []);
	await oldStore(0, { "vm-kind/old": "headless\n" });
	db = L.open(file);
	assert.deepEqual(rows(), [rec("old", "headless", "linux")]);
});

it("a store newer than the code is refused with a clear error and left as it is", async () => {
	db.close();
	const d = await raw(file);
	d.exec(`PRAGMA user_version = ${L.SCHEMA_VERSION + 1}; ALTER TABLE vms ADD COLUMN zone TEXT`);
	d.close();
	assert.throws(() => L.open(file), new RegExp(`schema version ${L.SCHEMA_VERSION + 1}, newer than this boxery understands \\(${L.SCHEMA_VERSION}\\).*Upgrad`));
	const after = await raw(file);
	assert.equal(L.schemaVersion(after), L.SCHEMA_VERSION + 1, "not downgraded or rewritten");
	assert.ok(columns(after, "vms").includes("zone"));
	after.close();
});

it("backup + restore: schema, rows and version come back; generations move past the newer store's", () => {
	const c = L.claim(db, "h", 600, KEY);
	L.commit(db, c.name, c.gen);
	const copy = `${file}.copy`;
	L.backup(db, copy, (d) => d.prepare("DELETE FROM vms WHERE name='p3'").run());
	const other = L.open(file); // another process's connection, open across the restore
	// What a newer release might do on open (a column, a table, a higher version), then a claim.
	db.exec(`ALTER TABLE vms ADD COLUMN zone TEXT; CREATE TABLE extras (x); INSERT INTO extras VALUES (1); PRAGMA user_version = ${L.SCHEMA_VERSION + 1}`);
	const late = L.claim(db, "late", 600, KEY);
	let inside = false;
	L.restore(db, copy, () => { try { db.exec("BEGIN"); db.exec("ROLLBACK"); } catch { inside = true; } }); // no nesting
	assert.ok(inside, "then() runs inside the restore's transaction");
	assert.equal(L.schemaVersion(db), L.SCHEMA_VERSION);
	assert.deepEqual(tables(db), TABLES);
	assert.ok(!columns(db, "vms").includes("zone"));
	assert.equal(L.get(db, "p3"), null, "the edited copy is what comes back");
	assert.equal(L.get(other, c.name).holder, "h", "other connections see the restored rows");
	assert.equal(L.get(other, late.name).state, "FREE", "the late claim is undone");
	assert.equal(L.commit(other, late.name, late.gen), false, "and fenced");
	const again = L.claim(other, "again", 600, KEY);
	assert.equal(again.name, late.name);
	assert.ok(again.gen > late.gen, "its generation is never reissued");
	assert.equal(L.renew(other, c.lease_id, 600).name, c.name, "a lease from before the copy survives");
	assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get(), "AUTOINCREMENT bookkeeping restored");
	other.close();
	db.close();
	db = L.open(file);
	assert.equal(L.schemaVersion(db), L.SCHEMA_VERSION);
});
