// Front-end parity: the MCP server (mcp/boxery-mcp.mjs) and the pi extension (extension/index.ts) are two
// front-ends for one tool table (core/boxery-tools.mjs). Every tool, action, schema and description comes
// from the table, and every tool runs through its runTool(), so a capability added for one front-end
// reaches the other. Anything a front-end offers beyond the table must be listed here with the reason the
// other one can't have it; this test fails until it is.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, describe, it, test } from "node:test";
import { registerHost } from "./fixtures/register-host.mjs";
import { canLoad, loadExtension } from "./helpers/pi-extension.mjs";

// Tools only the MCP server lists, and why pi doesn't get them.
const MCP_ONLY = {
	vm_view: "an MCP Apps page rendered inside the chat; pi has no app renderer (it has /vm desktop instead)",
	vm_view_frame: "the app-only frame source behind vm_view",
};
// Tools only the pi extension registers, and why MCP doesn't get them.
const PI_ONLY = {};

const HOME = mkdtempSync(path.join(tmpdir(), "boxery-frontends-"));
process.env.BOXERY_HOME = HOME;
registerHost(HOME);
// After BOXERY_HOME: core reads it at import (a static import would see the developer's real registry).
const { TOOLS } = await import("../core/boxery-tools.mjs");

/** initialize instructions and tools/list from a stdio server that offers vm_view too (--ui), so MCP_ONLY can be checked. */
async function mcpServer() {
	const p = spawn(process.execPath, [path.resolve(import.meta.dirname, "../mcp/boxery-mcp.mjs"), "--ui"], { env: process.env, stdio: ["pipe", "pipe", "ignore"] });
	let buf = "";
	const replies = new Map();
	p.stdout.on("data", (d) => {
		buf += d;
		for (let nl; (nl = buf.indexOf("\n")) >= 0; buf = buf.slice(nl + 1)) {
			const msg = JSON.parse(buf.slice(0, nl));
			replies.get(msg.id)?.(msg);
		}
	});
	const call = (id, method, params) => new Promise((resolve) => (replies.set(id, resolve), p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)));
	try {
		const init = /** @type {any} */ (await call(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
		const list = /** @type {any} */ (await call(2, "tools/list", {}));
		return { instructions: init.result.instructions, tools: list.result.tools };
	} finally {
		p.kill();
	}
}

const byName = (/** @type {{ name: string }[]} */ list) => new Map(list.map((t) => [t.name, t]));

describe("front-ends", () => {
	/** @type {Map<string, any>} */ let mcp;
	/** @type {string} */ let instructions;
	before(async () => {
		const server = await mcpServer();
		mcp = byName(server.tools);
		instructions = server.instructions;
	});

	it("every shared tool runs through the table, not front-end code", () => {
		for (const t of TOOLS) assert.equal(typeof t.run, "function", `${t.name} has no run: front-ends would each implement it`);
		for (const t of TOOLS) assert.ok(t.parameters.properties.host, `${t.name} takes host`);
	});

	it("MCP lists exactly the shared table, plus what MCP_ONLY explains", () => {
		assert.deepEqual([...mcp.keys()].filter((n) => !(n in MCP_ONLY)), TOOLS.map((t) => t.name), "MCP lists a tool the table doesn't: add it to the table, or to MCP_ONLY with why pi can't have it");
		for (const n of Object.keys(MCP_ONLY)) assert.ok(mcp.has(n), `MCP_ONLY lists ${n}, which MCP no longer has`);
		for (const shared of TOOLS) {
			const t = mcp.get(shared.name);
			assert.equal(t.description, shared.description, `${t.name}: MCP changed the description`);
			assert.deepEqual(t.inputSchema, shared.parameters, `${t.name}: MCP changed the schema`);
		}
		for (const n of Object.keys(MCP_ONLY)) assert.ok(mcp.get(n).inputSchema.properties.host, `${n} takes host`);
	});

	it("pi registers exactly the shared table, plus what PI_ONLY explains", { skip: !canLoad && "needs Node >= 22.18 (TypeScript stripping + module.registerHooks)" }, async () => {
		const pi = (await loadExtension()).tools;
		assert.deepEqual([...pi.keys()].filter((n) => !(n in PI_ONLY)), TOOLS.map((t) => t.name), "pi registers a tool the table doesn't: add it to the table, or to PI_ONLY with why MCP can't have it");
		for (const shared of TOOLS) {
			const t = pi.get(shared.name);
			assert.equal(t.description, shared.description, `${t.name}: pi changed the description`);
			if (!shared.engine) {
				assert.deepEqual(t.parameters, shared.parameters, `${t.name}: pi changed the schema`);
				continue;
			}
			// pi's own engine supplies the schema (same as its built-in tool); boxery adds the target.
			assert.deepEqual(t.parameters.properties.engine, { const: shared.engine }, `${t.name} uses pi's ${shared.engine} engine`);
			assert.deepEqual(t.parameters.properties.vm, shared.parameters.properties.vm, `${t.name} takes vm`);
			assert.deepEqual(t.parameters.properties.host, shared.parameters.properties.host, `${t.name} takes host`);
		}
	});

	it("both give the agent the same standing guidance, naming the session's host", { skip: !canLoad && "needs Node >= 22.18 (TypeScript stripping + module.registerHooks)" }, async () => {
		const { handlers } = await loadExtension();
		const section = {};
		await handlers.get("before_agent_start")({ systemPromptOptions: { sections: section } });
		const hostLine = /^Current host: test\. .*Every vm_\* tool accepts optional host.*$/m;
		assert.match(section.boxery, hostLine, "pi");
		assert.match(instructions, hostLine, "MCP");
	});
});

test("agents' front ends (core, MCP, pi) never run the controller CLI", () => {
	// The CLI (controller/) is a front end of core, never the other way round.
	for (const dir of ["core", "mcp", "extension"]) {
		for (const f of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
			if (!/\.(mjs|ts)$/.test(f)) continue;
			// (Code only: comments may say what the CLI does.)
			const src = readFileSync(new URL(`../${dir}/${f}`, import.meta.url), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
			assert.doesNotMatch(src, /controller\/(boxery|cli\.mjs)|["'`]\.\.\/controller\//, `${dir}/${f} reaches into controller/`);
		}
	}
});
