// Desktop or headless, per VM: $CONF/vm-kind/NAME holds "desktop" or "headless" (no record: desktop, like
// every VM before headless existed). Fixed for a VM's life; a VM made from an image or a fork gets its
// source VM's kind (an image VM@LABEL is a disk of VM). The guest has /etc/boxery/headless too.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** @typedef {"desktop" | "headless"} VmKind */

/** @param {string} conf @param {string} name */
const file = (conf, name) => path.join(conf, "vm-kind", name);

/** @param {string} conf @param {string} name @returns {string} the recorded kind ("desktop" | "headless") */
export function vmKind(conf, name) {
	try { return readFileSync(file(conf, name), "utf8").trim() || "desktop"; }
	catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return "desktop"; throw e; }
}
/** {NAME: kind} for VMs with a record @param {string} conf @returns {Record<string, string>} */
export function vmKinds(conf) {
	/** @type {string[]} */
	let names = [];
	try { names = readdirSync(path.join(conf, "vm-kind")).filter((n) => !n.endsWith(".tmp")); }
	catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; }
	return Object.fromEntries(names.map((n) => [n, vmKind(conf, n)]));
}
/** @param {string} conf @param {string} name @param {string} kind */
export function setVmKind(conf, name, kind) {
	mkdirSync(path.join(conf, "vm-kind"), { recursive: true });
	writeFileSync(`${file(conf, name)}.tmp`, `${kind}\n`);
	renameSync(`${file(conf, name)}.tmp`, file(conf, name));
}
/** @param {string} conf @param {string} name */
export function deleteVmKind(conf, name) {
	rmSync(file(conf, name), { force: true });
	rmSync(`${file(conf, name)}.tmp`, { force: true });
}
