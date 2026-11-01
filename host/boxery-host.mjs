// boxery-host commands. host/boxery-host (Bash) is the entry point and execs this file with
// --disable-warning=ExperimentalWarning (node:sqlite). Output formats are a contract: docs/cli.md, and
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
import { revert, snap, snapRm, snapsLines } from "./images.mjs";
import { edgeSet, poolAdd, poolLs, poolRm } from "./pool.mjs";
import { reconcileVm, replayIntents } from "./recovery.mjs";
import { createRuntime } from "./runtime.mjs";
import { vmKinds } from "./kinds.mjs";
import { vmShapes } from "./shapes.mjs";
import { fail, jsonArray, print, readFd, table, validName } from "./util.mjs";
import { fork, newVm, resize, rm, start, stop } from "./vms.mjs";

const usage = ({ backend, conf }) => `boxery-host — Ubuntu desktop VMs for coding agents (backend: ${backend})

  init [--backend libvirt|lima|cloud-hypervisor|exe]  install proxy services + backend setup, symlinks
  build-base                build the golden desktop image (one-time; headless VMs don't need it)
  add-key < key.pub         authorize a controller's ssh key for new VMs
  new NAME [--shape S] [--cpus N --mem MiB --disk GiB] [--headless]
                            --headless: no desktop; boots the stock image, no build-base needed
  new NAME --from IMAGE     boot a new VM from an image (e.g. demo@s1; keeps its desktop or not)
  fork SRC DST... [--shape S] [--cpus N --mem MiB --disk GiB]
                            copy a VM (running or not) into new VMs with their own identity
                            (same size as SRC unless --shape or size flags are given)
  shapes [--json]           VM sizes (built-ins + ${conf}/shapes.json; * = default)
  ls [--json] | ip NAME | start NAME | stop NAME | rm NAME
  resize NAME [--cpus N] [--mem MiB] [--disk GiB]
                            change a VM's size; a running VM is restarted. Disk only grows
  snap NAME [SNAP] | snaps NAME [--json] | snap-rm NAME SNAP | revert NAME SNAP | images
  connect NAME [PORT]       stdio to VM port (for ssh ProxyCommand)
  proxy-log [N]             recent LLM + edge proxy requests
  edge-set NAME < routes.json   set the VM's edge credential routes (used by boxery grant http:…)

  pool add NAME | rm NAME [--force] | ls [--json]   shared pool of leasable VMs
  acquire --holder H [--ttl S] [--wait S]    lease a FREE pool VM (lease ssh pubkey on stdin)
  renew LEASE [--ttl S] | release LEASE | reap | reconcile
`;
const POOL_USAGE = "usage: pool add NAME | rm NAME [--force] | ls [--json]";

// ---------------------------------------------------------------- listings
async function lsJson(rt) {
	let pool = [];
	try { pool = leases.list(rt.db()); } catch { /* listing VMs must not depend on the lease store */ }
	const lease = Object.fromEntries(pool.map((r) => [r.name, { state: r.state, holder: r.holder, expires_at: r.expires_at }]));
	const sizes = vmShapes(rt.conf), kinds = vmKinds(rt.conf);
	const nz = (v) => (v === "" ? null : v);
	return (await rt.vms.list()).map((vm) => {
		const sz = sizes[vm.name];
		return { name: vm.name, state: nz(vm.state), addr: nz(vm.addr), disk: nz(vm.disk), lease: lease[vm.name] ?? null,
			shape: sz ? (sz.shape ?? "custom") : null, cpus: sz?.cpus ?? null, mem: sz?.mem ?? null, desktop: kinds[vm.name] !== "headless" };
	});
}
async function ls(rt, [arg]) {
	const vms = await lsJson(rt);
	if (arg === "--json") return print(jsonArray(vms));
	if (arg) fail("usage: ls [--json]");
	print(table([16, 10, 16, 10, 10, 9], [["NAME", "STATE", "ADDR", "DISK", "SHAPE", "KIND", "LEASE"],
		...vms.map((v) => [v.name, v.state ?? "-", v.addr ?? "-", v.disk ?? "-", v.shape ?? "-", v.desktop ? "desktop" : "headless", v.lease?.state ?? "-"])]));
}

function shapes(rt, [arg]) {
	const s = rt.shapes();
	if (arg === "--json") return print(JSON.stringify(s));
	if (arg) fail("usage: shapes [--json]");
	print(table([16, -5, -9, -9], [["SHAPE", "CPUS", "MEM_MIB", "DISK_GIB"],
		...Object.entries(s.shapes).map(([n, v]) => [n + (n === s.default ? " *" : ""), v.cpus, v.mem, v.disk])]));
}

async function snaps(rt, [name, arg]) {
	validName(name);
	if (arg === "--json") {
		return print(jsonArray((await snapsLines(rt, name)).map(([n, created, size]) =>
			({ name: n, created: created === "(legacy)" ? null : created, size: size === "-" ? null : size, legacy: created === "(legacy)" }))));
	}
	if (arg) fail("usage: snaps NAME [--json]");
	for (const l of await snapsLines(rt, name)) print(l.join("\t"));
}

async function images(rt) {
	print(table([40, 20], [["IMAGE", "CREATED", "SIZE"], ...(await rt.vms.images()).map((i) => [i.image, i.created, i.size])]));
}

async function ip(rt, [name]) {
	print((await rt.vms.sshEndpoint(validName(name))).host);
}

function proxyLog(rt, [n = "30"]) {
	const [cmd, args] = process.platform === "darwin"
		? ["tail", ["-n", n, path.join(process.env.HOME, "Library/Logs", `${rt.proxyUnit}.log`)]]
		: ["journalctl", ["--user", "-u", rt.proxyUnit, "-n", n, "--no-pager", "-o", "cat"]];
	return new Promise((resolve, reject) => {
		spawn(cmd, args, { stdio: "inherit" }).on("error", reject).on("close", (code) => {
			if (code === 0) resolve(); else reject(Object.assign(new Error(`${cmd} failed`), { exitCode: code ?? 1, reported: true }));
		});
	});
}

// ---------------------------------------------------------------- dispatch
const lifecycle = (command) => (rt, args) => runLifecycle(rt, command, args);
const COMMANDS = {
	ls, list: ls, shapes, snaps, images, ip,
	pool: (rt, [sub = "ls", ...args]) => (sub === "ls" ? poolLs(rt, args) : fail(POOL_USAGE)),
	"proxy-log": proxyLog,
	backend: (rt) => print(rt.backend),
	acquire: lifecycle("acquire"), renew: lifecycle("renew"), release: lifecycle("release"),
	reap: lifecycle("reap"), reconcile: lifecycle("reconcile"),
};
// Run in a supervised worker holding the VMs named by boxery-operations.mjs resources().
const MUTATING = {
	new: newVm, fork, start, stop, resize, rm, delete: rm, snap, "snap-rm": snapRm, revert, "edge-set": edgeSet,
	pool: (rt, [sub, ...args]) => (sub === "add" ? poolAdd(rt, args) : sub === "rm" ? poolRm(rt, args) : fail(POOL_USAGE)),
};
// Held-lock callbacks: the lease runtime and drift repair run these under a VM's lock (`__call`).
const CALLBACKS = {
	_lease_acquire: lifecycle("install-held"),
	_lease_release: lifecycle("release-held"),
	_lease_reset: lifecycle("reset-held"),
	_reap_candidate: lifecycle("reap-held"),
	lease_reset: lifecycle("reset"), // takes the lock itself
	_reconcile_vm: (rt, [name]) => reconcileVm(rt, name),
};
const supervised = (command, args) => Object.hasOwn(MUTATING, command) && (command !== "pool" || ["add", "rm"].includes(args[0]));

// A worker does nothing until its supervisor has committed the worker's identity (fd 3 gets a line).
// A supervisor that dies first closes the pipe without authorizing side effects.
function awaitGate() {
	let line = "";
	try { line = readFd(3, { untilNewline: true }); } catch { /* no gate: not authorized */ }
	try { closeSync(3); } catch { /* already closed */ }
	if (!line.includes("\n")) fail("worker was not authorized to start");
}

async function main(argv) {
	let [command = "help", ...args] = argv;
	if (command === "__worker") { awaitGate(); [command = "", ...args] = args; }
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
		if (supervised(command, args)) {
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
