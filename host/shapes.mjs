// Shapes: named VM sizes. Built-ins in host/shapes.json, overridden or extended by $CONF/shapes.json.
// A user entry with a built-in's name overrides only the fields it sets; a new name needs all three.
// Each VM's resolved size is recorded in $CONF/vm-shapes/NAME.json, so forks and `ls` know it.
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v) => typeof v === "number" && Number.isInteger(v) && v >= 1;

/** Merge and validate. Throws with a message naming the user's file when it is invalid. */
export function mergeShapes(builtin, user, file = "shapes.json") {
	if (!isObject(user)) throw new Error(`${file} is not a JSON object`);
	const fail = (why) => { throw new Error(`invalid shapes in ${file}: ${why}`); };
	const shapes = structuredClone(builtin.shapes);
	const extra = user.shapes ?? {};
	if (!isObject(extra)) fail("shapes must be an object");
	for (const [name, value] of Object.entries(extra)) {
		if (!isObject(value)) fail(`shape ${JSON.stringify(name)} must be an object`);
		shapes[name] = { ...(shapes[name] ?? {}), ...value };
	}
	const def = user.default == null || user.default === false ? builtin.default : user.default;
	if (typeof def !== "string" || !Object.hasOwn(shapes, def)) fail(`default shape ${JSON.stringify(def ?? null)} is not defined`);
	if (Object.keys(shapes).some((n) => !NAME.test(n))) fail("shape names must match [a-z][a-z0-9-]*");
	if (Object.values(shapes).some((s) => ![s.cpus, s.mem, s.disk].every(whole))) fail("every shape needs whole-number cpus, mem (MiB) and disk (GiB) >= 1");
	return { default: def, shapes: Object.fromEntries(Object.entries(shapes).map(([n, s]) => [n, { cpus: s.cpus, mem: s.mem, disk: s.disk }])) };
}

/** {default, shapes: {NAME: {cpus, mem, disk}}} for this host. */
export function loadShapes(root, conf) {
	const builtin = JSON.parse(readFileSync(path.join(root, "host", "shapes.json"), "utf8"));
	const file = path.join(conf, "shapes.json");
	let user = {};
	try { user = JSON.parse(readFileSync(file, "utf8")); }
	catch (e) {
		if (e.code === "ENOENT") user = {};
		else throw new Error(`${file} is not a JSON object`);
	}
	return mergeShapes(builtin, user, file);
}

/** {cpus, mem, disk} of shape NAME; throws listing the known shapes. */
export function shapeSize(shapes, name) {
	if (!Object.hasOwn(shapes.shapes, name)) throw new Error(`unknown shape '${name}' (have: ${Object.keys(shapes.shapes).sort().join(", ")})`);
	return shapes.shapes[name];
}

// ---------------------------------------------------------------- per-VM size records
const recordFile = (conf, name) => path.join(conf, "vm-shapes", `${name}.json`);

/** {NAME: {shape, cpus, mem, disk}} for VMs with a record (unreadable records are skipped). */
export function vmShapes(conf) {
	const out = {};
	let files = [];
	try { files = readdirSync(path.join(conf, "vm-shapes")); }
	catch (e) { if (e.code !== "ENOENT") throw e; }
	for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
		try { out[f.slice(0, -5)] = JSON.parse(readFileSync(path.join(conf, "vm-shapes", f), "utf8")); }
		catch { /* a torn or foreign file is not a size record */ }
	}
	return out;
}
export function vmShape(conf, name) {
	try { return JSON.parse(readFileSync(recordFile(conf, name), "utf8")); }
	catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
/** shape null = custom size */
export function setVmShape(conf, name, { shape = null, cpus, mem, disk }) {
	mkdirSync(path.join(conf, "vm-shapes"), { recursive: true });
	const file = recordFile(conf, name);
	writeFileSync(`${file}.tmp`, `${JSON.stringify({ shape: shape || null, cpus: Number(cpus), mem: Number(mem), disk: Number(disk) })}\n`);
	renameSync(`${file}.tmp`, file);
}
/** Record NAME's size only if it has no record yet (atomic, never replaces one): for callers that hold
 *  no VM lock, such as `ls`, so a concurrent new/resize always wins. false if a record exists. */
export function addVmShape(conf, name, { shape = null, cpus, mem, disk }) {
	mkdirSync(path.join(conf, "vm-shapes"), { recursive: true });
	const file = recordFile(conf, name), tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ shape: shape || null, cpus: Number(cpus), mem: Number(mem), disk: Number(disk) })}\n`);
	try { linkSync(tmp, file); return true; }
	catch (e) { if (e.code === "EEXIST") return false; throw e; }
	finally { rmSync(tmp, { force: true }); }
}
export function deleteVmShape(conf, name) {
	rmSync(recordFile(conf, name), { force: true });
	rmSync(`${recordFile(conf, name)}.tmp`, { force: true });
}
