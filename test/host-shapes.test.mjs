// host/shapes.mjs: merging $CONF/shapes.json over the built-ins, and validation (fails closed).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { mergeShapes, shapeSize } from "../host/shapes.mjs";

const builtin = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../host/shapes.json"), "utf8"));

test("no user file: the built-ins, fields in cpus/mem/disk order", () => {
	assert.equal(JSON.stringify(mergeShapes(builtin, {})),
		'{"default":"standard","shapes":{"small":{"cpus":2,"mem":4096,"disk":20},"standard":{"cpus":4,"mem":8192,"disk":40},"large":{"cpus":8,"mem":16384,"disk":80}}}');
});

test("override one field, add a shape, change the default", () => {
	const s = mergeShapes(builtin, { default: "dev", shapes: { dev: { disk: 60, mem: 12288, cpus: 6 }, large: { mem: 24576 } } });
	assert.equal(s.default, "dev");
	assert.deepEqual(s.shapes.large, { cpus: 8, mem: 24576, disk: 80 });
	assert.deepEqual(s.shapes.dev, { cpus: 6, mem: 12288, disk: 60 });
	assert.deepEqual(Object.keys(s.shapes), ["small", "standard", "large", "dev"]);
	assert.deepEqual(builtin.shapes.large, { cpus: 8, mem: 16384, disk: 80 }, "built-ins are not mutated");
});

test("invalid user files fail with a message naming the file", () => {
	for (const user of [[], "x", null, { shapes: { x: { cpus: 1 } } }, { default: "nope" }, { default: "" }, { shapes: { Bad: { cpus: 1, mem: 1, disk: 1 } } },
		{ shapes: { small: { cpus: 1.5 } } }, { shapes: { small: { mem: 0 } } }, { shapes: { small: { disk: "9" } } }, { shapes: [] }, { shapes: { small: 3 } }]) {
		assert.throws(() => mergeShapes(builtin, user, "/c/shapes.json"), /\/c\/shapes\.json/, JSON.stringify(user));
	}
});

test("shapeSize lists the known shapes when one is unknown", () => {
	const s = mergeShapes(builtin, {});
	assert.deepEqual(shapeSize(s, "small"), { cpus: 2, mem: 4096, disk: 20 });
	assert.throws(() => shapeSize(s, "huge"), { message: "unknown shape 'huge' (have: large, small, standard)" });
	assert.throws(() => shapeSize(s, "__proto__"), /unknown shape/);
});
