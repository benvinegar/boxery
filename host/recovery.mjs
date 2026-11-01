// Inventory drift: VMs that disappeared from the backend behind boxery's back. Missing pool VMs are
// fenced (BROKEN) and their proxy tokens / edge routes revoked. Unfamiliar VMs and images are left
// alone: a reconciler must not guess that user data is garbage (docs/lifecycle.md).
import { readFileSync } from "node:fs";
import path from "node:path";
import * as leases from "./boxery-leases.mjs";

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
