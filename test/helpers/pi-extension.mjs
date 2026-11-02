// Test helper: load extension/index.ts against a stub pi, recording what it registers. Set BOXERY_HOME
// and BOXERY_BIN before the first load: core reads them at import.
import * as nodeModule from "node:module"; // namespace import: Node < 22.15 has no registerHooks export

/** Loading .ts needs TypeScript stripping and module.registerHooks (Node >= 22.18). */
export const canLoad = !!process.features.typescript && typeof nodeModule.registerHooks === "function";

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

let hooked = false;

/** A fresh extension instance: its tools, flags, /commands, event handlers and session entries. flags: values getFlag returns. */
export async function loadExtension(flags = {}) {
	if (!hooked) {
		nodeModule.registerHooks({
			resolve: (spec, ctx, next) => (spec === "@earendil-works/pi-coding-agent" ? { url: PI_STUB, shortCircuit: true } : next(spec, ctx)),
		});
		hooked = true;
	}
	const tools = new Map();
	const flagDefs = new Map();
	const commands = new Map();
	const handlers = new Map();
	const entries = [];
	const pi = {
		registerFlag: (name, def) => flagDefs.set(name, def),
		registerCommand: (name, def) => commands.set(name, def),
		on: (event, fn) => handlers.set(event, fn),
		getFlag: (name) => flags[name],
		appendEntry: (type, data) => entries.push({ type, data }),
		registerTool: (t) => tools.set(t.name, t),
	};
	(await import("../../extension/index.ts")).default(pi);
	return { tools, flags: flagDefs, commands, handlers, entries };
}
