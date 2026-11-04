// What each VM is: one row per VM in the host's store (vm_records in leases.db, boxery-leases.mjs),
// written when the VM is made and deleted with it, each in one statement.
// - kind: "desktop" or "headless". Fixed for the VM's life. The guest has /etc/boxery/headless too.
// - os: the guest OS (guests/index.mjs). Fixed for the VM's life; checked on write.
// - size: {shape, cpus, mem, disk}, so forks and `ls` know it. shape null = custom (size flags, resize).
// A VM made from an image or a fork gets its source VM's kind and OS (an image VM@LABEL is a disk of VM).
// No row (made outside boxery, or before any record): desktop, linux, no size (ls reads that from the
// backend once and records it). Writers hold the VM's lifecycle lock, except ls's addVmSize.
import { DEFAULT_OS, guestOs } from "../guests/index.mjs";
/** @import { DatabaseSync } from "node:sqlite" */
/** @import { ShapeInput, ShapeRecord } from "./shapes.mjs" */

/** @typedef {"desktop" | "headless"} VmKind */
/** @typedef {{ kind: VmKind, os: string, size: ShapeRecord | null }} VmRecord */
/** @typedef {{ name: string, kind: VmKind, os: string, shape: string | null, cpus: number | null, mem: number | null, disk: number | null }} Row */

/** @param {Row} r @returns {VmRecord} */
const toRecord = (r) => ({ kind: r.kind, os: r.os,
	size: r.cpus == null ? null : { shape: r.shape, cpus: r.cpus, mem: /** @type {number} */ (r.mem), disk: /** @type {number} */ (r.disk) } });
/** shape, cpus, mem, disk as stored @param {ShapeInput | null} s @returns {[string | null, number | null, number | null, number | null]} */
const sizeCols = (s) => (s ? [s.shape || null, Number(s.cpus), Number(s.mem), Number(s.disk)] : [null, null, null, null]);
// A size for a VM without a row comes with the defaults for the rest.
const UPSERT_SIZE = `INSERT INTO vm_records (name, kind, os, shape, cpus, mem, disk) VALUES (?, 'desktop', '${DEFAULT_OS}', ?, ?, ?, ?)
	ON CONFLICT (name) DO UPDATE SET shape = excluded.shape, cpus = excluded.cpus, mem = excluded.mem, disk = excluded.disk`;

/** NAME's record (the defaults without one). @param {DatabaseSync} db @param {string} name @returns {VmRecord} */
export function vmRecord(db, name) {
	const r = /** @type {Row | undefined} */ (db.prepare("SELECT * FROM vm_records WHERE name = ?").get(name));
	return r ? toRecord(r) : { kind: "desktop", os: DEFAULT_OS, size: null };
}
/** {NAME: record} for VMs with a row (ls). @param {DatabaseSync} db @returns {Record<string, VmRecord>} */
export function vmRecords(db) {
	return Object.fromEntries(/** @type {Row[]} */ (db.prepare("SELECT * FROM vm_records ORDER BY name").all()).map((r) => [r.name, toRecord(r)]));
}
/** The kind and OS a VM made from IMAGE (VM@LABEL, or a VM's name) inherits: VM's. Throws if this
 *  boxery doesn't know that OS. @param {DatabaseSync} db @param {string} image */
export function inheritedType(db, image) {
	const { kind, os } = vmRecord(db, image.split("@")[0]);
	guestOs(os);
	return { kind, os };
}
/** A new VM's record, replacing any (ls may have recorded a size while the VM was being made).
 *  size null: none (the backend manages it). @param {DatabaseSync} db @param {string} name
 *  @param {{ kind: VmKind, os: string, size: ShapeInput | null }} record */
export function createVmRecord(db, name, { kind, os, size }) {
	guestOs(os);
	db.prepare("INSERT OR REPLACE INTO vm_records (name, kind, os, shape, cpus, mem, disk) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run(name, kind, os, ...sizeCols(size));
}
/** NAME's size changed (resize: shape null). @param {DatabaseSync} db @param {string} name @param {ShapeInput} size */
export function setVmSize(db, name, size) {
	db.prepare(UPSERT_SIZE).run(name, ...sizeCols(size));
}
/** Record NAME's size only if it has none yet, for callers that hold no VM lock (ls), so a concurrent
 *  new/resize always wins. false if it has one. @param {DatabaseSync} db @param {string} name @param {ShapeInput} size */
export function addVmSize(db, name, size) {
	return db.prepare(`${UPSERT_SIZE} WHERE vm_records.cpus IS NULL`).run(name, ...sizeCols(size)).changes === 1;
}
/** Drop NAME's record (rm, and recovery of a failed new). @param {DatabaseSync} db @param {string} name */
export function deleteVmRecord(db, name) {
	db.prepare("DELETE FROM vm_records WHERE name = ?").run(name);
}
