// Small helpers shared by the host's Node modules: validation, output formatting, stdin.
import { readSync } from "node:fs";

export const VALID_NAME = /^[a-z][a-z0-9-]{0,30}$/;
export const VALID_SNAP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const VALID_IMAGE = /^[a-z][a-z0-9-]{0,30}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const POOL_SNAP = "boxery-clean"; // a pool VM's clean state is the image NAME@boxery-clean
// POSIX shell word for the exceptional OpenSSH ProxyCommand boundary (ordinary calls use argv).
export const shellQuote = (/** @type {unknown} */ s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Fail the command: "boxery-host: MESSAGE" on stderr, exit status EXITCODE.
 *  @type {(message: string, exitCode?: number) => never} */
export const fail = (message, exitCode = 1) => { throw Object.assign(new Error(message), { exitCode }); };
/** @param {string | undefined} n @returns {string} */
export const validName = (n) => (VALID_NAME.test(n ?? "") ? /** @type {string} */ (n) : fail(`invalid name '${n ?? ""}' (use [a-z][a-z0-9-]*)`));
/** @param {string | undefined} s @returns {string} */
export const validSnap = (s) => (VALID_SNAP.test(s ?? "") ? /** @type {string} */ (s) : fail(`invalid snapshot name '${s ?? ""}'`));
/** @param {string | undefined} i @returns {string} */
export const validImage = (i) => (VALID_IMAGE.test(i ?? "") ? /** @type {string} */ (i) : fail(`invalid image name '${i ?? ""}'`));
/** @param {string} flag @param {string | undefined} v @returns {string} */
export const validNum = (flag, v) => (/^[0-9]+$/.test(v ?? "") ? /** @type {string} */ (v) : fail(`${flag} must be a number`));

/** @param {number} ms @returns {Promise<void>} */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (/** @type {string} */ message) => process.stderr.write(`==> ${message}\n`);
export const print = (/** @type {string} */ text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
// One element per line: still plain JSON, and the controller (which has no jq) relies on it.
export const jsonArray = (/** @type {unknown[]} */ items) => (items.length ? `[\n${items.map((i) => JSON.stringify(i)).join(",\n")}\n]` : "[]");
// printf-style columns: width N = %-Ns, -N = %Ns, no width = %s
/** @param {Array<number | null | undefined>} widths @param {unknown[][]} rows */
export const table = (widths, rows) => rows.map((r) => r.map((v, i) => (widths[i] == null ? String(v)
	: widths[i] < 0 ? String(v).padStart(-widths[i]) : String(v).padEnd(widths[i]))).join(" ")).join("\n");

/** Local time as YYYYmmdd + SEP + HHMMSS (snapshot and fork-image labels). */
export function stamp(sep = "") {
	const d = new Date(), p = (/** @type {number} */ n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${sep}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Read FD synchronously: up to LIMIT bytes, or through the first newline with untilNewline.
 * Copes with an inherited non-blocking descriptor.
 * @param {number} fd @param {{ limit?: number, untilNewline?: boolean }} [opts] */
export function readFd(fd, { limit = Infinity, untilNewline = false } = {}) {
	/** @type {Buffer[]} */
	const chunks = [], buf = Buffer.alloc(65536);
	let total = 0;
	while (total < limit) {
		/** @type {number} */
		let n;
		try { n = readSync(fd, buf, 0, Math.min(buf.length, limit - total), null); }
		catch (/** @type {any} */ e) {
			if (e.code === "EAGAIN") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue; }
			if (e.code === "EOF") break;
			throw e;
		}
		if (n === 0) break;
		chunks.push(Buffer.from(buf.subarray(0, n)));
		total += n;
		if (untilNewline && buf.subarray(0, n).includes(10)) break;
	}
	return Buffer.concat(chunks).toString("utf8");
}
