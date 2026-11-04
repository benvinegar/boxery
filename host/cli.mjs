// boxery-host commands (loaded by host/boxery-host.mjs). Output formats are a contract: docs/cli.md, and
// test/shell/host-output.sh pins them. Errors: "boxery-host: …" on stderr, non-zero exit, nothing on stdout.
//
// Mutating commands run supervised (boxery-operations.mjs): this process takes the VMs' lifecycle locks,
// then starts `boxery-host.mjs __worker __dispatch COMMAND …` in its own process group to do the work.
// Private entry points (not a public CLI): __worker, __dispatch, __call CALLBACK …, __recover.
import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import path from "node:path";
import * as leases from "./boxery-leases.mjs";
import { runLifecycle } from "./boxery-lifecycle.mjs";
import { resources, supervise } from "./boxery-operations.mjs";
import { ageDays, buildRecord, guestChecker, refreshBuild } from "./build-info.mjs";
import { knownHosts, pin } from "./hostkeys.mjs";
import { revert, snap, snapRm, snapsLines } from "./images.mjs";
import { edgeSet, poolAdd, poolLs, poolRm } from "./pool.mjs";
import { parsePatchArgs, patchAll, patchVm, waitForLease } from "./patch.mjs";
import { reconcileVm, replayIntents } from "./recovery.mjs";
import { runners } from "./runners.mjs";
import { createRuntime } from "./runtime.mjs";
import { backends, capabilities, checkOperation } from "./capabilities.mjs";
import { addKey, buildBase, init, profiles } from "./setup.mjs";
import { vmKinds } from "./kinds.mjs";
import { addVmShape, vmShapes } from "./shapes.mjs";
import { fail, jsonArray, log, print, readFd, table, validName } from "./util.mjs";
import { fork, newVm, resize, rm, start, stop } from "./vms.mjs";
/** @import { LeaseListEntry } from "./boxery-leases.mjs" */
/** @import { Runtime } from "./runtime.mjs" */
/** @import { ShapeRecord } from "./shapes.mjs" */

/** A boxery-host command: the runtime and the arguments after the command name. @typedef {(rt: Runtime, args: string[]) => unknown} Command */

const usage = (/** @type {{ backend: string, conf: string }} */ { backend, conf }) => `boxery-host — Ubuntu desktop VMs for coding agents (backend: ${backend})

  init [--backend libvirt|lima|cloud-hypervisor|exe|boat|openshell]  install proxy services + backend setup, symlinks
  --profile NAME COMMAND…   use a second profile on this host (~/.config/boxery-NAME): its own backend,
                            state, proxy port and services. Create it with: --profile NAME init --backend B
  backends [--json]         backend support, requirements and capability declarations
  capabilities [--json | --check]  this host's platform, validation and conditional capabilities
  profiles [--json]         the profiles on this host (backend, proxy port, service name, state directory)
  version [--json]          this install's version, commit and kind (git or npm)
  upgrade [--check] [--ref REF] [--wait S] [--reinit]
                            update this install (git pull --ff-only, or npm), re-run init for every
                            profile using it and check them; waits for in-flight operations, rolls back on failure
  build-base                build the golden desktop image (one-time; headless VMs don't need it)
  add-key < key.pub         authorize a controller's ssh key for new VMs
  new NAME [--shape S] [--cpus N --mem MiB --disk GiB] [--headless [--layers github-runner]]
                            --headless: no desktop; boots the stock image, no build-base needed
                            --layers: optional image layers too (github-runner: a GitHub Actions runner VM)
  new NAME --from IMAGE     boot a new VM from an image (e.g. demo@s1; keeps its desktop or not)
  fork SRC DST... [--shape S] [--cpus N --mem MiB --disk GiB]
                            copy a VM (running or not) into new VMs with their own identity
                            (same size as SRC unless --shape or size flags are given)
  shapes [--json]           VM sizes (built-ins + ${conf}/shapes.json; * = default)
  ls [--json] [--refresh]   VMs; --refresh first reads each running VM's guest build record (GUEST column)
  ip NAME | start NAME | stop NAME | rm NAME
  patch NAME|--all [--wait S]
                            update a VM's guest software to this host's image layers (restarts it if the
                            updates ask to; a pool VM must be free, and its clean image is captured again)
  resize NAME [--cpus N] [--mem MiB] [--disk GiB]
                            change a VM's size; a running VM is restarted. Disk only grows
  snap NAME [SNAP] | snaps NAME [--json] | snap-rm NAME SNAP | revert NAME SNAP | images [--json]
  connect NAME [PORT]       stdio to VM port (for ssh ProxyCommand)
  known-hosts NAME          NAME's pinned ssh host key as a known_hosts line (ssh KnownHostsCommand)
  pin NAME [--from-guest]   re-pin running NAME's ssh host key (hypervisor/loopback channel; --from-guest:
                            trust what NAME's ssh endpoint answers once)
  proxy-log [N]             recent LLM + edge proxy requests
  edge-set NAME [--lease ID] < routes.json   set the VM's edge credential routes (used by boxery grant http:…)

  pool add NAME | rm NAME [--force] | ls [--json]   shared pool of leasable VMs
  acquire --holder H [--ttl S] [--wait S] [--only NAME,…]   lease a free pool VM (lease ssh pubkey on stdin)
  renew LEASE [--ttl S] | release LEASE | reap | reconcile

  runners status [--json] | start | stop | token < FILE | config [--repo O/R | --org ORG] [--vms NAME,…] …
                            GitHub Actions runners, one job per freshly reset pool VM (docs/github-runners.md)
`;
const POOL_USAGE = "usage: pool add NAME | rm NAME [--force] | ls [--json]";

// ---------------------------------------------------------------- listings
const GIB = 1024 ** 3;
const gib = (/** @type {number | null} */ bytes) => (bytes == null ? null : Math.round((bytes / GIB) * 100) / 100);
/** A size record for a VM that has none (made before shapes, or outside boxery): ask the backend, and
 *  keep the answer as a custom size so later listings don't. null if the backend can't tell.
 *  @param {Runtime} rt @param {string} name */
async function backfillSize(rt, name) {
	try {
		if (!await rt.vms.has("backend_size")) return null;
		const [cpus, mem, disk] = await rt.vms.size(name, { quiet: true });
		const rec = { shape: null, cpus, mem, disk };
		try { addVmShape(rt.conf, name, rec); } catch { /* unwritable config: still list the size */ }
		return rec;
	} catch { return null; } // one VM's size must not break the listing
}
/** The `ls --json` objects (docs/cli.md). Lease states are lowercase here, like VM states; the lease
 *  store's own states (FREE, LEASED, …) stay internal. refresh: read running VMs' build records first.
 *  @param {Runtime} rt */
async function lsJson(rt, refresh = false) {
	/** @type {LeaseListEntry[]} */
	let pool = [];
	try { pool = leases.list(rt.db()); } catch { /* listing VMs must not depend on the lease store */ }
	const lease = Object.fromEntries(pool.map((r) => [r.name, { state: r.state.toLowerCase(), holder: r.holder, expires_at: r.expires_at }]));
	const sizes = /** @type {Record<string, ShapeRecord | null>} */ (vmShapes(rt.conf)), kinds = vmKinds(rt.conf);
	const vms = await rt.vms.list();
	await Promise.all(vms.filter((vm) => !sizes[vm.name]).map(async (vm) => { sizes[vm.name] = await backfillSize(rt, vm.name); }));
	if (refresh) {
		await Promise.all(vms.filter((vm) => ["running", "idle"].includes(vm.state)).map(async (vm) => {
			try { await refreshBuild(rt, vm.name, await rt.vms.sshEndpoint(vm.name, { quiet: true })); } catch { /* unreachable: keep what's known */ }
		}));
	}
	const guest = guestChecker(rt);
	const nz = (/** @type {string} */ v) => (v === "" ? null : v);
	return vms.map((vm) => {
		const sz = sizes[vm.name];
		return { name: vm.name, state: nz(vm.state), ssh_addr: nz(vm.ssh), disk_size: gib(vm.diskBytes) ?? sz?.disk ?? null, disk_used: gib(vm.diskUsedBytes),
			tunnel: nz(vm.tunnel), lease: lease[vm.name] ?? null, shape: sz ? (sz.shape ?? "custom") : null, cpus: sz?.cpus ?? null, mem: sz?.mem ?? null,
			desktop: kinds[vm.name] !== "headless", guest: guest(buildRecord(rt.conf, vm.name)) };
	});
}
/** @typedef {Awaited<ReturnType<typeof lsJson>>[number]} LsEntry */
// A running VM whose tunnel isn't up (exe.dev) shows why instead of an address.
const fmtSsh = (/** @type {LsEntry} */ v) => (v.state === "running" && v.tunnel != null && v.tunnel !== "up" ? `tunnel ${v.tunnel}` : (v.ssh_addr ?? "-"));
// USED/SIZE in GiB ("0.5/40GiB"), or only the size when the backend can't tell what's used.
const fmtDisk = (/** @type {LsEntry} */ v) => (v.disk_size == null && v.disk_used == null ? "-"
	: `${v.disk_used == null ? "" : `${v.disk_used.toFixed(1)}/`}${v.disk_size ?? "?"}GiB`);
/** @param {Runtime} rt @param {string[]} args */
async function ls(rt, args) {
	if (args.some((a) => !["--json", "--refresh"].includes(a))) fail("usage: ls [--json] [--refresh]");
	const refresh = args.includes("--refresh");
	const vms = await lsJson(rt, refresh);
	if (args.includes("--json")) return print(jsonArray(vms));
	print(table([16, 10, 18, 12, 10, 9, 10], [["NAME", "STATE", "SSH", "DISK", "SHAPE", "KIND", "LEASE", "GUEST"],
		...vms.map((v) => [v.name, v.state ?? "-", fmtSsh(v), fmtDisk(v), v.shape ?? "-", v.desktop ? "desktop" : "headless", v.lease?.state ?? "-", v.guest.status])]));
	const outdated = vms.filter((v) => v.guest.status === "outdated");
	if (outdated.length) log(`outdated guest software: ${outdated.map((v) => `${v.name} (${v.guest.reasons.join(", ")})`).join("; ")}. Update with: boxery patch NAME|--all`);
	const unchecked = vms.filter((v) => v.guest.checked_at == null && ["running", "idle"].includes(v.state ?? ""));
	if (unchecked.length && !refresh) log(`guest software not checked yet: ${unchecked.map((v) => v.name).join(", ")} (ls --refresh reads it)`);
}

/** @param {Runtime} rt @param {string[]} args */
function shapes(rt, [arg]) {
	const s = rt.shapes();
	if (arg === "--json") return print(JSON.stringify(s));
	if (arg) fail("usage: shapes [--json]");
	print(table([16, -5, -9, -9], [["SHAPE", "CPUS", "MEM_MIB", "DISK_GIB"],
		...Object.entries(s.shapes).map(([n, v]) => [n + (n === s.default ? " *" : ""), v.cpus, v.mem, v.disk])]));
}

// An image's age (days since it was captured), and the guest software it holds (its VM's at capture).
const fmtAge = (/** @type {number | null} */ d) => (d == null ? "-" : `${d}d`);
/** @param {Runtime} rt */
const imageGuest = (rt) => {
	const guest = guestChecker(rt);
	return (/** @type {string} */ image) => guest(buildRecord(rt.conf, image), { image: true });
};

/** @param {Runtime} rt @param {string[]} args */
async function snaps(rt, [name, arg]) {
	validName(name);
	if (arg && arg !== "--json") fail("usage: snaps NAME [--json]");
	const guest = imageGuest(rt);
	const rows = (await snapsLines(rt, name)).map(([n, created, size]) => ({ name: n, created, size: size === "-" ? null : size, age_days: ageDays(created), guest: guest(`${name}@${n}`) }));
	if (arg === "--json") return print(jsonArray(rows));
	for (const r of rows) print([r.name, r.created, r.size ?? "-", fmtAge(r.age_days), r.guest.status].join("\t"));
}

/** @param {Runtime} rt @param {string[]} args */
async function images(rt, [arg]) {
	if (arg && arg !== "--json") fail("usage: images [--json]");
	const guest = imageGuest(rt);
	const imgs = (await rt.vms.images()).map((i) => ({ image: i.image, created: i.created || null, size: i.size && i.size !== "-" ? i.size : null,
		age_days: ageDays(i.created), guest: guest(i.image) }));
	if (arg === "--json") return print(jsonArray(imgs));
	print(table([40, 20, 10, 5], [["IMAGE", "CREATED", "SIZE", "AGE", "GUEST"], ...imgs.map((i) => [i.image, i.created ?? "", i.size ?? "-", fmtAge(i.age_days), i.guest.status])]));
}

/** @param {Runtime} rt @param {string[]} args */
async function ip(rt, [name]) {
	print((await rt.vms.sshEndpoint(validName(name))).host);
}

/** @param {Runtime} rt @param {string[]} args @returns {Promise<void>} */
function proxyLog(rt, [n = "30"]) {
	const [cmd, args] = /** @type {[string, string[]]} */ (process.platform === "darwin"
		? ["tail", ["-n", n, path.join(/** @type {string} */ (process.env.HOME), "Library/Logs", `${rt.proxyUnit}.log`)]]
		: ["journalctl", ["--user", "-u", rt.proxyUnit, "-n", n, "--no-pager", "-o", "cat"]]);
	return new Promise((resolve, reject) => {
		spawn(cmd, args, { stdio: "inherit" }).on("error", reject).on("close", (code) => {
			if (code === 0) resolve(); else reject(Object.assign(new Error(`${cmd} failed`), { exitCode: code ?? 1, reported: true }));
		});
	});
}

// ---------------------------------------------------------------- dispatch
/** @param {string} command @returns {Command} */
const lifecycle = (command) => (rt, args) => runLifecycle(rt, command, args);
/** @type {Record<string, Command>} */
const COMMANDS = {
	init: (rt) => init(rt), "build-base": buildBase, "add-key": addKey, profiles,
	ls, list: ls, shapes, snaps, images, ip, "known-hosts": knownHosts, backends, capabilities,
	pool: (rt, [sub = "ls", ...args]) => (sub === "ls" ? poolLs(rt, args) : fail(POOL_USAGE)),
	patch: patchAll, // patch NAME runs supervised (MUTATING); --all supervises one VM at a time
	"proxy-log": proxyLog,
	backend: (rt) => print(rt.backend),
	acquire: lifecycle("acquire"), renew: lifecycle("renew"), release: lifecycle("release"),
	reap: lifecycle("reap"), reconcile: lifecycle("reconcile"),
	// Not supervised: the manager is a lease holder like any other; its leases go through acquire/release.
	runners,
};
// Run in a supervised worker holding the VMs named by boxery-operations.mjs resources().
/** @type {Record<string, Command>} */
const MUTATING = {
	new: newVm, fork, start, stop, resize, rm, delete: rm, snap, "snap-rm": snapRm, revert, "edge-set": edgeSet, pin, patch: patchVm,
	pool: (rt, [sub, ...args]) => (sub === "add" ? poolAdd(rt, args) : sub === "rm" ? poolRm(rt, args) : fail(POOL_USAGE)),
};
// Held-lock callbacks: the lease runtime and drift repair run these under a VM's lock (`__call`).
/** @type {Record<string, Command>} */
const CALLBACKS = {
	_lease_acquire: lifecycle("install-held"),
	_lease_release: lifecycle("release-held"),
	_lease_reset: lifecycle("reset-held"),
	_reap_candidate: lifecycle("reap-held"),
	lease_reset: lifecycle("reset"), // takes the lock itself
	_reconcile_vm: (rt, [name]) => reconcileVm(rt, name),
};
const supervised = (/** @type {string} */ command, /** @type {string[]} */ args) => Object.hasOwn(MUTATING, command) && (command !== "pool" || ["add", "rm"].includes(args[0]))
	&& (command !== "patch" || !args.includes("--all"));

// A worker does nothing until its supervisor has committed the worker's identity (fd 3 gets a line).
// A supervisor that dies first closes the pipe without authorizing side effects.
function awaitGate() {
	let line = "";
	try { line = readFd(3, { untilNewline: true }); } catch { /* no gate: not authorized */ }
	try { closeSync(3); } catch { /* already closed */ }
	if (!line.includes("\n")) fail("worker was not authorized to start");
}

/** @param {string[]} argv */
async function main(argv) {
	let [command = "help", ...args] = argv;
	if (command === "__worker") { awaitGate(); [command = "", ...args] = args; }
	if (command === "init" && args[0] === "--backend") process.env.BOXERY_BACKEND = args[1] ?? "";
	const rt = createRuntime();
	try {
		if (["help", "-h", "--help"].includes(command)) return print(usage(rt));
		if (command === "__dispatch") {
			const [cmd, ...rest] = args;
			if (!Object.hasOwn(MUTATING, cmd)) fail(`not a lifecycle command: ${cmd}`);
			return await MUTATING[cmd](rt, rest);
		}
		if (command === "__call") {
			const [callback, ...rest] = args;
			if (!Object.hasOwn(CALLBACKS, callback)) fail(`unknown callback: ${callback}`);
			return await CALLBACKS[callback](rt, rest);
		}
		if (command === "__recover") return await replayIntents(rt);
		checkOperation(rt.backend, command, args);
		if (supervised(command, args)) {
			if (command === "patch") { const { name, wait } = parsePatchArgs(args); if (wait) await waitForLease(rt, name, wait); }
			const names = resources(command, args);
			process.exitCode = await supervise({ conf: rt.conf, names, command, args: ["__dispatch", command, ...args], env: rt.operationEnv() });
			return;
		}
		if (!Object.hasOwn(COMMANDS, command)) { print(usage(rt)); process.exitCode = 1; return; }
		await COMMANDS[command](rt, args);
	} finally { rt.close(); }
}

main(process.argv.slice(2)).catch((e) => {
	if (!e.reported) process.stderr.write(`boxery-host: ${e.message}\n`);
	process.exitCode = e.exitCode ?? 1;
});
