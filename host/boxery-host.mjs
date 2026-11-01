// boxery-host commands. host/boxery-host (Bash) is the entry point and execs this file with
// --disable-warning=ExperimentalWarning (node:sqlite). Output formats are a contract: docs/cli.md, and
// test/shell/host-output.sh pins them. Errors: "boxery-host: …" on stderr, non-zero exit, nothing on stdout.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createBackend } from "./backend.mjs";
import * as leases from "./boxery-leases.mjs";
import { runLifecycle } from "./boxery-lifecycle.mjs";
import { loadConfig } from "./config.mjs";
import { vmKinds } from "./kinds.mjs";
import { loadShapes, vmShapes } from "./shapes.mjs";

const VALID_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const fail = (message, exitCode = 1) => { throw Object.assign(new Error(message), { exitCode }); };
const validName = (n) => { if (!VALID_NAME.test(n ?? "")) fail(`invalid name '${n ?? ""}' (use [a-z][a-z0-9-]*)`); return n; };
const print = (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
// One element per line: still plain JSON, and the controller (which has no jq) relies on it.
const jsonArray = (items) => (items.length ? `[\n${items.map((i) => JSON.stringify(i)).join(",\n")}\n]` : "[]");
// printf-style columns: width N = %-Ns, -N = %Ns, no width = %s
const table = (widths, rows) => rows.map((r) => r.map((v, i) => (widths[i] == null ? String(v)
	: widths[i] < 0 ? String(v).padStart(-widths[i]) : String(v).padEnd(widths[i]))).join(" ")).join("\n");

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

function createContext() {
	const config = loadConfig();
	const backends = path.join(config.root, "host", "backends");
	if (!existsSync(path.join(backends, `${config.backend}.sh`))) {
		const have = readdirSync(backends).filter((f) => f.endsWith(".sh")).map((f) => f.slice(0, -3)).sort();
		fail(`unknown backend '${config.backend}' (have: ${have.map((b) => `${b} `).join("")})`);
	}
	let db;
	return {
		...config,
		vms: createBackend(config.env),
		db: () => (db ??= leases.open(path.join(config.conf, "leases.db"))),
		close: () => db?.close(),
	};
}

// ---------------------------------------------------------------- listings
async function lsJson(ctx) {
	let pool = [];
	try { pool = leases.list(ctx.db()); } catch { /* listing VMs must not depend on the lease store */ }
	const lease = Object.fromEntries(pool.map((r) => [r.name, { state: r.state, holder: r.holder, expires_at: r.expires_at }]));
	const sizes = vmShapes(ctx.conf), kinds = vmKinds(ctx.conf);
	const nz = (v) => (v === "" ? null : v);
	return (await ctx.vms.list()).map((vm) => {
		const sz = sizes[vm.name];
		return { name: vm.name, state: nz(vm.state), addr: nz(vm.addr), disk: nz(vm.disk), lease: lease[vm.name] ?? null,
			shape: sz ? (sz.shape ?? "custom") : null, cpus: sz?.cpus ?? null, mem: sz?.mem ?? null, desktop: kinds[vm.name] !== "headless" };
	});
}
async function ls(ctx, [arg]) {
	const vms = await lsJson(ctx);
	if (arg === "--json") return print(jsonArray(vms));
	if (arg) fail("usage: ls [--json]");
	print(table([16, 10, 16, 10, 10, 9], [["NAME", "STATE", "ADDR", "DISK", "SHAPE", "KIND", "LEASE"],
		...vms.map((v) => [v.name, v.state ?? "-", v.addr ?? "-", v.disk ?? "-", v.shape ?? "-", v.desktop ? "desktop" : "headless", v.lease?.state ?? "-"])]));
}

function shapes(ctx, [arg]) {
	const s = loadShapes(ctx.root, ctx.conf);
	if (arg === "--json") return print(JSON.stringify(s));
	if (arg) fail("usage: shapes [--json]");
	print(table([16, -5, -9, -9], [["SHAPE", "CPUS", "MEM_MIB", "DISK_GIB"],
		...Object.entries(s.shapes).map(([n, v]) => [n + (n === s.default ? " *" : ""), v.cpus, v.mem, v.disk])]));
}

/** LABEL<TAB>CREATED<TAB>SIZE for NAME's images (incl. the pool's clean state and in-flight fork images). */
async function snapsLines(ctx, name) {
	if (!await ctx.vms.exists(name)) fail(`no such vm: ${name}`);
	const lines = (await ctx.vms.images()).filter((i) => i.image.startsWith(`${name}@`))
		.map((i) => [i.image.slice(name.length + 1), i.created, i.size]);
	if (await ctx.vms.has("backend_legacy_snaps")) lines.push(...(await ctx.vms.legacySnaps(name)).map((l) => [l, "(legacy)", "-"]));
	return lines;
}
async function snaps(ctx, [name, arg]) {
	validName(name);
	if (arg === "--json") {
		return print(jsonArray((await snapsLines(ctx, name)).map(([n, created, size]) =>
			({ name: n, created: created === "(legacy)" ? null : created, size: size === "-" ? null : size, legacy: created === "(legacy)" }))));
	}
	if (arg) fail("usage: snaps NAME [--json]");
	for (const l of await snapsLines(ctx, name)) print(l.join("\t"));
}

async function images(ctx) {
	print(table([40, 20], [["IMAGE", "CREATED", "SIZE"], ...(await ctx.vms.images()).map((i) => [i.image, i.created, i.size])]));
}

async function ip(ctx, [name]) {
	print((await ctx.vms.sshEndpoint(validName(name))).host);
}

function pool(ctx, [sub = "ls", arg]) {
	if (sub !== "ls") fail("usage: pool add NAME | rm NAME [--force] | ls [--json]");
	let rows;
	try { rows = leases.list(ctx.db()); } catch { fail("lease store error"); }
	rows = rows.map(({ name, state, holder, acquired_at, expires_at, expires_in }) => ({ name, state, holder, acquired_at, expires_at, expires_in }));
	if (arg === "--json") return print(jsonArray(rows));
	print(table([16, 10, 10], [["NAME", "LEASE", "EXPIRES", "HOLDER"],
		...rows.map((r) => [r.name, r.state, r.expires_in == null ? "-" : `${r.expires_in}s`, r.holder ?? "-"])]));
}

function proxyLog(ctx, [n = "30"]) {
	const [cmd, args] = process.platform === "darwin"
		? ["tail", ["-n", n, path.join(process.env.HOME, "Library/Logs", `${ctx.proxyUnit}.log`)]]
		: ["journalctl", ["--user", "-u", ctx.proxyUnit, "-n", n, "--no-pager", "-o", "cat"]];
	return new Promise((resolve, reject) => {
		spawn(cmd, args, { stdio: "inherit" }).on("error", reject).on("close", (code) => {
			if (code === 0) resolve(); else reject(Object.assign(new Error(`${cmd} failed`), { exitCode: code ?? 1, reported: true }));
		});
	});
}

// ---------------------------------------------------------------- dispatch
const lifecycle = (command) => (ctx, args) => runLifecycle(command, args);
const COMMANDS = {
	ls, list: ls, shapes, snaps, images, ip, pool,
	"proxy-log": proxyLog,
	backend: (ctx) => print(ctx.backend),
	acquire: lifecycle("acquire"), renew: lifecycle("renew"), release: lifecycle("release"),
	reap: lifecycle("reap"), reconcile: lifecycle("reconcile"),
};

async function main([command = "help", ...args]) {
	const ctx = createContext();
	try {
		if (["help", "-h", "--help"].includes(command)) return print(usage(ctx));
		const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
		if (!run) { print(usage(ctx)); process.exitCode = 1; return; }
		await run(ctx, args);
	} finally { ctx.close(); }
}

main(process.argv.slice(2)).catch((e) => {
	if (!e.reported) process.stderr.write(`boxery-host: ${e.message}\n`);
	process.exitCode = e.exitCode ?? 1;
});
