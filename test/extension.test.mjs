// pi extension (extension/index.ts) against a stub pi: it must register exactly the shared tool
// table (core/boxery-tools.mjs), the same table the MCP server is built from.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as nodeModule from "node:module"; // namespace import: Node 20 has no registerHooks export
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const canLoad = !!process.features.typescript && typeof nodeModule.registerHooks === "function"; // Node >= 22.18
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
		nodeModule.registerHooks({
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

	it("vm_lease runs on the extension's lease keeper", async () => {
		const { tools } = await load();
		const lease = tools.get("vm_lease");
		assert.deepEqual((await lease.execute("1", { action: "list" }, undefined, undefined, {})).content, [{ type: "text", text: "this session holds no leases" }]);
		await assert.rejects(lease.execute("2", { action: "release", vm: "pool-1" }, undefined, undefined, {}), /holds no lease on pool-1/);
		await assert.rejects(lease.execute("3", { action: "renew" }, undefined, undefined, {}), /invalid VM name/);
	});
});
