// What a VM is, per VM, as one-token records under $CONF, fixed for the VM's life. A VM made from an image or
// a fork gets its source VM's records (an image VM@LABEL is a disk of VM).
// - kind: $CONF/vm-kind/NAME, "desktop" or "headless" (no record: desktop, like every VM before headless
//   existed). The guest has /etc/boxery/headless too.
// - os: $CONF/vm-os/NAME, the guest OS (guests/index.mjs; no record: linux, like every VM before macOS
//   guests were planned).
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_OS } from "../guests/index.mjs";

/** @typedef {"desktop" | "headless"} VmKind */

/** One record directory: get (fallback when there's no record), all ({NAME: value} for VMs with a record),
 *  set, delete. @param {string} dir @param {string} fallback */
function tokenRecord(dir, fallback) {
	const file = (/** @type {string} */ conf, /** @type {string} */ name) => path.join(conf, dir, name);
	/** @param {string} conf @param {string} name @returns {string} */
	const get = (conf, name) => {
		try { return readFileSync(file(conf, name), "utf8").trim() || fallback; }
		catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return fallback; throw e; }
	};
	return {
		get,
		/** @param {string} conf @returns {Record<string, string>} */
		all(conf) {
			/** @type {string[]} */
			let names = [];
			try { names = readdirSync(path.join(conf, dir)).filter((n) => !n.endsWith(".tmp")); }
			catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; }
			return Object.fromEntries(names.map((n) => [n, get(conf, n)]));
		},
		/** @param {string} conf @param {string} name @param {string} value */
		set(conf, name, value) {
			mkdirSync(path.join(conf, dir), { recursive: true });
			writeFileSync(`${file(conf, name)}.tmp`, `${value}\n`);
			renameSync(`${file(conf, name)}.tmp`, file(conf, name));
		},
		/** @param {string} conf @param {string} name */
		delete(conf, name) {
			rmSync(file(conf, name), { force: true });
			rmSync(`${file(conf, name)}.tmp`, { force: true });
		},
	};
}

const kind = tokenRecord("vm-kind", "desktop");
const os = tokenRecord("vm-os", DEFAULT_OS);

/** @param {string} conf @param {string} name @returns {string} the recorded kind ("desktop" | "headless") */
export const vmKind = kind.get;
/** {NAME: kind} for VMs with a record @param {string} conf @returns {Record<string, string>} */
export const vmKinds = kind.all;
/** @param {string} conf @param {string} name @param {string} value */
export const setVmKind = kind.set;

/** @param {string} conf @param {string} name @returns {string} the recorded guest OS ("linux") */
export const vmOs = os.get;
/** {NAME: os} for VMs with a record @param {string} conf @returns {Record<string, string>} */
export const vmOses = os.all;
/** @param {string} conf @param {string} name @param {string} value */
export const setVmOs = os.set;

/** Drop all of NAME's records here (rm, and recovery of a failed new). @param {string} conf @param {string} name */
export function deleteVmType(conf, name) {
	kind.delete(conf, name);
	os.delete(conf, name);
}
