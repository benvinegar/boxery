// The vm_* tool surface, defined once. The MCP server (mcp/boxery-mcp.mjs) and the pi extension
// (extension/index.ts) are both built from this table, so names, descriptions and schemas cannot drift.
//
// Entry: { name, title, description, parameters (plain JSON Schema, incl. `vm`), annotations (MCP
// hints), run(vm, args, ctx) → {text, image?, isError?} }. ctx: { signal, current, localCwd }.
//   engine: pi runs this tool with its own built-in engine (same rendering/truncation as bash, read, …)
//   noVm:   the front-end does not resolve a VM; the tool gets every argument (vm_copy, vm_manage)
// vm_manage has no `run`: "current VM" is front-end session state. Each front-end calls
// manageAction() with its own session hooks.
import * as core from "./boxery-core.mjs";

const where = "in a boxery VM (default: the current VM). Relative paths are under /home/agent/project; ~ is /home/agent.";
export const VM_PARAM = { type: "string", description: "VM name (default: the current VM)" };
const SHOT = { screenshot: { type: "boolean", description: "Return a screenshot after the action (default true)" } };
const obj = (properties, required = []) => ({ type: "object", properties: { ...properties, vm: VM_PARAM }, required });

export const MANAGE_ACTIONS = ["list", "new", "fork", "rm", "snap", "snaps", "revert", "use", "none", "grants", "shapes"];

export const TOOLS = [
	{
		name: "vm_bash",
		title: "VM bash",
		engine: "bash",
		description: `Run a bash command ${where} Login shell, user "agent" with passwordless sudo, cwd /home/agent/project. Use rg / fdfind / ls for searching. Output keeps the last ${core.MAX_LINES} lines / ${core.MAX_BYTES / 1024}KB.`,
		parameters: obj({ command: { type: "string" }, timeout: { type: "number", description: "Seconds (default 120)" } }, ["command"]),
		annotations: { destructiveHint: true, openWorldHint: true },
		run: (vm, a, x) => core.bashTool(vm, a, x),
	},
	{
		name: "vm_jobs",
		title: "VM jobs",
		description:
			"Detached command jobs in a VM. start runs a bash command in tmux (survives disconnects), returning a job ID; list returns state/start time/exit code; logs returns a bounded output tail; " +
			"wait observes completion, returning exit_code or timed_out:true. Timeout/cancellation never kills the job. Jobs lost to VM reboot or tmux termination have state lost. Optional vm defaults to the current VM.",
		parameters: obj(
			{
				action: { type: "string", enum: ["start", "list", "logs", "wait"] },
				command: { type: "string", description: "start: bash command, like vm_bash" },
				cwd: { type: "string", description: "start: working directory (default ~/project; relative paths below it)" },
				job: { type: "string", description: "logs/wait: ID returned by start" },
				lines: { type: "integer", minimum: 0, maximum: core.MAX_LINES, description: "logs: last N lines (default 200)" },
				stripAnsi: { type: "boolean", description: "logs: strip terminal escape codes" },
				timeout: { type: "integer", minimum: 1, maximum: 3600, description: "wait: seconds to observe (default 120)" },
			},
			["action"],
		),
		annotations: { destructiveHint: true, openWorldHint: true },
		run: (vm, a, x) => core.jobsTool(vm, a, x),
	},
	{
		name: "vm_read",
		title: "VM read",
		engine: "read",
		description: `Read a file ${where} Images come back as images. offset/limit are 1-based line numbers.`,
		parameters: obj({ path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, ["path"]),
		annotations: { readOnlyHint: true },
		run: (vm, a) => core.readTool(vm, a),
	},
	{
		name: "vm_write",
		title: "VM write",
		engine: "write",
		description: `Create or overwrite a file ${where} Parent directories are created.`,
		parameters: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
		annotations: { destructiveHint: true },
		run: (vm, a) => core.writeTool(vm, a),
	},
	{
		name: "vm_edit",
		title: "VM edit",
		engine: "edit",
		description: `Edit a file ${where} Exact-text replacement: each edits[].oldText must match exactly once in the original file; edits must not overlap.`,
		parameters: obj(
			{
				path: { type: "string" },
				edits: {
					type: "array",
					items: { type: "object", properties: { oldText: { type: "string" }, newText: { type: "string" } }, required: ["oldText", "newText"] },
				},
			},
			["path", "edits"],
		),
		annotations: { destructiveHint: true },
		run: (vm, a) => core.editTool(vm, a),
	},
	{
		name: "vm_copy",
		title: "VM copy",
		noVm: true,
		description:
			"Copy a file or directory between the machine this agent runs on and a VM, or between VMs. Locations: `local:/path` (this machine), `NAME:/path` (a VM on the current host), " +
			"`HOST/NAME:/path` (a VM on another registered host), or a bare path (= current VM). Directories copy recursively. Example: from `local:./notes.md` to `notes.md`.",
		parameters: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
		annotations: { destructiveHint: true },
		run: (_vm, a, x) => core.copyTool(a, { current: a.vm ?? x.current, localCwd: x.localCwd, signal: x.signal }),
	},
	{
		name: "vm_screenshot",
		title: "VM screenshot",
		description: "Screenshot of a VM's desktop (DISPLAY=:1).",
		parameters: obj({}),
		annotations: { readOnlyHint: true },
		run: (vm) => core.screenshot(vm),
	},
	{
		name: "vm_click",
		title: "VM click",
		description: "Click at (x, y), in screenshot pixels, on a VM's desktop.",
		parameters: obj(
			{
				x: { type: "number" },
				y: { type: "number" },
				button: { type: "string", enum: ["left", "right", "middle"], description: "default left" },
				double: { type: "boolean", description: "Double-click" },
				...SHOT,
			},
			["x", "y"],
		),
		annotations: { destructiveHint: true },
		run: (vm, a) => core.click(vm, a),
	},
	{
		name: "vm_type",
		title: "VM type",
		description: "Type text into the focused window on a VM's desktop.",
		parameters: obj({ text: { type: "string" }, ...SHOT }, ["text"]),
		annotations: { destructiveHint: true },
		run: (vm, a) => core.typeText(vm, a),
	},
	{
		name: "vm_key",
		title: "VM key",
		description: 'Press keys on a VM\'s desktop, xdotool syntax, space-separated: "Return", "ctrl+l", "ctrl+shift+t", "Escape".',
		parameters: obj({ keys: { type: "string" }, ...SHOT }, ["keys"]),
		annotations: { destructiveHint: true },
		run: (vm, a) => core.pressKeys(vm, a),
	},
	{
		name: "vm_scroll",
		title: "VM scroll",
		description: "Scroll at (x, y), in screenshot pixels, on a VM's desktop.",
		parameters: obj(
			{
				x: { type: "number" },
				y: { type: "number" },
				direction: { type: "string", enum: ["up", "down", "left", "right"] },
				amount: { type: "number", description: "Wheel clicks (default 5)" },
				...SHOT,
			},
			["x", "y", "direction"],
		),
		annotations: {},
		run: (vm, a) => core.scroll(vm, a),
	},
	{
		name: "vm_browser",
		title: "VM browser",
		description:
			"Drive Google Chrome on a VM's desktop with Playwright (the user can watch it). `code` is the body of an async function receiving (page, context, browser); its return value comes back as JSON. " +
			"Chrome starts if needed and keeps state between calls. Example: `await page.goto('https://example.com'); return await page.title();`",
		parameters: obj(
			{
				code: { type: "string" },
				screenshot: { type: "boolean", description: "Also return a screenshot of the page (default false)" },
				timeout: { type: "number", description: "Seconds (default 60)" },
			},
			["code"],
		),
		annotations: { destructiveHint: true, openWorldHint: true },
		run: (vm, a, x) => core.browser(vm, a, x),
	},
	{
		name: "vm_manage",
		title: "VM manage",
		noVm: true,
		description:
			`Manage boxery VMs (Ubuntu desktop VMs on the user's VM host). action: ${MANAGE_ACTIONS.join(" | ")}. ` +
			"`shapes` lists the VM sizes (cpus/mem/disk) the host offers; pass `shape` to `new`/`fork` when a task needs more (or less) than the default. " +
			"`fork` copies VM `name` (running or not, ~10 s) into new VMs `to` (name or list; default one generated name) on the same host; each copy has the disk (not running processes) and its own identity. " +
			"`use` makes NAME the current VM (default for all vm_* tools; created if missing); `none` clears it; `new` creates a VM (with use=true also selects it); " +
			"`grants` shows what the VM may access from the user's machine (only the user can change grants).",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: MANAGE_ACTIONS },
				name: { type: "string" },
				snapshot: { type: "string", description: "snapshot name for snap/revert" },
				to: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "for fork: new VM name(s)" },
				use: { type: "boolean", description: "for new: also make it the current VM" },
				shape: { type: "string", description: "for new/fork: VM size by name (see action:'shapes'); default: the host's default shape (fork: the source's size)" },
			},
			required: ["action"],
		},
		annotations: { destructiveHint: true },
	},
];

/**
 * vm_manage, given a front-end's "current VM" session:
 *   s.current            the current VM name (or null)
 *   s.use(name)          select an existing-or-new VM as current (create, apply grants)
 *   s.adopt(name)        mark a VM that was just created as current
 *   s.clear()            no current VM
 *   s.removing?(name)    before rm (may throw to refuse); s.removed?(name) after it
 *   s.listNote           appended to the list output
 */
export async function manageAction(a, s) {
	switch (a.action) {
		case "use": {
			const name = core.assertName(a.name);
			await s.use(name);
			return { text: `current VM: ${name}` };
		}
		case "none":
			s.clear();
			return { text: "no current VM" };
		case "list":
			return { text: `${await core.manage(a)}\ncurrent: ${s.current ?? "(none)"}${s.listNote ?? ""}` };
		case "new": {
			const name = a.name ? core.assertName(a.name) : core.newName();
			const out = await core.manage({ ...a, name });
			if (a.use) s.adopt(name);
			return { text: `${out}${a.use ? `\ncurrent VM: ${name}` : ""}` };
		}
		case "rm": {
			await s.removing?.(a.name);
			const out = await core.manage(a);
			s.removed?.(a.name);
			return { text: out };
		}
		default:
			return { text: await core.manage(a) };
	}
}
