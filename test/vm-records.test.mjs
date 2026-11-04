// Each VM's record (host/vm-records.mjs): kind, guest OS and size, one row per VM in the host's store.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
let L, R;
try {
	L = await import("../host/boxery-leases.mjs");
	R = await import("../host/vm-records.mjs");
} catch (e) {
	if (!String(e?.message).includes("sqlite")) throw e;
}
const it = L ? test : test.skip; // the store needs node:sqlite (Node >= 22.13)

let db;
beforeEach(() => {
	if (L) db = L.open(path.join(mkdtempSync(path.join(tmpdir(), "boxery-records-")), "leases.db"));
});
const NONE = { kind: "desktop", os: "linux", size: null };

it("round trip: a new VM's record reads back with numbers; no row reads as desktop, linux, no size", () => {
	assert.deepEqual(R.vmRecord(db, "a"), NONE);
	R.createVmRecord(db, "a", { kind: "headless", os: "linux", size: { shape: "large", cpus: "8", mem: "16384", disk: "80" } });
	R.createVmRecord(db, "b", { kind: "desktop", os: "linux", size: { shape: "", cpus: 2, mem: 2048, disk: 10 } });
	R.createVmRecord(db, "c", { kind: "headless", os: "linux", size: null });
	assert.deepEqual(R.vmRecord(db, "a"), { kind: "headless", os: "linux", size: { shape: "large", cpus: 8, mem: 16384, disk: 80 } });
	assert.deepEqual(R.vmRecords(db), {
		a: { kind: "headless", os: "linux", size: { shape: "large", cpus: 8, mem: 16384, disk: 80 } },
		b: { kind: "desktop", os: "linux", size: { shape: null, cpus: 2, mem: 2048, disk: 10 } }, // "" = custom
		c: { kind: "headless", os: "linux", size: null },
	});
	assert.throws(() => R.createVmRecord(db, "d", { kind: "tablet", os: "linux", size: null }), /CHECK/);
});

it("an unknown guest OS is refused on write and on inheritance, before anything is written", () => {
	assert.throws(() => R.createVmRecord(db, "m", { kind: "desktop", os: "macos", size: null }), /unknown guest OS: macos/);
	assert.deepEqual(R.vmRecords(db), {});
	// A row this boxery didn't write (a newer one's guest OS): it lists, but nothing is made from it.
	db.prepare("INSERT INTO vm_records (name, kind, os) VALUES ('n', 'headless', 'testos')").run();
	assert.equal(R.vmRecord(db, "n").os, "testos");
	assert.throws(() => R.inheritedType(db, "n@s1"), /unknown guest OS: testos/);
});

it("a VM from an image of VM, or a fork of VM, gets VM's kind and OS", () => {
	R.createVmRecord(db, "src", { kind: "headless", os: "linux", size: { shape: "small", cpus: 2, mem: 4096, disk: 20 } });
	assert.deepEqual(R.inheritedType(db, "src@s1"), { kind: "headless", os: "linux" });
	assert.deepEqual(R.inheritedType(db, "src@fork-x"), { kind: "headless", os: "linux" });
	assert.deepEqual(R.inheritedType(db, "gone@s1"), { kind: "desktop", os: "linux" }, "a source without a record: the defaults");
});

it("sizes: resize replaces it, ls's backfill only fills a missing one, and a new VM's record replaces a backfilled one", () => {
	R.createVmRecord(db, "a", { kind: "headless", os: "linux", size: { shape: "large", cpus: 8, mem: 16384, disk: 80 } });
	R.setVmSize(db, "a", { shape: null, cpus: 12, mem: 16384, disk: 80 });
	assert.deepEqual(R.vmRecord(db, "a"), { kind: "headless", os: "linux", size: { shape: null, cpus: 12, mem: 16384, disk: 80 } }, "kind and OS kept");
	assert.equal(R.addVmSize(db, "a", { shape: null, cpus: 1, mem: 1, disk: 1 }), false);
	assert.equal(R.vmRecord(db, "a").size.cpus, 12);
	assert.equal(R.addVmSize(db, "old", { shape: null, cpus: 4, mem: 8192, disk: 40 }), true, "no row");
	assert.deepEqual(R.vmRecord(db, "old"), { ...NONE, size: { shape: null, cpus: 4, mem: 8192, disk: 40 } });
	R.createVmRecord(db, "kindonly", { kind: "headless", os: "linux", size: null });
	assert.equal(R.addVmSize(db, "kindonly", { shape: null, cpus: 2, mem: 2048, disk: 10 }), true, "a row without a size");
	assert.equal(R.vmRecord(db, "kindonly").kind, "headless");
	R.setVmSize(db, "fresh", { shape: null, cpus: 1, mem: 512, disk: 5 });
	assert.deepEqual(R.vmRecord(db, "fresh"), { ...NONE, size: { shape: null, cpus: 1, mem: 512, disk: 5 } });
	// ls saw the VM between backend_new and the record: new's record wins.
	R.addVmSize(db, "racing", { shape: null, cpus: 4, mem: 8192, disk: 40 });
	R.createVmRecord(db, "racing", { kind: "headless", os: "linux", size: { shape: "standard", cpus: 4, mem: 8192, disk: 40 } });
	assert.deepEqual(R.vmRecord(db, "racing"), { kind: "headless", os: "linux", size: { shape: "standard", cpus: 4, mem: 8192, disk: 40 } });
});

it("one delete drops the whole record", () => {
	R.createVmRecord(db, "a", { kind: "headless", os: "linux", size: { shape: "small", cpus: 2, mem: 4096, disk: 20 } });
	R.createVmRecord(db, "b", { kind: "headless", os: "linux", size: null });
	R.deleteVmRecord(db, "a");
	R.deleteVmRecord(db, "never");
	assert.deepEqual(R.vmRecord(db, "a"), NONE);
	assert.deepEqual(Object.keys(R.vmRecords(db)), ["b"]);
});
