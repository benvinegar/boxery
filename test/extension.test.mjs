// pi extension (extension/index.ts) against a stub pi: it must register exactly the shared tool
// table (core/boxery-tools.mjs), the same table the MCP server is built from.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const canLoad = !!process.features.typescript && typeof registerHooks === "function"; // Node >= 22.18
process.env.BOXERY_HOME = mkdtempSync(path.join(tmpdir(), "boxery-ext-")); // no real controller config

// Stand-in for @earendil-works/pi-coding-agent: tool engines with their own parameter schemas.
const PI_STUB = `data:text/javascript,${encodeURIComponent(`
	const engine = (kind) => () => ({
		parameters: { type: "object", properties: { engine: { const: kind } }, required: [] },
		renderCall() {}, renderResult() {},
		async execute(_id, args) { return { content: [{ type: "text", text: kind + ":" + JSON.stringify(args) }] }; },
	});
	export const createBashToolDefinition = engine("bash");
	export const createReadToolDefinition = engine("read");
	export const createWriteToolDefinition = engine("write");
	export const createEditToolDefinition = engine("edit");
`)}`;

describe("pi extension", { skip: !canLoad && "needs Node >= 22.18 (TypeScript stripping + module.registerHooks)" }, () => {
	async function load() {
		registerHooks({
			resolve: (spec, ctx, next) => (spec === "@earendil-works/pi-coding-agent" ? { url: PI_STUB, shortCircuit: true } : next(spec, ctx)),
		});
		const tools = new Map();
		const entries = [];
		const pi = {
			registerFlag() {},
			registerCommand() {},
			on() {},
			getFlag() {},
			appendEntry: (type, data) => entries.push({ type, data }),
			registerTool: (t) => tools.set(t.name, t),
		};
		(await import("../extension/index.ts")).default(pi);
		return { tools, entries };
	}

	it("registers the shared tool table, with pi engines for bash/read/write/edit", async () => {
		const { TOOLS } = await import("../core/boxery-tools.mjs");
		const { tools } = await load();
		assert.deepEqual([...tools.keys()], TOOLS.map((t) => t.name));
		for (const shared of TOOLS) {
			const t = tools.get(shared.name);
			assert.equal(t.description, shared.description, t.name);
			if (shared.engine) {
				assert.deepEqual(t.parameters.properties.engine, { const: shared.engine }, `${t.name} uses pi's ${shared.engine} engine`);
				assert.deepEqual(t.parameters.properties.vm, shared.parameters.properties.vm, `${t.name} takes vm`);
			} else {
				assert.deepEqual(t.parameters, shared.parameters, t.name);
			}
		}
	});

	it("vm_manage keeps the current VM in pi session state", async () => {
		const { tools, entries } = await load();
		const r = await tools.get("vm_manage").execute("1", { action: "none" }, undefined, undefined, {});
		assert.deepEqual(r.content, [{ type: "text", text: "no current VM" }]);
		assert.deepEqual(entries.at(-1), { type: "boxery-current", data: { vm: null } });
		await assert.rejects(tools.get("vm_click").execute("2", { x: 1, y: 1 }, undefined, undefined, {}), /no current VM/i);
	});
});
