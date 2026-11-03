// patch NAME | --all [--wait S]: bring VMs' guest software up to this host's image layers. Pushes the
// host's layer files into the VM, runs the layers it has again (boxery-provision: security updates, and
// what the layers install outside apt), restarts it if the guest asks to (/var/run/reboot-required) and
// records the new build (build-info.mjs). A pool VM must be free: its lifecycle lock keeps leases off it
// while it is patched, and its clean image NAME@boxery-clean is captured again. Other snapshots and images
// keep their old software.
import * as leases from "./boxery-leases.mjs";
import { supervise } from "./boxery-operations.mjs";
import { refreshBuild } from "./build-info.mjs";
import { captureVm } from "./images.mjs";
import { vmKind } from "./kinds.mjs";
import { setLeaseKeys } from "./pool.mjs";
import { fail, log, POOL_SNAP, sleep, validName, validNum } from "./util.mjs";
/** @import { GuestEndpoint } from "./guest.mjs" */
/** @import { Runtime } from "./runtime.mjs" */

export const PATCH_USAGE = "usage: patch NAME|--all [--wait S]";
const BOOT_ID = "cat /proc/sys/kernel/random/boot_id";

/** NAME|--all [--wait S] → {name, all, wait}. @param {string[]} args */
export function parsePatchArgs(args) {
	let name = "", all = false, wait = 0;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--all") all = true;
		else if (args[i] === "--wait") { wait = Number(validNum("--wait", args[i + 1])); i++; }
		else if (args[i].startsWith("-") || name) fail(PATCH_USAGE);
		else name = args[i];
	}
	if (all === Boolean(name)) fail(PATCH_USAGE);
	if (name) validName(name);
	return { name, all, wait };
}

/** Before taking NAME's lock: wait up to WAIT seconds for a pool VM's lease to end. The patch itself
 *  checks again under the lock (a lease can't start while it is held). @param {Runtime} rt @param {string} name @param {number} wait */
export async function waitForLease(rt, name, wait) {
	const deadline = Date.now() + wait * 1000;
	for (let row = rt.poolRow(name), said = false; row && ["ACQUIRING", "LEASED", "RESETTING"].includes(row.state) && Date.now() < deadline; row = rt.poolRow(name)) {
		if (!said) { log(`${name} is ${row.state.toLowerCase()}; waiting up to ${wait}s for its lease to end`); said = true; }
		await sleep(2000);
	}
}

/** The guest script that installs this host's layer files where seeds put them (host/backend.sh
 *  __layer_files, parsed back from its write_files entries). @param {Runtime} rt */
async function pushScript(rt) {
	const files = [];
	for (const line of await rt.vms.layerFiles()) {
		const m = line.match(/^ {2}- path: (\S+)$|^ {4}permissions: "([0-7]+)"$|^ {4}content: ([A-Za-z0-9+/=]+)$/);
		if (m?.[1]) files.push({ path: m[1], mode: "", b64: "" });
		else if (m?.[2]) files[files.length - 1].mode = m[2];
		else if (m?.[3]) files[files.length - 1].b64 = m[3];
	}
	if (!files.length || files.some((f) => !f.mode || !f.b64)) fail("could not read this host's image layers");
	return ["set -e", ...files.map((f) => `mkdir -p "$(dirname ${f.path})"; printf %s '${f.b64}' | base64 -d >${f.path}.new; chmod ${f.mode} ${f.path}.new; mv -f ${f.path}.new ${f.path}`), ""].join("\n");
}

/** Restart NAME if its updates ask for it, and wait until it is back (a new boot id). @param {Runtime} rt @param {string} name @param {GuestEndpoint} ep */
async function rebootIfRequired(rt, name, ep) {
	if (await rt.guest.run(ep, "test -e /var/run/reboot-required", { quiet: true }) !== 0) return false;
	const boot = (await rt.guest.output(ep, BOOT_ID)).out.trim();
	log(`${name}: restarting it (the updates ask for it: /var/run/reboot-required)`);
	await rt.guest.run(ep, "sudo systemctl reboot", { quiet: true }); // the connection may drop
	const tries = Number(rt.env.BOXERY_SSH_WAIT_TRIES || 180);
	for (let i = 0; i < tries; i++) {
		await sleep(2000);
		try {
			const now = await rt.guest.output(await rt.vms.sshEndpoint(name, { quiet: true }), BOOT_ID);
			if (now.code === 0 && now.out.trim() && now.out.trim() !== boot) return true;
		} catch { /* not back yet */ }
	}
	return fail(`${name} did not come back after restarting (boxery ls; boxery start ${name})`);
}

/** The supervised worker: patch NAME while holding its lifecycle lock. @param {Runtime} rt @param {string[]} args */
export async function patchVm(rt, args) {
	const { name } = parsePatchArgs(args);
	if (!name) fail(PATCH_USAGE);
	rt.requireLock(name);
	if (!await rt.vms.exists(name)) fail(`no such vm: ${name}`);
	const row = rt.poolRow(name);
	if (row?.state === "BROKEN") fail(`${name} is a broken pool VM: fix it first (pool rm ${name}, then patch it and pool add ${name})`);
	if (row && row.state !== "FREE") fail(`${name} is a pool VM with an active lease (${row.state.toLowerCase()}); patch it after the lease ends (or: patch ${name} --wait S)`);
	/** @type {GuestEndpoint} */
	let ep;
	try { ep = await rt.vms.sshEndpoint(name, { quiet: true }); } catch { return fail(`${name} is not running (start it first)`); }
	const t0 = Date.now(), secs = () => Math.floor((Date.now() - t0) / 1000);
	// A crash from here on leaves a pool VM between clean images: recovery puts it back to one (recovery.mjs).
	const action = row ? rt.intent("pool-patch", name) : "";
	if (await rt.guest.run(ep, "sudo bash -s", { input: await pushScript(rt) }) !== 0) fail(`could not install this host's image layers in ${name}`);
	// The layers it has (/etc/boxery/layers); a VM from before that file: its kind's.
	const fallback = vmKind(rt.conf, name) === "headless" ? "plumbing devtools" : "plumbing devtools desktop";
	log(`${name}: running its image layers again (log: /var/log/boxery-patch.log in the VM)`);
	const provision = `sudo bash -c 'set -o pipefail; L=$(tr "\\n" " " 2>/dev/null </etc/boxery/layers); /usr/local/sbin/boxery-provision \${L:-${fallback}} 2>&1 | tee /var/log/boxery-patch.log | while IFS= read -r l; do case $l in "==> "*) printf "%s\\n" "$l" ;; esac; done'`;
	if (await rt.guest.run(ep, provision) !== 0) {
		await rt.guest.run(ep, "sudo tail -30 /var/log/boxery-patch.log");
		fail(`patching ${name} failed (log above: /var/log/boxery-patch.log in the VM)`);
	}
	const restarted = await rebootIfRequired(rt, name, ep);
	if (restarted) ep = await rt.vms.sshEndpoint(name, { quiet: true });
	const rec = await refreshBuild(rt, name, ep);
	if (row) {
		// Like pool add: the clean image holds only the host's key and no pushed grants.
		await rt.guest.run(ep, 'rm -rf "/run/user/$(id -u)/boxery"; sync');
		try { await setLeaseKeys(rt, name); } catch { fail(`could not lock down ssh keys on ${name}`); }
		if (await rt.vms.imageExists(`${name}@${POOL_SNAP}`)) await rt.vms.call("backend_image_rm", [`${name}@${POOL_SNAP}`]);
		await captureVm(rt, name, `${name}@${POOL_SNAP}`);
		rt.done(action);
		log(`${name}: captured its clean image ${name}@${POOL_SNAP} again (the next leases start patched)`);
	}
	log(`${name} patched in ${secs()}s${restarted ? " (restarted)" : ""}${rec?.kernel ? `: kernel ${rec.kernel}` : ""}`);
	const snaps = (await rt.vms.images()).map((i) => i.image).filter((i) => i.startsWith(`${name}@`) && i !== `${name}@${POOL_SNAP}`).map((i) => i.slice(name.length + 1));
	if (snaps.length) log(`${name}'s snapshots were not patched (${snaps.join(", ")}): a VM made or reverted from one has its old software until you patch it`);
}

/** patch --all: every running VM, one supervised operation at a time; stopped VMs and pool VMs with a
 *  lease are skipped (or waited for, --wait). @param {Runtime} rt @param {string[]} args */
export async function patchAll(rt, args) {
	const { all, wait } = parsePatchArgs(args);
	if (!all) fail(PATCH_USAGE);
	const vms = (await rt.vms.list()).sort((a, b) => a.name.localeCompare(b.name));
	const done = /** @type {string[]} */ ([]), skipped = /** @type {string[]} */ ([]), failed = /** @type {string[]} */ ([]);
	for (const vm of vms) {
		if (!["running", "idle"].includes(vm.state)) { skipped.push(`${vm.name} (${vm.state || "not running"})`); continue; }
		if (wait) await waitForLease(rt, vm.name, wait);
		let row;
		try { row = leases.get(rt.db(), vm.name); } catch { row = null; }
		if (row && row.state !== "FREE") { skipped.push(`${vm.name} (${row.state.toLowerCase()})`); continue; }
		log(`patching ${vm.name}`);
		const rc = await supervise({ conf: rt.conf, names: [vm.name], command: "patch", args: ["__dispatch", "patch", vm.name], env: rt.operationEnv() });
		(rc === 0 ? done : failed).push(vm.name);
	}
	log(`patched: ${done.join(", ") || "-"}${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
	if (failed.length) throw Object.assign(new Error("patch failed"), { exitCode: 1, reported: true });
}
