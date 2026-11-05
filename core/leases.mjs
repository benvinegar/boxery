// Pool leases on the controller side, shared by the CLI (controller/leases.mjs), the MCP server and the
// pi extension (LeaseKeeper). The host owns the lease state (host/boxery-leases.mjs); this machine keeps
// one record per lease it holds, in the selected profile's leases/ directory:
//   ID.lease               name= id= expires= ttl= holder=   (key=value lines)
//   ID.key, ID.key.pub     the lease's own throwaway ssh key; the host installs the public half in the VM
// ssh_config uses ID.key for NAME.boxery while the lease lasts (core/profile.mjs writeSshConfig).
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { currentHost, VALID_NAME } from "./boxery-core.mjs";
import { applyGrants, listGrants } from "./grant-operations.mjs";
import { closeMaster, hostLeaseJson, hostRun, writeSshConfig } from "./profile.mjs";

/** A lease this machine holds. expires: unix seconds. @typedef {{ name: string, id: string, expires: number, ttl: number | null, holder: string | null, file: string }} LeaseRecord */
/** log: progress and warnings for a person (the CLI prints them to stderr). interactiveCommands: grant
 *  --cmd helpers may prompt (CLI only). timeout: ms for each host command, 0 for none (default: per
 *  command). signal: abort (Ctrl-C) stops the host call (on a remote host: its ssh) and removes the
 *  half-made key. stderr: see hostRun.
 *  @typedef {{ log?: (line: string) => void, interactiveCommands?: boolean, timeout?: number, signal?: AbortSignal, stderr?: "pipe" | "inherit" }} LeaseOpts */

export const VALID_LEASE = /^l-[0-9a-f]{32}$/;
const PUSHED = new Set(["env", "file", "http", "llm"]);

const leasesDir = () => path.join(currentHost().dir, "leases");
const recordFile = (/** @type {string} */ id) => path.join(leasesDir(), `${id}.lease`);
const keyFile = (/** @type {string} */ id) => path.join(leasesDir(), `${id}.key`);

/** @param {string} what @param {unknown} v */
function seconds(what, v) {
	const s = String(v ?? "");
	if (!/^[0-9]+$/.test(s)) throw new Error(`${what} must be a number`);
	return Number(s);
}

/** @param {string} file @returns {LeaseRecord | null} */
function readRecord(file) {
	let text;
	try { text = readFileSync(file, "utf8"); } catch { return null; }
	/** @type {Record<string, string>} */
	const kv = {};
	for (const line of text.split("\n")) { const i = line.indexOf("="); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1); }
	if (!VALID_NAME.test(kv.name ?? "") || !VALID_LEASE.test(kv.id ?? "")) return null;
	const num = (/** @type {string | undefined} */ s) => (/^-?[0-9]+$/.test(s ?? "") ? Number(s) : null);
	return { name: kv.name, id: kv.id, expires: num(kv.expires) ?? 0, ttl: num(kv.ttl), holder: kv.holder || null, file };
}

/** @param {LeaseRecord} r */
function writeRecord(r) {
	const tmp = `${r.file}.tmp.${process.pid}`;
	writeFileSync(tmp, `name=${r.name}\nid=${r.id}\nexpires=${r.expires}\nttl=${r.ttl ?? ""}\nholder=${r.holder ?? ""}\n`, { mode: 0o600 });
	renameSync(tmp, r.file);
}

/** Leases this machine holds on the current host, by lease id. @returns {LeaseRecord[]} */
export function localLeases() {
	const dir = leasesDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".lease")).sort().map((f) => readRecord(path.join(dir, f))).filter((r) => r !== null);
}

/** The local lease for a VM name or lease id, or null. @param {string} ref */
export function findLease(ref) {
	if (VALID_LEASE.test(ref)) return readRecord(recordFile(ref));
	return localLeases().find((r) => r.name === ref) ?? null;
}

/** @param {string} ref */
function needLease(ref) {
	const r = typeof ref === "string" && ref ? findLease(ref) : null;
	if (!r) throw new Error(`no local lease for '${ref ?? ""}' (boxery leases)`);
	return r;
}

/** Pushed (tmpfs) grants are gone after a reset: push them again. Never fails the lease operation. @param {string} vm @param {LeaseOpts} opts */
async function reapplyGrants(vm, opts) {
	try {
		if (!listGrants(vm).some((g) => PUSHED.has(g.kind))) return;
		const out = await applyGrants(vm, { interactiveCommands: !!opts.interactiveCommands });
		for (const line of out.split("\n")) if (line.startsWith("boxery:")) opts.log?.(line);
	} catch (e) {
		opts.log?.(`boxery: could not apply grants to ${vm}: ${/** @type {Error} */ (e).message}`);
	}
}

/** @param {string} file @param {string} comment */
function keygen(file, comment) {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file], { stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) => reject(new Error(`ssh-keygen failed: ${e.message}`)));
		child.on("close", (code) => (code === 0 ? resolve(undefined) : reject(new Error(`ssh-keygen failed${err.trim() ? `: ${err.trim()}` : ""}`))));
	});
}

/**
 * The host's answer to acquire or renew: {name, lease_id, expires_at} with --json; from a host that
 * predates it, the line "NAME LEASE_ID EXPIRES" (acquire) or "NAME EXPIRES" (renew). null if it is neither.
 * @param {string} out @param {boolean} json @returns {{ name: string, lease_id: string | null, expires_at: number } | null}
 */
export function leaseReply(out, json) {
	if (json) {
		let r;
		try { r = JSON.parse(out); } catch { return null; }
		return VALID_NAME.test(r?.name ?? "") && VALID_LEASE.test(r?.lease_id ?? "") && Number.isSafeInteger(r?.expires_at) ? { name: r.name, lease_id: r.lease_id, expires_at: r.expires_at } : null;
	}
	const line = out.split("\n").at(-1) ?? "";
	const a = /^([a-z][a-z0-9-]{0,30}) (l-[0-9a-f]{32}) ([0-9]+)$/.exec(line);
	if (a) return { name: a[1], lease_id: a[2], expires_at: Number(a[3]) };
	const r = /^(\S+) ([0-9]+)$/.exec(line);
	return r ? { name: r[1], lease_id: null, expires_at: Number(r[2]) } : null;
}

export const defaultHolder = () => `${process.env.USER || "user"}@${hostname().split(".")[0]}`;

/**
 * Lease a free pool VM: a fresh ssh key, the host's `acquire`, then the local record and ssh_config.
 * Its pushed grants (if this machine had some for that VM name) are applied again.
 * @param {{ ttl?: number | string, wait?: number | string, holder?: string }} [req] @param {LeaseOpts} [opts]
 * @returns {Promise<LeaseRecord>}
 */
export async function acquireLease({ ttl = 1800, wait = 0, holder = defaultHolder() } = {}, opts = {}) {
	const t = seconds("--ttl", ttl), w = seconds("--wait", wait);
	if (typeof holder !== "string" || !holder || /[\0-\x1f\x7f]/.test(holder)) throw new Error("invalid --holder");
	const dir = leasesDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
	const tmp = path.join(dir, `.new-${process.pid}-${Date.now()}`);
	const cleanup = () => { rmSync(tmp, { force: true }); rmSync(`${tmp}.pub`, { force: true }); };
	let out, json = false;
	try {
		await keygen(tmp, `boxery-lease ${holder}`);
		json = await hostLeaseJson();
		out = await hostRun(["acquire", "--holder", holder, "--ttl", String(t), "--wait", String(w), ...(json ? ["--json"] : [])], {
			input: readFileSync(`${tmp}.pub`, "utf8"), timeout: opts.timeout ?? (w + 300) * 1000, signal: opts.signal, stderr: opts.stderr,
		});
	} catch (e) { cleanup(); throw e; }
	const reply = leaseReply(out, json);
	if (!reply?.lease_id) {
		cleanup();
		const leaked = out.match(/l-[0-9a-f]{32}/)?.[0]; // never leave a lease we can't use on the host
		if (leaked) await hostRun(["release", leaked], { timeout: 180_000 }).catch(() => {});
		throw new Error(`bad response from host: ${out.slice(0, 300)}`);
	}
	const { name, lease_id: id, expires_at: exp } = reply;
	/** @type {LeaseRecord} */
	const rec = { name, id, expires: Number(exp), ttl: t, holder, file: recordFile(id) };
	// The host holds the lease now. Without the local record, key and ssh_config entry it is unusable,
	// and nothing here would renew or release it: give it back rather than strand it until its TTL.
	try {
		renameSync(tmp, keyFile(id)); renameSync(`${tmp}.pub`, `${keyFile(id)}.pub`);
		writeRecord(rec);
		await closeMaster(name);
		await writeSshConfig();
	} catch (e) {
		const why = /** @type {Error} */ (e).message;
		const released = await hostRun(["release", id], { timeout: 180_000 }).then(() => true, () => false);
		cleanup();
		for (const f of [rec.file, keyFile(id), `${keyFile(id)}.pub`]) rmSync(f, { force: true });
		await writeSshConfig().catch(() => {});
		throw new Error(`leased ${name} but could not set it up on this machine (${why}); ${released ? "released it again" : `could not release it either: it expires on the host in ${t}s`}`);
	}
	await reapplyGrants(name, opts);
	return rec;
}

/** Extend a lease (NAME or lease id); ttl defaults to the one it was acquired with. @param {string} ref @param {number | string | null} [ttl] @param {LeaseOpts} [opts] */
export async function renewLease(ref, ttl, opts = {}) {
	const rec = needLease(ref);
	const t = seconds("--ttl", ttl ?? rec.ttl ?? "");
	const json = await hostLeaseJson();
	const out = await hostRun(["renew", rec.id, "--ttl", String(t), ...(json ? ["--json"] : [])], { timeout: opts.timeout ?? 60_000, signal: opts.signal, stderr: opts.stderr });
	const reply = leaseReply(out, json);
	if (!reply) throw new Error(`bad response from host: ${out.slice(0, 300)}`);
	// A release that ran while the host answered (another process, or the session ending) removed the
	// record: don't bring it back, pointing at a deleted key.
	if (readRecord(rec.file)?.id !== rec.id) throw new Error(`lease ${rec.id} was released meanwhile`);
	writeRecord({ ...rec, expires: reply.expires_at });
	return { ...rec, expires: reply.expires_at, ttl: t };
}

/**
 * Give a lease back (NAME or lease id): the host resets the VM. The local record, key, grants and edge
 * marker go even if the host no longer knows the lease (already expired or reaped).
 * @param {string} ref @param {LeaseOpts} [opts] @returns {Promise<LeaseRecord>}
 */
export async function releaseLease(ref, opts = {}) {
	const rec = needLease(ref);
	await closeMaster(rec.name);
	try { await hostRun(["release", rec.id], { timeout: opts.timeout ?? 180_000, stderr: opts.stderr }); }
	catch { opts.log?.(`boxery: host did not release ${rec.id} (already expired?); forgetting it locally`); }
	for (const f of [rec.file, keyFile(rec.id), `${keyFile(rec.id)}.pub`]) rmSync(f, { force: true });
	// The grants were for this lease; the host's reset clears its edge routes.
	const grants = path.join(currentHost().dir, "grants");
	rmSync(path.join(grants, rec.name), { force: true });
	rmSync(path.join(grants, `.${rec.name}.edge`), { force: true });
	await writeSshConfig();
	return rec;
}

/** `boxery leases --json` rows (docs/cli.md). @param {number} [now] unix seconds */
export function leaseRows(now = Math.floor(Date.now() / 1000)) {
	return localLeases().map((r) => ({ name: r.name, lease_id: r.id, expires_at: r.expires, expires_in: Math.max(0, r.expires - now), ttl: r.ttl, holder: r.holder }));
}
