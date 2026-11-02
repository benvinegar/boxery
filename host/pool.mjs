// Pool membership and edge credential routes. Leases themselves: lease-workflows.mjs.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as leases from "./boxery-leases.mjs";
import { captureVm } from "./images.mjs";
import { restorePetAccess } from "./vms.mjs";
import { fail, jsonArray, log, POOL_SNAP, print, readFd, sleep, table, validName } from "./util.mjs";
/** @import { Runtime } from "./runtime.mjs" */

/** Edge routes per host (stdin of edge-set). @typedef {Record<string, { headers?: Record<string, string> | null | false, readonly?: boolean | null }>} EdgeRoutes */

// Lease states print lowercase (free, leased, …) like VM states; the lease store keeps its own FREE, LEASED, ….
/** @param {Runtime} rt @param {string[]} args */
export function poolLs(rt, [arg]) {
	let rows;
	try { rows = leases.list(rt.db()); } catch { fail("lease store error"); }
	rows = rows.map(({ name, state, holder, acquired_at, expires_at, expires_in }) => ({ name, state: state.toLowerCase(), holder, acquired_at, expires_at, expires_in }));
	if (arg === "--json") return print(jsonArray(rows));
	print(table([16, 10, 10], [["NAME", "LEASE", "EXPIRES", "HOLDER"],
		...rows.map((r) => [r.name, r.state, r.expires_in == null ? "-" : `${r.expires_in}s`, r.holder ?? "-"])]));
}

// authorized_keys in a pool VM := the host key (+ the lease holder's). This is the fence: a VM in the
// pool accepts nobody else, and resetting it (reimage from its clean image) drops the lease key again.
/** @param {Runtime} rt @param {string} name @param {string} [pubkey] */
export async function setLeaseKeys(rt, name, pubkey) {
	await rt.guest.setKeys(await rt.vms.sshEndpoint(name), [rt.guest.hostPubkey(), ...(pubkey ? [pubkey] : [])]);
}

/** @param {Runtime} rt @param {string[]} args */
export async function poolAdd(rt, [name]) {
	validName(name);
	if (!await rt.vms.exists(name)) fail(`no such vm: ${name}`);
	if (rt.poolRow(name)) fail(`${name} is already in the pool`);
	const ep = await rt.vms.sshEndpoint(name); // must be running
	const action = rt.intent("pool-add", name);
	// The clean snapshot must not carry a previous user's pushed grants (tmpfs) or keys.
	await rt.guest.run(ep, 'rm -rf "/run/user/$(id -u)/boxery"');
	try { await setLeaseKeys(rt, name); } catch { fail(`could not lock down ssh keys on ${name}`); }
	// authorized_keys only gates *new* logins: end existing ssh sessions (not the desktop) so nobody
	// keeps access through a connection opened before the VM joined the pool.
	await rt.guest.run(ep, 'sudo pkill -u agent -x sshd 2>/dev/null; sudo pkill -f "^sshd: agent" 2>/dev/null; true');
	await sleep(1000);
	await rt.guest.run(ep, "sync");
	if (await rt.vms.imageExists(`${name}@${POOL_SNAP}`)) await rt.vms.call("backend_image_rm", [`${name}@${POOL_SNAP}`]);
	await captureVm(rt, name, `${name}@${POOL_SNAP}`);
	leases.add(rt.db(), name);
	rt.deleteToken(name); // a pool VM's proxy token is issued per lease
	rt.done(action);
	log(`${name} added to the pool (only lease holders can reach it now)`);
}

/** @param {Runtime} rt @param {string[]} args */
export async function poolRm(rt, [name, force]) {
	validName(name);
	const row = rt.poolRow(name);
	if (!row) fail(`${name} is not a pool VM`);
	if (force !== "--force" && !["FREE", "BROKEN"].includes(row.state)) fail(`${name} is active; release it first (or --force)`);
	const action = rt.intent("pool-rm", name);
	leases.remove(rt.db(), name, force === "--force");
	rt.clearEdge(name); // a --force removal's grants were the lease's
	await restorePetAccess(rt, name);
	await rt.vms.call("backend_cleanup_image", [`${name}@${POOL_SNAP}`]);
	rt.done(action);
	log(`${name} removed from the pool`);
}

// ---------------------------------------------------------------- edge grants
// Per-VM HTTP credential routes for the proxy's /edge/ path (values never enter the VM).
// stdin: {"hosts": {"HOST": {"headers": {"Name": "value"}, "readonly": bool}, …}, "llm": ["chatgpt", …]}
// ({} clears). A bare {"HOST": …} map (older controllers) is read as {"hosts": …}. `llm` lists the
// LLM proxy routes this VM may use; without it the VM gets no LLM access.
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;
const RESERVED = new Set(["host", "content-length", "connection", "transfer-encoding", "te", "upgrade", "proxy-connection", "keep-alive", "trailer"]);
/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
export const LLM_PROVIDERS = ["chatgpt", "openai", "anthropic", "ollama"];

/** stdin → {hosts, llm}, or null if malformed. "hosts"/"llm" can't be route hosts (no dot), so the forms don't clash. */
export function parseEdge(j) {
	if (!isObject(j)) return null;
	const keys = Object.keys(j);
	const wrapped = keys.length > 0 && keys.every((k) => k === "hosts" || k === "llm");
	const hosts = wrapped ? j.hosts ?? {} : j, llm = wrapped ? j.llm ?? [] : [];
	if (!validRoutes(hosts) || !Array.isArray(llm) || !llm.every((p) => LLM_PROVIDERS.includes(p))) return null;
	return { hosts, llm: [...new Set(llm)].sort() };
}

/** Same host/header rules as the proxy: nothing that could smuggle a header or reach an IP/port.
 *  @param {unknown} routes @returns {routes is EdgeRoutes} */
export function validRoutes(routes) {
	return isObject(routes) && Object.entries(routes).every(([host, r]) => DNS_NAME.test(host) && isObject(r)
		&& [undefined, null, false, true].includes(r.readonly)
		&& (r.headers == null || r.headers === false || (isObject(r.headers) && Object.entries(r.headers).every(([k, v]) =>
			/^[A-Za-z0-9-]{1,64}$/.test(k) && !RESERVED.has(k.toLowerCase()) && typeof v === "string" && !/[\r\n\0]/.test(v) && v.length <= 8192))));
}

/** edge-set NAME [--lease ID]. A pool VM's routes belong to its current lease: they are stamped with
 * its id, and the proxy honours them only with that lease's token. --lease (the controller's lease
 * record) refuses a stale caller instead of touching the next holder's routes. @param {Runtime} rt @param {string[]} args */
export async function edgeSet(rt, [name, ...args]) {
	validName(name);
	if (args.length && (args.length !== 2 || args[0] !== "--lease" || !/^l-[0-9a-f]{32}$/.test(args[1]))) fail("usage: edge-set NAME [--lease ID] < routes.json");
	const want = args[1];
	if (!await rt.vms.exists(name)) fail(`no such VM: ${name}`);
	let edge;
	try { edge = parseEdge(JSON.parse(readFd(0, { limit: 262144 }))); } catch { edge = null; }
	if (!edge) fail(`edge-set: invalid routes (hosts must be DNS names; header names [A-Za-z0-9-]; no CR/LF; llm: ${LLM_PROVIDERS.join("|")})`);
	const { hosts: routes, llm } = edge;
	const row = rt.poolRow(name);
	if (want && row?.lease_id !== want) fail(`edge-set: ${want} is not ${name}'s current lease`);
	// The lease the proxy will see on this VM's token (none for a lease that began before tokens were per lease).
	const lease = row?.state === "LEASED" && /** @type {{ lease?: string } | undefined} */ (rt.token(name))?.lease === row.lease_id ? row.lease_id : undefined;
	const dir = path.join(rt.conf, "edge");
	mkdirSync(dir, { recursive: true });
	chmodSync(dir, 0o700);
	if (!Object.keys(routes).length && !llm.length) { rt.clearEdge(name); log(`${name}: edge routes cleared`); return; }
	if (row && row.state !== "LEASED") fail(`edge-set: ${name} is a pool VM without an active lease`);
	const tmp = path.join(dir, `.${name}.${randomBytes(4).toString("hex")}`);
	writeFileSync(tmp, JSON.stringify({ hosts: routes, llm, ...(lease ? { lease } : {}) }), { mode: 0o600, flag: "wx" });
	renameSync(tmp, path.join(dir, `${name}.json`)); // atomic: the proxy never reads a partial file
	log(`${name}: edge routes → ${[...Object.keys(routes).sort(), ...llm.map((p) => `llm:${p}`)].join(", ") || "-"}`);
}
