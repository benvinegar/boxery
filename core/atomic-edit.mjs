// Guest-only operation, sent as source by editTool. Linux + Node + util-linux flock.
import fs from "node:fs/promises";
import { constants as C } from "node:fs";
import path from "node:path";
/** @import { BigIntStats } from "node:fs" */
/** @typedef {{ path: string, edits: { oldText?: string, newText?: string | null }[] }} EditRequest */
/** @typedef {(original: string, edits: EditRequest["edits"]) => string} ApplyEdits */

const MAX = 16 * 1024 * 1024;
const version = (/** @type {BigIntStats} */ s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.gid, s.nlink].join(":");
const identity = (/** @type {BigIntStats} */ s) => `${s.dev}:${s.ino}`;
const conflict = () => { throw new Error("edit conflict: file or resolved path changed; reread and retry"); };

/** @param {string} target */
async function observe(target) {
	if (!(await fs.lstat(target)).isFile()) throw new Error("not a regular file");
	// O_RDWR respects ordinary write permissions; NONBLOCK rejects a raced-in FIFO.
	const file = await fs.open(target, C.O_RDWR | C.O_NOFOLLOW | C.O_NONBLOCK);
	try {
		const stat = await file.stat({ bigint: true });
		if (!stat.isFile()) throw new Error("not a regular file");
		if (stat.nlink !== 1n) throw new Error("cannot atomically edit multiply-linked file");
		if (stat.size > BigInt(MAX)) throw new Error("edit file exceeds 16 MiB");
		const chunks = [];
		let size = 0;
		while (size <= MAX) {
			const chunk = Buffer.alloc(Math.min(65536, MAX + 1 - size));
			const { bytesRead } = await file.read(chunk);
			if (!bytesRead) break;
			chunks.push(chunk.subarray(0, bytesRead)); size += bytesRead;
		}
		if (size > MAX) throw new Error("edit file exceeds 16 MiB");
		if (version(stat) !== version(await file.stat({ bigint: true })) ||
			version(stat) !== version(await fs.lstat(target, { bigint: true }))) conflict();
		return { stat, data: Buffer.concat(chunks, size) };
	} finally { await file.close(); }
}

/** @param {EditRequest} request @param {ApplyEdits} applyEdits @param {() => void} [check] */
export async function atomicEdit(request, applyEdits, check = () => {}) {
	let temp;
	try {
		check();
		const target = await fs.realpath(request.path), parent = path.dirname(target);
		const parentId = identity(await fs.stat(parent, { bigint: true }));
		const before = await observe(target);
		const updated = Buffer.from(applyEdits(before.data.toString("utf8"), request.edits), "utf8");
		if (updated.length > MAX) throw new Error("edit result exceeds 16 MiB");
		check();
		temp = await fs.mkdtemp(path.join(parent, ".boxery-edit-"));
		const staged = path.join(temp, "file");
		const file = await fs.open(staged, "wx", 0o600);
		try {
			await file.writeFile(updated);
			const s = before.stat, current = await file.stat({ bigint: true });
			if (s.uid !== current.uid || s.gid !== current.gid) await file.chown(Number(s.uid), Number(s.gid));
			await file.chmod(Number(s.mode & 0o7777n));
			const final = await file.stat({ bigint: true });
			if (final.uid !== s.uid || final.gid !== s.gid || final.mode !== s.mode) throw new Error("cannot preserve ownership/mode");
			await file.sync();
		} finally { await file.close(); }
		const now = await observe(target);
		if (version(now.stat) !== version(before.stat) || !now.data.equals(before.data)) conflict();
		if (await fs.realpath(request.path) !== target || identity(await fs.stat(parent, { bigint: true })) !== parentId) conflict();
		check();
		await fs.rename(staged, target);
		return { committed: true };
	} finally {
		if (temp) await fs.rm(temp, { recursive: true, force: true });
	}
}

/** @param {ApplyEdits} applyEdits */
export async function main(applyEdits) {
	let interrupted = false;
	const stop = () => { interrupted = true; };
	const check = () => { if (interrupted) throw new Error("edit cancelled"); };
	for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, stop);
	try {
		const chunks = [];
		let size = 0;
		for await (const chunk of process.stdin) {
			size += chunk.length;
			if (size > 3 * MAX) throw new Error("edit request too large");
			chunks.push(chunk);
		}
		const result = await atomicEdit(JSON.parse(Buffer.concat(chunks).toString("utf8")), applyEdits, check);
		console.log(JSON.stringify(result));
	} catch (error) {
		console.error(`vm_edit: ${/** @type {Error} */ (error).message}`);
		process.exitCode = 1;
	} finally {
		for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.off(sig, stop);
	}
}
