// Shapes: named VM sizes. Built-ins in host/shapes.json, overridden or extended by $CONF/shapes.json.
// A user entry with a built-in's name overrides only the fields it sets; a new name needs all three.
// Each VM's resolved size is part of its record (vm-records.mjs), so forks and `ls` know it.
import { readFileSync } from "node:fs";
import path from "node:path";

/** @typedef {{ cpus: number, mem: number, disk: number }} Size */
/** @typedef {{ default: string, shapes: Record<string, Size> }} Shapes */
/** A VM's size record; shape null = custom size. @typedef {Size & { shape: string | null }} ShapeRecord */
/** @typedef {{ shape?: string | null, cpus: number | string, mem: number | string, disk: number | string }} ShapeInput */

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (/** @type {unknown} */ v) => typeof v === "number" && Number.isInteger(v) && v >= 1;

/** Merge and validate. Throws with a message naming the user's file when it is invalid.
 *  @param {Shapes} builtin @param {unknown} user parsed JSON @param {string} [file] @returns {Shapes} */
export function mergeShapes(builtin, user, file = "shapes.json") {
	if (!isObject(user)) throw new Error(`${file} is not a JSON object`);
	/** @type {(why: string) => never} */
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

/** {default, shapes: {NAME: {cpus, mem, disk}}} for this host. @param {string} root @param {string} conf */
export function loadShapes(root, conf) {
	const builtin = JSON.parse(readFileSync(path.join(root, "host", "shapes.json"), "utf8"));
	const file = path.join(conf, "shapes.json");
	let user = {};
	try { user = JSON.parse(readFileSync(file, "utf8")); }
	catch (e) {
		if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") user = {};
		else throw new Error(`${file} is not a JSON object`);
	}
	return mergeShapes(builtin, user, file);
}

/** {cpus, mem, disk} of shape NAME; throws listing the known shapes. @param {Shapes} shapes @param {string} name */
export function shapeSize(shapes, name) {
	if (!Object.hasOwn(shapes.shapes, name)) throw new Error(`unknown shape '${name}' (have: ${Object.keys(shapes.shapes).sort().join(", ")})`);
	return shapes.shapes[name];
}
