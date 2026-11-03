// VM lifecycle commands: new, fork, rm, start, stop, resize. Each runs inside a supervised worker that
// holds the VMs' lifecycle locks for its whole duration (boxery-operations.mjs, docs/lifecycle.md).
import { randomBytes } from "node:crypto";
import { captureVm, cleanupVmImages } from "./images.mjs";
import { deleteHostKey } from "./hostkeys.mjs";
import { deleteVmKind, setVmKind, vmKind } from "./kinds.mjs";
import { issueToken, writeSeed } from "./seed.mjs";
import { deleteVmShape, setVmShape, shapeSize, vmShape } from "./shapes.mjs";
import { fail, log, print, stamp, validImage, validName, validNum } from "./util.mjs";
/** @import { GuestEndpoint } from "./guest.mjs" */
/** @import { Runtime } from "./runtime.mjs" */
/** @import { ShapeRecord } from "./shapes.mjs" */

/** Parsed `new` arguments; sizes are the flags' strings ("" = unset). layers: optional layers on top of
 *  plumbing + devtools (headless only). @typedef {{ name: string, shape: string, cpus: string, mem: string, disk: string, from: string, headless: boolean, layers?: string[] }} NewArgs */
// Layers a headless VM may add with --layers (image/layers/; the base layers are always there).
export const OPTIONAL_LAYERS = ["github-runner"];
/** @typedef {{ cpus: string, mem: string, disk: string }} SizeFlags */

const SHAPE_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const NOVNC = "for i in $(seq 60); do curl -fsS -o /dev/null 127.0.0.1:6080/vnc.html && exit 0; sleep 1; done; exit 1";

/** Pet VMs accept the host and every registered controller. @param {Runtime} rt @param {string} name */
export async function setPetKeys(rt, name) {
	await rt.guest.setKeys(await rt.vms.sshEndpoint(name), rt.guest.petKeys());
}
/** Back to a pet: registered controller keys may log in again, and the VM gets a proxy token of its own
 * (a pool VM's token belonged to a lease). A stopped VM gets both on its next start; a
 * running-but-unreachable guest is an error, not a successful permission update. @param {Runtime} rt @param {string} name */
export async function restorePetAccess(rt, name) {
	let inventory;
	try { inventory = await rt.vms.list(); } catch { fail("cannot inspect VM for pet access"); }
	if (/** @type {Array<string | undefined>} */ (["running", "idle"]).includes(inventory.find((v) => v.name === name)?.state)) {
		try { await setPetKeys(rt, name); await issueToken(rt, name); } catch { fail(`could not restore pet access to ${name}`); }
	} else rt.deleteToken(name);
}
/** @param {Runtime} rt @param {GuestEndpoint} ep @param {string} command */
async function mustRun(rt, ep, command) {
	if (await rt.guest.run(ep, command) !== 0) fail(`ssh to ${ep.host}:${ep.port} failed`);
}

// ---------------------------------------------------------------- new
const NEW_USAGE = "usage: new NAME [--shape S] [--cpus N] [--mem MiB] [--disk GiB] [--from IMAGE] [--headless [--layers L,…]]";
/** new NAME [--shape S] [--cpus N] [--mem MiB] [--disk GiB] [--from IMAGE] [--headless [--layers L,…]] @param {string[]} args */
export function parseNewArgs(args) {
	/** @type {NewArgs} */
	const o = { name: "", shape: "", cpus: "", mem: "", disk: "", from: "", headless: false };
	for (let i = 0; i < args.length; i++) {
		const a = args[i], v = args[i + 1];
		if (a === "--headless") o.headless = true;
		else if (a === "--layers") {
			const layers = (v ?? "").split(",");
			for (const l of layers) if (!OPTIONAL_LAYERS.includes(l)) fail(`unknown layer '${l}' (optional layers: ${OPTIONAL_LAYERS.join(", ")})`);
			o.layers = [...new Set(layers)]; i++;
		}
		else if (a === "--shape") { if (!SHAPE_NAME.test(v ?? "")) fail(`invalid shape name '${v ?? ""}'`); o.shape = v; i++; }
		else if (["--cpus", "--mem", "--disk"].includes(a)) { o[/** @type {keyof SizeFlags} */ (a.slice(2))] = validNum(a, v); i++; }
		else if (a === "--from") { o.from = validImage(v); i++; }
		else if (a.startsWith("-")) fail(`unknown flag ${a}`);
		else o.name = a;
	}
	if (!o.name) fail(NEW_USAGE);
	// A desktop VM's layers come from its base and a VM from an image keeps its source's: only a headless VM,
	// provisioned from the stock image at first boot, can add one.
	if (o.layers && (!o.headless || o.from)) fail("--layers needs --headless (and no --from: a VM made from an image has its source's layers)");
	return o;
}

/** Create, boot and wait for NAME. Returns "NAME HOST:PORT". @param {Runtime} rt @param {NewArgs} args */
export async function createVm(rt, { name, shape, cpus, mem, disk, from, headless, layers = [] }) {
	validName(name);
	// Size: the shape (the default shape if none), then explicit flags. Any flag makes it a custom size.
	const shapes = rt.shapes();
	const base = shapeSize(shapes, shape || shapes.default);
	const custom = Boolean(cpus || mem || disk);
	const label = custom ? "" : shape || shapes.default;
	cpus ||= String(base.cpus); mem ||= String(base.mem); disk ||= String(base.disk);
	if (!(Number(cpus) >= 1 && Number(mem) >= 1 && Number(disk) >= 1)) fail("--cpus, --mem and --disk must be >= 1");
	if (await rt.vms.exists(name)) fail(`${name} already exists`);
	// Where the disk comes from: an image (its VM's kind), the stock image (headless), or the desktop base.
	let kind = "desktop", src = "", provision = "";
	if (from) {
		if (!await rt.vms.imageExists(from)) fail(`no such image: ${from} (boxery-host images)`);
		kind = vmKind(rt.conf, from.split("@")[0]); src = from;
		if (headless && kind !== "headless") fail(`${from} has a desktop, and a VM made from an image keeps it (drop --headless)`);
	} else if (headless) {
		kind = "headless"; src = "stock"; provision = ["plumbing", "devtools", ...layers].join(" ");
	} else if (!await rt.vms.hasBase()) {
		fail(`no base image; run: boxery-host build-base (or: new ${name} --headless, which needs none)`);
	}
	const t0 = Date.now(), secs = () => Math.floor((Date.now() - t0) / 1000);
	const action = rt.intent("create", name);
	const userdata = await writeSeed(rt, name, provision);
	await rt.vms.call("backend_new", [name, cpus, mem, disk, userdata, src]);
	setVmShape(rt.conf, name, { shape: label, cpus, mem, disk });
	setVmKind(rt.conf, name, kind);
	const ep = await rt.vms.waitEndpoint(name);
	log(`${name} reachable at ${ep.host}:${ep.port}; waiting for ssh + cloud-init${provision ? ` (installing ${provision})` : ""}`);
	await rt.waitSsh(name, ep);
	await mustRun(rt, ep, "cloud-init status --wait >/dev/null 2>&1; true");
	if (provision) {
		if (await rt.guest.run(ep, "test -f /var/log/boxery-provision.ok") !== 0) {
			await rt.guest.run(ep, "sudo tail -30 /var/log/boxery-provision.log");
			fail(`installing ${provision} on ${name} failed (log above: /var/log/boxery-provision.log in the VM)`);
		}
		log(`${name}: ${provision} installed ${secs()}s after create`);
	}
	// A VM made from an image starts with another VM's disk. Whatever the backend did to give it its own
	// identity, make sure of the parts boxery's security depends on: exactly this host's keys (never the
	// source's lease holder), and nothing pushed by grants (tmpfs, so normally gone already).
	if (from) {
		try { await setPetKeys(rt, name); } catch { fail(`could not reset ssh keys on ${name}`); }
		await rt.guest.run(ep, 'rm -rf "/run/user/$(id -u)/boxery"');
	}
	if (kind === "desktop" && await rt.guest.run(ep, NOVNC) !== 0) log("warning: noVNC not answering yet");
	rt.done(action);
	log(`${name} ready (${kind}, ${secs()}s)`);
	return `${name} ${ep.host}:${ep.port}`;
}

/** @param {Runtime} rt @param {string[]} args */
export async function newVm(rt, args) {
	print(await createVm(rt, parseNewArgs(args)));
}

// ---------------------------------------------------------------- fork
// fork SRC DST... [--shape S] [--cpus N --mem MiB --disk GiB]: capture SRC once (it keeps running), then
// boot every DST from that image with its own identity (hostname, proxy token, ssh keys, network). Prints
// "DST ADDR" per fork, like new. The capture is temporary: forks never depend on it. Forks get SRC's
// recorded size unless --shape or a size flag is given (flags override SRC's size field by field).
/** @param {Runtime} rt @param {string[]} args */
export async function fork(rt, args) {
	let src = "", shape = "";
	const dsts = /** @type {string[]} */ ([]), flags = /** @type {string[]} */ ([]);
	for (let i = 0; i < args.length; i++) {
		const a = args[i], v = args[i + 1];
		if (["--cpus", "--mem", "--disk"].includes(a)) { flags.push(a, validNum(a, v)); i++; }
		else if (a === "--shape") { if (!SHAPE_NAME.test(v ?? "")) fail(`invalid shape name '${v ?? ""}'`); shape = v; i++; }
		else if (a.startsWith("-")) fail(`unknown flag ${a}`);
		else if (!src) src = a;
		else dsts.push(a);
	}
	if (!src || !dsts.length) fail("usage: fork SRC DST... [--shape S] [--cpus N --mem MiB --disk GiB]");
	validName(src);
	if (!await rt.vms.exists(src)) fail(`no such vm: ${src}`);
	// Size: --shape, else SRC's recorded size, else (VMs made before shapes) its size per the backend.
	const rec = vmShape(rt.conf, src);
	/** @type {number[] | null} */
	let sz = rec ? [rec.cpus, rec.mem, rec.disk] : null;
	if (!rec && await rt.vms.has("backend_size")) sz = await rt.vms.size(src, { quiet: true }).catch(() => null);
	/** @type {string[]} */
	let sizing = [], label = "";
	if (shape) { shapeSize(rt.shapes(), shape); sizing = ["--shape", shape]; }
	else if (sz?.every((n) => Number.isInteger(n) && n >= 0)) {
		/** @type {Partial<Record<string, number>>} */
		const size = { "--cpus": sz[0], "--mem": sz[1], "--disk": sz[2] };
		for (let i = 0; i < flags.length; i += 2) delete size[flags[i]];
		sizing = Object.entries(size).flatMap(([f, n]) => [f, String(n)]);
		if (!flags.length && rec) label = rec.shape ?? ""; // an exact copy of SRC's size keeps SRC's shape name
	}
	for (const d of dsts) {
		validName(d);
		if (await rt.vms.exists(d)) fail(`${d} already exists`);
		if (dsts.filter((x) => x === d).length !== 1) fail(`duplicate fork name ${d}`);
	}
	const image = `${src}@fork-${stamp()}-${randomBytes(3).toString("hex")}`;
	const cleanup = rt.intent("fork-image", image);
	const t0 = Date.now(), secs = () => Math.floor((Date.now() - t0) / 1000);
	await captureVm(rt, src, image);
	log(`captured ${src} in ${secs()}s; booting ${dsts.length} fork(s)`);
	// Boot the forks in parallel under this operation's locks; print results in argument order. A failed
	// fork leaves its create intent behind, so the supervisor removes it after this worker exits.
	const results = await Promise.allSettled(dsts.map((d) => createVm(rt, parseNewArgs([d, ...sizing, ...flags, "--from", image]))));
	let rc = 0;
	results.forEach((r, i) => {
		if (r.status === "fulfilled") {
			print(r.value);
			if (label) setVmShape(rt.conf, dsts[i], { .../** @type {ShapeRecord} */ (vmShape(rt.conf, dsts[i])), shape: label });
		} else {
			rc = 1;
			if (!r.reason?.reported) process.stderr.write(`boxery-host: ${r.reason?.message ?? r.reason}\n`);
			log(`fork ${dsts[i]} failed`);
		}
	});
	await rt.vms.call("backend_image_rm", [image]);
	rt.done(cleanup);
	log(`forked ${src} → ${dsts.join(" ")} in ${secs()}s`);
	if (rc) throw Object.assign(new Error("fork failed"), { exitCode: rc, reported: true });
}

// ---------------------------------------------------------------- rm, start, stop
/** @param {Runtime} rt @param {string[]} args */
export async function rm(rt, [name]) {
	validName(name);
	if (rt.poolRow(name)) fail(`${name} is a pool VM; run: boxery-host pool rm ${name} (after its lease ends)`);
	if (!await rt.vms.exists(name)) fail(`no such vm: ${name}`);
	const action = rt.intent("remove", name);
	await rt.vms.call("backend_rm", [name]);
	deleteVmShape(rt.conf, name); deleteVmKind(rt.conf, name);
	// Forks and image readers hold this source's lock until all copies are independent.
	await cleanupVmImages(rt, name);
	rt.deleteToken(name);
	rt.clearEdge(name);
	deleteHostKey(rt.conf, name);
	rt.done(action);
	log(`${name} removed with its snapshots (proxy token revoked)`);
}

/** @param {Runtime} rt @param {string[]} args */
export async function start(rt, [name]) {
	validName(name);
	await rt.vms.call("backend_start", [name]);
	await rt.waitSsh(name, await rt.vms.waitEndpoint(name));
	if (!rt.poolRow(name)) {
		await setPetKeys(rt, name);
		if (typeof rt.token(name) !== "string") await issueToken(rt, name); // left the pool while stopped
	}
	log(`${name} started`);
}

/** @param {Runtime} rt @param {string[]} args */
export async function stop(rt, [name]) {
	validName(name);
	await rt.vms.call("backend_stop", [name]);
	log(`${name} shutting down`);
}

// ---------------------------------------------------------------- resize
const RESIZE_USAGE = "usage: resize NAME [--cpus N] [--mem MiB] [--disk GiB]";
/** @param {Runtime} rt @param {string[]} argv */
export async function resize(rt, [name, ...args]) {
	if (!name || name.startsWith("-")) fail(RESIZE_USAGE);
	/** @type {SizeFlags} */
	const want = { cpus: "", mem: "", disk: "" };
	for (let i = 0; i < args.length; i += 2) {
		if (!["--cpus", "--mem", "--disk"].includes(args[i])) fail(RESIZE_USAGE);
		want[/** @type {keyof SizeFlags} */ (args[i].slice(2))] = validNum(args[i], args[i + 1]);
	}
	if (!want.cpus && !want.mem && !want.disk) fail(RESIZE_USAGE);
	validName(name);
	if (!await rt.vms.exists(name)) fail(`no such vm: ${name}`);
	if (want.cpus && !(Number(want.cpus) >= 1)) fail("--cpus must be at least 1");
	if (want.mem && !(Number(want.mem) >= 512)) fail("--mem must be at least 512 MiB");
	if (!await rt.vms.has("backend_resize")) fail(`the ${rt.backend} backend cannot resize VMs`);
	rt.requireLock(name);
	await resizeVm(rt, name, want);
}

// Like start/stop, the result is the hypervisor's state: an interrupted resize is not rolled back.
/** @param {Runtime} rt @param {string} name @param {SizeFlags} want */
async function resizeVm(rt, name, want) {
	let before;
	try { before = await rt.vms.size(name); } catch { fail(`cannot read the size of ${name}`); }
	const [c, m, d] = before;
	if (want.disk && Number(want.disk) < d) fail(`${name}: disk can only grow (it is ${d} GiB)`);
	const change = [want.cpus, want.mem, want.disk].map((v, i) => (v && Number(v) !== before[i] ? v : ""));
	if (change.every((v) => !v)) { log(`${name} already has ${c} vCPU, ${m} MiB, ${d} GiB`); return; }
	const was = (await rt.vms.list()).find((v) => v.name === name)?.state;
	await rt.vms.call("backend_resize", [name, ...change]);
	if (was === "running") {
		await rt.waitSsh(name, await rt.vms.waitEndpoint(name));
		if (!rt.poolRow(name)) await setPetKeys(rt, name);
	}
	let after;
	try { after = await rt.vms.size(name); } catch { fail(`${name} was resized, but its new size cannot be read`); }
	const [cpus, mem, disk] = after;
	setVmShape(rt.conf, name, { shape: null, cpus, mem, disk }); // no longer its shape's size: custom
	log(`${name} resized: ${c} vCPU, ${m} MiB, ${d} GiB → ${cpus} vCPU, ${mem} MiB, ${disk} GiB`);
}
