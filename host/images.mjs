// Images: immutable disk states named VM@LABEL (snapshots, the pool's clean state, fork sources).
// One primitive on every backend: capture a VM's disk as an image, boot VMs from images, reimage.
//   snap   = capture NAME → NAME@LABEL          revert = put NAME's own image back (reimage)
//   fork   = capture SRC → new VM(s) from it    pool   = reset to NAME@boxery-clean
// Images hold disk state only (no RAM): processes restart, and tmpfs grants are never captured.
import { installToken } from "./seed.mjs";
import { fail, log, POOL_SNAP, stamp, validName, validSnap } from "./util.mjs";

/** Put VM NAME back to its image NAME@LABEL. */
export async function restoreVm(backend, name, label, options) {
	const image = `${name}@${label}`;
	if (await backend.imageExists(image, options)) return backend.call("backend_reimage", [name, image], options);
	throw new Error(`no snapshot ${label} for ${name}`);
}

/** Capture NAME's disk as IMAGE, journaled with NAME's state so a crash can be undone. */
export async function captureVm(rt, name, image) {
	let state = "";
	try { state = (await rt.vms.list()).find((v) => v.name === name)?.state ?? ""; } catch { /* recorded as unknown */ }
	const action = rt.intent("capture", name, image, state);
	await rt.vms.call("backend_capture", [name, image]);
	rt.done(action);
}

/** [label, created, size] for NAME's images (incl. the pool's clean state and in-flight fork images). */
export async function snapsLines(rt, name) {
	if (!await rt.vms.exists(name)) fail(`no such vm: ${name}`);
	return (await rt.vms.images()).filter((i) => i.image.startsWith(`${name}@`))
		.map((i) => [i.image.slice(name.length + 1), i.created, i.size]);
}

export async function cleanupVmImages(rt, name) {
	for (const { image } of await rt.vms.images()) if (image.startsWith(`${name}@`)) await rt.vms.call("backend_image_rm", [image]);
}

export async function snap(rt, [name, label]) {
	validName(name);
	const s = validSnap(label || `snap-${stamp("-")}`);
	if (!await rt.vms.exists(name)) fail(`no such vm: ${name}`);
	if (await rt.vms.imageExists(`${name}@${s}`)) fail(`snapshot ${name}@${s} exists (boxery-host snap-rm ${name} ${s})`);
	await captureVm(rt, name, `${name}@${s}`);
	log(`snapshot ${name}@${s}`);
}

/** Idempotent: also replays a previously validated removal. */
export async function deleteSnapshot(rt, name, label) {
	let images;
	try { images = await rt.vms.images(); } catch { fail("cannot inspect images during removal"); }
	if (images.some((i) => i.image === `${name}@${label}`)) await rt.vms.call("backend_image_rm", [`${name}@${label}`]);
}

export async function snapRm(rt, [name, label]) {
	validName(name); validSnap(label);
	if (label === POOL_SNAP && rt.poolRow(name)) fail(`${name}@${label} is the pool's clean state`);
	if (!(await snapsLines(rt, name)).some(([l]) => l === label)) fail(`no snapshot ${name}@${label}`);
	const action = rt.intent("snapshot-remove", name, label);
	await deleteSnapshot(rt, name, label);
	rt.done(action);
	log(`removed snapshot ${name}@${label}`);
}

/** Reimage NAME from NAME@LABEL and wait for it. Also the recovery of an interrupted revert. */
export async function revertVm(rt, name, label) {
	await restoreVm(rt.vms, name, label);
	const ep = await rt.vms.waitEndpoint(name);
	await rt.waitSsh(name, ep);
	// Step the guest clock to host time, as a pool reset does.
	await rt.guest.run(ep, `sudo date -u -s @${Math.floor(Date.now() / 1000)} >/dev/null`);
	// The VM keeps its token, but the image may carry an older one (from before the VM was in the pool).
	const token = rt.token(name);
	if (typeof token === "string") await installToken(rt, name, token);
}

export async function revert(rt, [name, label]) {
	validName(name);
	if (!label) fail("usage: revert NAME SNAP");
	validSnap(label);
	if (!await rt.vms.exists(name)) fail(`no such vm: ${name}`);
	if (rt.poolRow(name)) fail(`${name} is a pool VM; it is reset on release`);
	if (!(await snapsLines(rt, name)).some(([l]) => l === label)) fail(`no snapshot ${label} for ${name}`);
	const action = rt.intent("revert", name, label);
	await revertVm(rt, name, label);
	rt.done(action);
	log(`${name} reverted to ${label}`);
}
