// Small helpers shared by the host's Node modules: validation, output formatting, stdin.
import { readSync } from "node:fs";

export const VALID_NAME = /^[a-z][a-z0-9-]{0,30}$/;
export const VALID_SNAP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const VALID_IMAGE = /^[a-z][a-z0-9-]{0,30}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const POOL_SNAP = "boxery-clean"; // a pool VM's clean state is the image NAME@boxery-clean

/** Fail the command: "boxery-host: MESSAGE" on stderr, exit status EXITCODE. */
export const fail = (message, exitCode = 1) => { throw Object.assign(new Error(message), { exitCode }); };
export const validName = (n) => (VALID_NAME.test(n ?? "") ? n : fail(`invalid name '${n ?? ""}' (use [a-z][a-z0-9-]*)`));
export const validSnap = (s) => (VALID_SNAP.test(s ?? "") ? s : fail(`invalid snapshot name '${s ?? ""}'`));
export const validImage = (i) => (VALID_IMAGE.test(i ?? "") ? i : fail(`invalid image name '${i ?? ""}'`));
export const validNum = (flag, v) => (/^[0-9]+$/.test(v ?? "") ? v : fail(`${flag} must be a number`));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (message) => process.stderr.write(`==> ${message}\n`);
export const print = (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
// One element per line: still plain JSON, and the controller (which has no jq) relies on it.
export const jsonArray = (items) => (items.length ? `[\n${items.map((i) => JSON.stringify(i)).join(",\n")}\n]` : "[]");
// printf-style columns: width N = %-Ns, -N = %Ns, no width = %s
export const table = (widths, rows) => rows.map((r) => r.map((v, i) => (widths[i] == null ? String(v)
	: widths[i] < 0 ? String(v).padStart(-widths[i]) : String(v).padEnd(widths[i]))).join(" ")).join("\n");

/** Local time as YYYYmmdd + SEP + HHMMSS (snapshot and fork-image labels). */
export function stamp(sep = "") {
	const d = new Date(), p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${sep}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Read FD synchronously: up to LIMIT bytes, or through the first newline with untilNewline.
 * Copes with an inherited non-blocking descriptor. */
export function readFd(fd, { limit = Infinity, untilNewline = false } = {}) {
	const chunks = [], buf = Buffer.alloc(65536);
	let total = 0;
	while (total < limit) {
		let n;
		try { n = readSync(fd, buf, 0, Math.min(buf.length, limit - total), null); }
		catch (e) {
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
