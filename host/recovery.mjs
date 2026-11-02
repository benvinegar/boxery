// Crash recovery and inventory drift (docs/lifecycle.md).
// replayIntents: finish or undo an abandoned operation's journaled work, under that operation's
// complete lock set. Only artifacts its journal names are removed: an unfamiliar VM or snapshot is
// never guessed to be garbage. Drift: VMs that disappeared from the backend behind boxery's back.
import { readFileSync } from "node:fs";
import path from "node:path";
import * as leases from "./boxery-leases.mjs";
import { runLifecycle } from "./boxery-lifecycle.mjs";
import { actions, completeIntent } from "./boxery-operations.mjs";
import { cleanupVmImages, deleteSnapshot, revertVm } from "./images.mjs";
import { deleteVmKind } from "./kinds.mjs";
import { deleteVmShape } from "./shapes.mjs";
import { fail, POOL_SNAP } from "./util.mjs";
import { restorePetAccess, setPetKeys } from "./vms.mjs";

const leaseMatches = (db, name, gen, epoch, state) => {
	const row = leases.get(db, name); // storage errors propagate; they are not "stale"
	return row?.gen === Number(gen) && row.epoch === epoch && row.state === state;
};

/** Replay this worker's operation journal, newest intent first. Intent kinds and data are stable:
 * an operation written by an older boxery-host must still replay. */
export async function replayIntents(rt) {
	const db = rt.db();
	for (const { id, kind, data } of actions(db, rt.operationId)) {
		const [name] = data;
		switch (kind) {
			case "create":
				await rt.vms.call("backend_cleanup_new", [name]);
				deleteVmShape(rt.conf, name); deleteVmKind(rt.conf, name); rt.deleteToken(name); rt.clearEdge(name);
				break;
			case "remove":
				await rt.vms.call("backend_cleanup_new", [name]);
				await cleanupVmImages(rt, name); // rm can have crashed between deleting the VM and its images
				deleteVmShape(rt.conf, name); deleteVmKind(rt.conf, name); rt.deleteToken(name); rt.clearEdge(name);
				break;
			case "capture": await rt.vms.call("backend_recover_capture", [name, data[1], data[2]]); break;
			case "fork-image": await rt.vms.call("backend_cleanup_image", [name]); break;
			case "snapshot-remove": await deleteSnapshot(rt, name, data[1]); break;
			case "revert": await revertVm(rt, name, data[1]); break;
			case "acquire": {
				const [, gen, epoch] = data;
				if (leaseMatches(db, name, gen, epoch, "ACQUIRING")) {
					const r = leases.beginResetName(db, name, gen);
					await runLifecycle(rt, "reset-held", [name, r.gen, epoch]);
				}
				break;
			}
			case "reset": await runLifecycle(rt, "reset-held", [name, data[1], data[2]]); break;
			case "pool-add":
				if (!leases.get(db, name)) {
					await rt.vms.call("backend_cleanup_image", [`${name}@${POOL_SNAP}`]);
					await setPetKeys(rt, name);
				} else rt.deleteToken(name);
				break;
			case "pool-rm":
				if (leases.get(db, name)) leases.remove(db, name, true);
				rt.clearEdge(name);
				await restorePetAccess(rt, name);
				await rt.vms.call("backend_cleanup_image", [`${name}@${POOL_SNAP}`]);
				break;
			default: fail(`unknown recovery intent: ${kind}`);
		}
		completeIntent(db, rt.operationId, id);
	}
}

// ---------------------------------------------------------------- drift
function tokenNames(conf) {
	try { return Object.keys(JSON.parse(readFileSync(path.join(conf, "tokens.json"), "utf8"))); }
	catch { return []; } // an unreadable token file is not inventory; token updates report it
}

/** Check every VM boxery knows about (backend, pool, tokens) under that VM's lifecycle lock. */
export async function reconcileDrift({ backend, db, conf, lock }) {
	let inventory;
	try { inventory = await backend.list(); }
	catch { throw new Error("cannot read backend inventory; refusing drift repair"); }
	const names = new Set([...inventory.map((r) => r.name), ...leases.list(db).map((r) => r.name), ...tokenNames(conf)]);
	for (const name of [...names].sort()) {
		if (!leases.VALID_NAME.test(name)) throw new Error(`invalid name '${name}' (use [a-z][a-z0-9-]*)`);
		await lock(name, "_reconcile_vm", [name]);
	}
}

/** Held-lock callback: a VM missing from the backend loses its pool lease (BROKEN), token and routes. */
export async function reconcileVm(rt, name) {
	rt.requireLock(name);
	let inventory;
	try { inventory = await rt.vms.list(); } catch { fail("cannot read backend inventory; refusing drift repair"); }
	if (inventory.some((v) => v.name === name)) return;
	if (leases.get(rt.db(), name)) {
		leases.markMissing(rt.db(), name);
		rt.log(`${name} missing from backend → BROKEN`);
	}
	rt.deleteToken(name); rt.clearEdge(name); deleteVmShape(rt.conf, name); deleteVmKind(rt.conf, name);
}
