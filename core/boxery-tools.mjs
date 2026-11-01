// The vm_* tool surface, defined once. The MCP server (mcp/boxery-mcp.mjs) and the pi extension
// (extension/index.ts) are both built from this table, so names, descriptions and schemas cannot drift.
//
// Entry: { name, title, description, parameters (plain JSON Schema, incl. `vm`), annotations (MCP
// hints), outputSchema? (MCP structuredContent), run(vm, args, ctx) → {text, image?, structured?, isError?} }.
// ctx: { signal, current, localCwd, progress? }. progress(message) reports a status line while the
// tool runs (MCP progress notifications); front-ends without it pass nothing.
//   engine: pi runs this tool with its own built-in engine (same rendering/truncation as bash, read, …)
//   noVm:   the front-end does not resolve a VM; the tool gets every argument, `vm` included
//           (vm_copy, vm_manage, vm_info, vm_lease)
// vm_manage and vm_lease have no `run`: "current VM" and held leases are front-end session state.
// Each front-end calls manageAction() / leaseAction() with its own session hooks.
import * as core from "./boxery-core.mjs";

const where = "in a boxery VM (default: the current VM). Relative paths are under /home/agent/project; ~ is /home/agent.";
export const VM_PARAM = { type: "string", description: "VM name (default: the current VM)" };
const SHOT = { screenshot: { type: "boolean", description: "Return a screenshot after the action (default true)" } };
const obj = (properties, required = []) => ({ type: "object", properties: { ...properties, vm: VM_PARAM }, required });

export const LEASE_ACTIONS = ["acquire", "renew", "release", "list"];
export const MANAGE_ACTIONS = ["new", "fork", "rm", "start", "stop", "resize", "snap", "snap-rm", "revert", "use", "none"];
const SIZE = (unit, min) => ({ type: "integer", minimum: min, description: `for new/fork/resize: ${unit}; overrides the shape's value` });
export const INFO_ACTIONS = ["list", "shapes", "grants", "snaps", "images", "version"];

const INFO_OUTPUT = {
	type: "object",
	properties: {
		vms: { type: "array", items: { type: "object" }, description: "list: VMs on the host" },
		current: { type: ["string", "null"], description: "list: the current VM" },
		default: { type: "string", description: "shapes: the default shape" },
		shapes: { type: "object", description: "shapes: {NAME: {cpus, mem (MiB), disk (GiB)}}" },
		vm: { type: "string", description: "grants/snaps: the VM" },
		grants: { type: "array", items: { type: "object" } },
		snapshots: { type: "array", items: { type: "object" } },
		images: { type: "array", items: { type: "object" }, description: "images: [{image (VM@SNAP), created, size}], every snapshot on the host" },
		controller: {
			type: "object",
			description: "version: this controller's {version, describe}; describe is `git describe --tags --always --dirty` of a git checkout, null for npm installs",
		},
		host: {
			anyOf: [{ type: "object" }, { type: "string" }, { type: "null" }],
			description: "version: the host's {name, version, describe, install}, describe as for controller (null if the host predates versions)",
		},
		behind: { type: "boolean", description: "version: the host is older than the controller" },
	},
};

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
		description: core.JOBS_DESCRIPTION,
		parameters: obj(
			{
				action: { type: "string", enum: ["start", "list", "logs", "wait", "kill"] },
				command: { type: "string", description: "start: bash command line, like vm_bash" },
				cwd: { type: "string", description: "start: working directory (default ~/project; relative paths below it)" },
				job: { type: "string", description: "logs/wait/kill: ID returned by start" },
				lines: { type: "integer", minimum: 0, maximum: core.MAX_LINES, description: "logs: last N lines (default 200); wait: output lines to include (default 20)" },
				stripAnsi: { type: "boolean", description: "logs: strip terminal escape codes" },
				timeout: { type: "integer", minimum: 0, maximum: 600, description: "wait: seconds to observe (default 60; 0 = check once)" },
				grace: { type: "integer", minimum: 0, maximum: 60, description: "kill: seconds between SIGTERM and SIGKILL (default 5)" },
			},
			["action"],
		),
		annotations: { destructiveHint: true, openWorldHint: true },
		outputSchema: core.JOBS_OUTPUT,
		run: (vm, a, x) => core.jobsTool(vm, a, x),
	},
	{
		name: "vm_read",
		title: "VM read",
		engine: "read",
		description: `Read a file ${where} Images come back as images. offset/limit are 1-based line numbers.`,
		parameters: obj({ path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, ["path"]),
		annotations: { readOnlyHint: true, openWorldHint: false },
		run: (vm, a) => core.readTool(vm, a),
	},
	{
		name: "vm_write",
		title: "VM write",
		engine: "write",
		description: `Create or overwrite a file ${where} Parent directories are created.`,
		parameters: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
		run: (vm, a) => core.writeTool(vm, a),
	},
	{
		name: "vm_edit",
		title: "VM edit",
		engine: "edit",
		description: `Edit a file ${where} Exact-text replacement: each edits[].oldText must match exactly once in the original file, and edits must not overlap. If it fails with a conflict (the file changed meanwhile), reread the file and retry.`,
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
		annotations: { destructiveHint: true, openWorldHint: false },
		run: (vm, a, x) => core.editTool(vm, a, x),
	},
	{
		name: "vm_copy",
		title: "VM copy",
		noVm: true,
		description:
			"Copy a file or directory between the machine this agent runs on and a VM, or between VMs. Locations: `local:/path` (this machine), `NAME:/path` (a VM on the current host), " +
			"`HOST/NAME:/path` (a VM on another registered host), or a bare path (= current VM). Directories copy recursively. Example: from `local:./notes.md` to `notes.md`.",
		parameters: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
		annotations: { destructiveHint: true, openWorldHint: false },
		run: (_vm, a, x) => core.copyTool(a, { current: a.vm ?? x.current, localCwd: x.localCwd, signal: x.signal }),
	},
	{
		name: "vm_screenshot",
		title: "VM screenshot",
		description: "Screenshot of a VM's desktop (DISPLAY=:1).",
		parameters: obj({}),
		annotations: { readOnlyHint: true, openWorldHint: false },
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
			`Create, change and select boxery VMs (Ubuntu desktop VMs on the user's VM host). action: ${MANAGE_ACTIONS.join(" | ")}. ` +
			"`vm` is the VM to act on (`new`: the new VM's name, default generated; `fork`: the source). " +
			"`new` creates a VM (with use:true also selects it); pass `shape` (see vm_info shapes) or cpus/mem/disk when a task needs more (or less) than the default, and `from:'VM@SNAP'` to create it from an image (see vm_info images). " +
			"`new` with `headless:true` creates a VM without the desktop (shell, git, node, pi, opencode only; the computer-use tools and vm_browser refuse it): use it when a task needs no GUI or browser. A VM from an image or a fork keeps its source's kind. " +
			"`fork` copies VM `vm` (running or not, ~10 s) into new VMs `to` (name or list; default one generated name) on the same host; each copy has the disk (not running processes) and its own identity. " +
			"`resize` changes an existing VM's cpus/mem/disk (disk only grows); a running VM restarts, so its processes and jobs end. `start`/`stop` power a VM on/off; disk state is kept. " +
			"`snap` snapshots VM `vm` (as `snapshot`, optional); `revert` restores snapshot `snapshot` and `snap-rm` deletes it (see vm_info snaps). " +
			"`use` makes `vm` the current VM (default for all vm_* tools; created if missing); `none` clears it.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: MANAGE_ACTIONS },
				vm: { type: "string", description: "the VM to act on; new: the new VM's name (default: generated); fork: the source VM" },
				snapshot: { type: "string", description: "snapshot name for snap/revert/snap-rm" },
				from: { type: "string", description: "for new: image to create the VM from, VM@SNAP (see vm_info images)" },
				headless: { type: "boolean", description: "for new: no desktop (default false: XFCE desktop, Chrome, computer use)" },
				to: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "for fork: new VM name(s)" },
				use: { type: "boolean", description: "for new: also make it the current VM" },
				shape: { type: "string", description: "for new/fork: VM size by name (see vm_info shapes); default: the host's default shape (fork: the source's size)" },
				cpus: SIZE("vCPUs", 1),
				mem: SIZE("memory in MiB", 512),
				disk: SIZE("disk in GiB (resize: only grows)", 1),
			},
			required: ["action"],
		},
		annotations: { destructiveHint: true, openWorldHint: false },
	},
	{
		name: "vm_info",
		title: "VM info",
		noVm: true,
		description:
			`Read-only lookups about boxery VMs. action: ${INFO_ACTIONS.join(" | ")}. ` +
			"`list` shows the VMs on the host and the current VM; `shapes` the VM sizes the host offers; `grants` what VM `vm` may access from the user's machine (only the user can change grants); `snaps` the snapshots of VM `vm`; `images` every snapshot on the host as VM@SNAP (what vm_manage new takes as `from`); " +
			"`version` the controller's and host's boxery versions. If the host is behind, tell the user: upgrading it is theirs to run (`boxery upgrade-host`). " +
			"`vm` defaults to the current VM.",
		parameters: {
			type: "object",
			properties: { action: { type: "string", enum: INFO_ACTIONS }, vm: { type: "string", description: "grants/snaps: the VM (default: the current VM)" } },
			required: ["action"],
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
		outputSchema: INFO_OUTPUT,
		run: (_vm, a, x) => infoAction(a, x),
	},
	{
		name: "vm_lease",
		title: "VM lease",
		noVm: true,
		description:
			"Lease a VM from the host's shared pool (VMs an admin set aside for agents, CI and other users). action: acquire | renew | release | list. " +
			"`acquire` waits up to `wait` seconds for a free pool VM, leases it for `ttl` seconds and (unless use=false) makes it the current VM. " +
			"Leases are exclusive and renewed automatically while this session is active; they end when released, when the session ends, or if renewal stops. " +
			"When a lease ends the VM is reset to its clean image and everything done in it is lost: copy results out (vm_copy, git push) before `release`. " +
			"`list` shows this session's leases; `renew`/`release` take `vm` (default: the current VM). A leased VM cannot be removed with vm_manage rm.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: LEASE_ACTIONS },
				vm: { type: "string", description: "renew/release: the leased VM (default: the current VM)" },
				ttl: { type: "integer", minimum: core.LEASE_TTL.min, maximum: core.LEASE_TTL.max, description: `acquire/renew: lease length in seconds (default ${core.LEASE_TTL.default})` },
				wait: { type: "integer", minimum: 0, maximum: 3600, description: "acquire: seconds to wait for a free VM (default 60)" },
				use: { type: "boolean", description: "acquire: make the leased VM the current VM (default true)" },
			},
			required: ["action"],
		},
		annotations: { destructiveHint: true },
	},
];

/**
 * vm_info: read-only lookups. ctx.current is the current VM; ctx.listNote is appended to list output;
 * ctx.hostName names the host (MCP routes named hosts through the controller as its legacy profile).
 */
export async function infoAction(a, { current, listNote, hostName } = {}) {
	const target = () => {
		const vm = a.vm ?? current;
		if (!vm) throw new Error("No VM given and no current VM. Pass `vm`.");
		return core.assertName(vm);
	};
	switch (a.action) {
		case "list": {
			const vms = await core.listVms();
			return { text: `${core.formatVms(vms)}\ncurrent: ${current ?? "(none)"}${listNote ?? ""}`, structured: { vms, current: current ?? null } };
		}
		case "shapes": {
			const shapes = await core.listShapes();
			return { text: core.formatShapes(shapes), structured: shapes };
		}
		case "grants": {
			const vm = target();
			const grants = await core.boxeryJson(["grants", vm]);
			return { text: core.formatGrants(vm, grants), structured: { vm, grants } };
		}
		case "snaps": {
			const vm = target();
			const snapshots = await core.listSnaps(vm);
			return { text: core.formatSnaps(vm, snapshots), structured: { vm, snapshots } };
		}
		case "images": {
			const images = await core.listImages();
			return { text: core.formatImages(images), structured: { images } };
		}
		case "version": {
			const v = await core.versions();
			if (hostName && v.host) v.host = { ...v.host, name: hostName };
			return { text: core.formatVersions(v), structured: v };
		}
		default:
			throw new Error(`unknown action ${a.action}`);
	}
}

/**
 * vm_manage, given a front-end's "current VM" session:
 *   s.use(name)          select an existing-or-new VM as current (create, apply grants)
 *   s.adopt(name)        mark a VM that was just created as current
 *   s.clear()            no current VM
 *   s.removing?(name)    before rm (may throw to refuse); s.removed?(name) after it
 *   s.keeper?            the session's core.LeaseKeeper: leased VMs cannot be removed
 *   s.progress?(message) status lines from long controller operations (MCP progress)
 */
export async function manageAction(a, s) {
	switch (a.action) {
		case "use": {
			const vm = core.needVm(a);
			await s.use(vm);
			return { text: `current VM: ${vm}` };
		}
		case "none":
			s.clear();
			return { text: "no current VM" };
		case "new": {
			const vm = a.vm ? core.assertName(a.vm) : core.newName();
			const out = await core.manage({ ...a, vm }, { progress: s.progress });
			if (a.use) s.adopt(vm);
			return { text: `${out}${a.use ? `\ncurrent VM: ${vm}` : ""}` };
		}
		case "rm": {
			const vm = core.needVm(a);
			if (s.keeper?.find(vm)) throw new Error(`${vm} is leased from the pool; release it with vm_lease {action:"release"}`);
			await s.removing?.(vm);
			const out = await core.manage(a, { progress: s.progress });
			s.removed?.(vm);
			return { text: out };
		}
		default:
			if (INFO_ACTIONS.includes(a.action)) throw new Error(`vm_manage has no ${a.action}; use vm_info {action:"${a.action}"}`);
			return { text: await core.manage(a, { progress: s.progress }) };
	}
}

/**
 * vm_lease, given a front-end session: s.keeper (core.LeaseKeeper), s.current (the current VM name
 * or null), and s.adopt(name) and s.clear() as for manageAction.
 */
export async function leaseAction(a, s) {
	const target = () => core.assertName(a.vm ?? s.current ?? "");
	switch (a.action) {
		case "acquire": {
			const l = await s.keeper.acquire({ ttl: a.ttl ?? undefined, wait: a.wait ?? undefined });
			if (a.use !== false) s.adopt(l.name);
			return { text: `leased ${l.name} (lease ${l.id}, ttl ${l.ttl}s, renewed automatically while this session is active)${a.use !== false ? `\ncurrent VM: ${l.name}` : ""}` };
		}
		case "renew": {
			const l = await s.keeper.renew(target(), a.ttl ?? undefined);
			return { text: `renewed ${l.name} for ${l.ttl}s` };
		}
		case "release": {
			const name = target();
			await s.keeper.release(name);
			const wasCurrent = s.current === name;
			if (wasCurrent) s.clear();
			return { text: `released ${name}; the host resets it to its clean image${wasCurrent ? "\nno current VM" : ""}` };
		}
		case "list":
			return { text: core.formatLeases(s.keeper.list(), s.current) };
		default:
			throw new Error(`unknown action ${a.action}`);
	}
}
