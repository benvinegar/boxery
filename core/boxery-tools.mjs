// The vm_* tool surface, defined once. The MCP server (mcp/boxery-mcp.mjs) and the pi extension
// (extension/index.ts) are both built from this table, so names, descriptions, schemas and behavior
// cannot drift: test/frontends.test.mjs fails when either one lists something the table doesn't.
//
// Entry: { name, title, description, parameters (plain JSON Schema, incl. `vm` and `host`), annotations (MCP
// hints), outputSchema? (MCP structuredContent), run(vm, args, ctx) → {text, image?, structured?, isError?} }.
// Front-ends call runTool(), which resolves the call's host and VM against their Session and runs the
// tool on that host. ctx: { signal, session, host, current, localCwd, localCopy?, progress?, approve? }.
// progress(message) reports a status line while the tool runs (MCP progress notifications); front-ends
// without it pass nothing. localCopy limits vm_copy's local: endpoints (see copyTool); front-ends that run
// on the user's own machine pass nothing.
//   engine: pi runs this tool with its own built-in engine (same rendering/truncation as bash, read, …)
//   noVm:   the front-end does not resolve a VM; the tool gets every argument, `vm` included
//           (vm_copy, vm_manage, vm_info, vm_lease)
// "Current VM", the session's host and held leases are front-end state: vm_manage and vm_lease change
// them only through the Session hooks.
import * as core from "./boxery-core.mjs";
/** @import { Approve, HostProfile, LocalConfinement, ManageArgs, Progress, ToolResult } from "./boxery-core.mjs" */
/** A JSON Schema fragment. @typedef {{ type?: string | string[], description?: string, enum?: readonly string[], properties?: Record<string, JsonSchema>, items?: JsonSchema, required?: string[], anyOf?: JsonSchema[], minimum?: number, maximum?: number }} JsonSchema */
/** A tool's input schema: always an object with named properties. @typedef {JsonSchema & { type: "object", properties: Record<string, JsonSchema>, required: string[] }} ObjectSchema */
/** MCP tool annotations (hints). @typedef {{ title?: string, readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }} ToolAnnotations */
/** What every front-end passes runTool (see the header). @typedef {{ signal?: AbortSignal, localCwd?: string, localCopy?: LocalConfinement | false, progress?: Progress, approve?: Approve }} ToolContext */
/** What run gets: the front-end's context plus the call's session, host and (on that host) current VM. @typedef {ToolContext & { session: Session, host: HostProfile, current: string | null }} RunContext */
/**
 * One TOOLS entry (see the header). A front-end may extend the context (X); noVm tools get vm = null.
 * @template [X=RunContext]
 * @typedef {{ name: string, title: string, description: string, engine?: "bash" | "read" | "write" | "edit", noVm?: boolean, parameters: ObjectSchema,
 *   outputSchema?: JsonSchema, annotations: ToolAnnotations, run: (vm: string, args: any, ctx: X) => Promise<ToolResult> }} Tool
 */
/**
 * What a front-end keeps for one agent session, and the hooks the shared actions change it through.
 * host: the session's host (calls without `host` use it). current/currentHost: the current VM and the host it
 * belongs to (a VM name means nothing without its host). keeper: the session's pool leases.
 *   adopt(name, host)      make VM `name` on `host` current; `host` becomes the session's host
 *   clear()                no current VM (the session's host stays)
 *   selectHost(host)       make `host` the session's host, with no current VM
 *   removing?(name, host)  before vm_manage rm of the current VM (may throw to refuse); it is cleared after
 * @typedef {{ host: HostProfile, current: string | null, currentHost: HostProfile | null, keeper: core.LeaseKeeper,
 *   adopt: (name: string, host: HostProfile) => void, clear: () => void, selectHost: (host: HostProfile) => void,
 *   removing?: (name: string, host: HostProfile) => Promise<void> | void }} Session
 */

const where = "in a boxery VM (default: the current VM). Relative paths are under /home/agent/project; ~ is /home/agent.";
export const VM_PARAM = { type: "string", description: "VM name (default: the current VM)" };
export const HOST_PARAM = {
	type: "string",
	description: "Registered host name (see vm_info {action:\"hosts\"} for where each runs); default: this session's host. " +
		"Names registered for the same profile directory (hosts shows same_as) are the same host.",
};
const SHOT = { screenshot: { type: "boolean", description: "Return a screenshot after the action (default true)" } };
/** @param {Record<string, JsonSchema>} properties @param {string[]} [required] @returns {ObjectSchema} */
const obj = (properties, required = []) => ({ type: "object", properties: { ...properties, vm: VM_PARAM, host: HOST_PARAM }, required });

export const LEASE_ACTIONS = ["acquire", "renew", "release", "list"];
export const MANAGE_ACTIONS = ["new", "fork", "rm", "start", "stop", "resize", "snap", "snap-rm", "revert", "use", "none", "build-base", "host", "host_add", "host_rm"];
const BACKENDS = "libvirt | lima | cloud-hypervisor | exe | boat";
const SIZE = (/** @type {string} */ unit, /** @type {number} */ min) => ({ type: "integer", minimum: min, description: `for new/fork/resize: ${unit}; overrides the shape's value` });
export const INFO_ACTIONS = ["list", "shapes", "grants", "snaps", "images", "version", "hosts"];

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
			description: "list: the host's name; version: the host's {name, version, describe, install}, describe as for controller (null if the host predates versions)",
		},
		behind: { type: "boolean", description: "version: the host is older than the controller" },
		hosts: {
			type: "array",
			description: "hosts: registered hosts, by name. Read from local profile files only; no host is contacted.",
			items: {
				type: "object",
				properties: {
					name: { type: "string", description: "Host name for the host parameter" },
					destination: { type: ["string", "null"], description: "Where its VM host runs: \"local\" (the machine running this agent's controller) or the ssh destination (user@host or ssh-config alias); null if the profile has no destination set or it can't be read without executing the config" },
					backend: { type: ["string", "null"], description: "VM backend (lima, libvirt, cloud-hypervisor, exe, boat, …) as recorded by `boxery setup` or `boxery --host NAME backend`; null if never recorded" },
					current: { type: "boolean", description: "This session's host (used when host is omitted)" },
					default: { type: "boolean", description: "The controller's default (default-host); new sessions start here unless started with another host" },
					same_as: { type: "array", items: { type: "string" }, description: "Other names whose profile is the same directory, i.e. the same host and VMs" },
					dir: { type: "string", description: "Profile directory (config, ssh_config, grants)" },
				},
				required: ["name", "destination", "backend", "current", "default", "same_as", "dir"],
			},
		},
	},
};

/** @type {Tool[]} */
export const TOOLS = [
	{
		name: "vm_bash",
		title: "VM bash",
		engine: "bash",
		description: `Run a bash command ${where} Login shell, user "agent" with passwordless sudo, cwd /home/agent/project. Use rg / fdfind / ls for searching. Start GUI programs detached (\`setsid nohup prog >/dev/null 2>&1 &\`), or the call waits until they exit. Output keeps the last ${core.MAX_LINES} lines / ${core.MAX_BYTES / 1024}KB.`,
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
			"`HOST/NAME:/path` (a VM on another registered host), or a bare path (= current VM). Directories copy recursively. Example: from `local:./notes.md` to `notes.md`. " +
			"Never use it for credentials (tokens, .npmrc, auth files, .env): a copy lands on the VM's disk and in its snapshots. Request them with vm_grant.",
		parameters: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
		annotations: { destructiveHint: true, openWorldHint: false },
		run: (_vm, a, x) => core.copyTool(a, { current: a.vm ?? x.current, localCwd: x.localCwd, local: x.localCopy, signal: x.signal }),
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
			"`use` makes `vm` the current VM (default for all vm_* tools; created if missing); `none` clears it. " +
			"`build-base` builds the host's desktop base image (~3 min), which desktop VMs are created from; a new host needs it once (headless VMs don't). The host refuses while VMs depend on the current base. " +
			"`host` selects a session host via host:NAME and clears the current VM (vm_info hosts lists them). " +
			"`host_add` registers a new host: name (its alias), dest (`local` = the machine this agent's controller runs on, or an ssh destination such as user@box) and, " +
			`to create a separate profile there for another VM platform, backend (${BACKENDS}; it gets its own state, proxy port and services), ` +
			"or profile to use one that already exists there; buildBase:true then runs build-base on it. " +
			"It uses the user's default ssh key and becomes the CLI default only if there is none; select it afterwards with action:'host'. " +
			"`host_rm` forgets registered host `name` (only the registration: its VMs, profile data and grants stay; the CLI default can't be removed). Credentials and grants remain user-controlled.",
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
				name: { type: "string", description: "host_add/host_rm: the host's alias (a host, not a VM; VMs are `vm`)" },
				dest: { type: "string", description: "host_add: local, or an ssh destination (user@host or an ssh-config alias)" },
				backend: { type: "string", description: `host_add: create a new profile on dest for this backend (${BACKENDS})` },
				profile: { type: "string", description: "host_add: use this existing profile on dest (default: with backend, the host name)" },
				buildBase: { type: "boolean", description: "host_add: then build the desktop base image (~3 min)" },
				host: HOST_PARAM,
			},
			required: ["action"],
		},
		annotations: { destructiveHint: true, openWorldHint: false },
		run: (_vm, a, x) => manageAction(a, x),
	},
	{
		name: "vm_info",
		title: "VM info",
		noVm: true,
		description:
			`Read-only lookups about boxery VMs. action: ${INFO_ACTIONS.join(" | ")}. ` +
			"`list` shows the VMs on the host and the current VM; `shapes` the VM sizes the host offers; `grants` what VM `vm` may access from the user's machine (to ask for more, use vm_grant); `snaps` the snapshots of VM `vm`; `images` every snapshot on the host as VM@SNAP (what vm_manage new takes as `from`); " +
			"`version` the controller's and host's boxery versions. If the host is behind, tell the user: upgrading it is theirs to run (`boxery upgrade-host`). " +
			"`hosts` lists registered hosts: where each runs (local or its ssh destination), its backend, and which names share a profile (same host). " +
			"`vm` defaults to the current VM.",
		parameters: {
			type: "object",
			properties: { action: { type: "string", enum: INFO_ACTIONS }, vm: { type: "string", description: "grants/snaps: the VM (default: the current VM)" }, host: HOST_PARAM },
			required: ["action"],
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
		outputSchema: INFO_OUTPUT,
		run: (_vm, a, x) => infoAction(a, x),
	},
	{
		name: "vm_grant",
		title: "VM grant request",
		description:
			"Ask the user to give a VM access to something on their machine, when work there fails without it (a 401 from a package registry, git asking for credentials). " +
			"The user approves or declines in a prompt you cannot answer; on approval the grant is added and applied. " +
			"spec: `llm:chatgpt` | `llm:openai` | `llm:anthropic` | `llm:ollama` (an LLM provider through the host proxy; a VM has none until granted, so a 403 'llm:X is not granted' from 127.0.0.1:8088 means request it), `github` (git over https to github.com and the GitHub API; the token stays on the host proxy, never in the VM; readonly:true for clone/fetch and reads), " +
			"`ssh-agent` (git over ssh with the user's keys, while they're connected), `env:VAR` (the variable as set where boxery runs, read again each time grants are applied), " +
			"or `file:LOCAL[=REMOTE]` (LOCAL on this machine; REMOTE relative to /home/agent, default project/<name>; e.g. `file:~/.npmrc=.npmrc`). " +
			"Prefer `github` for GitHub. Granted values live in the VM's memory, not its disk or snapshots. Request each thing once; if the user declines, don't ask again, and don't get it into the VM another way (vm_copy, vm_write, vm_bash). For access no spec covers (a git host other than github.com, another API), tell the user the command to run themselves: `boxery --host HOST grant VM http:HOST --cmd '…'` (agents can't request http: grants). " +
			"A secret the user pastes into the chat can't be granted as is, and must not be saved to a file to grant it: ask them to keep it in a file you can grant, or to run `boxery --host HOST grant VM env:NAME --cmd '…'` themselves (a command that prints it, such as a keychain lookup). " +
			"Where the client can't prompt, you get the command for the user to run. vm_info {action:'grants'} shows what the VM already has.",
		parameters: obj(
			{
				spec: { type: "string", description: "llm:PROVIDER | github | ssh-agent | env:VAR | file:LOCAL[=REMOTE]" },
				readonly: { type: "boolean", description: "github only: clone/fetch and read-only API calls" },
				reason: { type: "string", description: "One sentence for the user: what failed and why this fixes it" },
			},
			["spec", "reason"],
		),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
		run: (vm, a, x) => core.grantRequest(vm, a, x),
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
				host: HOST_PARAM,
			},
			required: ["action"],
		},
		annotations: { destructiveHint: true },
		run: (_vm, a, x) => leaseAction(a, x),
	},
];

/** Two resolved hosts are the same when both name and profile directory match. @param {HostProfile | null | undefined} a @param {HostProfile | null | undefined} b */
export const sameHost = (a, b) => a?.name === b?.name && a?.dir === b?.dir;

/**
 * What one call targets, resolved against session `s` without awaiting anything, so a concurrent selection
 * can't retarget it or its cleanup: the host (`host`, else the session's), the current VM if it belongs to
 * that host, and for tools that run in a VM the VM (`vm`, else the current one). For those, `args` drops
 * `vm` and `host`; noVm tools get every argument.
 * @param {{ noVm?: boolean }} tool @param {Record<string, any>} args @param {Session} s
 */
export function callTarget(tool, args, s) {
	const host = Object.hasOwn(args, "host") ? core.resolveHost(core.assertHost(args.host)) : s.host;
	const current = sameHost(s.currentHost, host) ? s.current : null;
	if (tool.noVm) return { host, current, vm: /** @type {string | null} */ (null), args };
	const { vm, host: _host, ...rest } = args;
	if (!vm && !current) throw new Error("No VM given and no current VM. Pass `vm`, or select one with vm_manage {action:'use', vm:…}.");
	return { host, current, vm: /** @type {string | null} */ (core.assertName(vm || current)), args: rest };
}

/**
 * Run a TOOLS entry (or a front-end's own tool of the same shape): resolve its target (callTarget), then run it on that host.
 * @param {Pick<Tool, "noVm" | "run">} tool @param {Record<string, any>} args @param {Session} s @param {ToolContext} [ctx] @returns {Promise<ToolResult>}
 */
export async function runTool(tool, args, s, ctx = {}) {
	const { host, current, vm, args: a } = callTarget(tool, args, s);
	return core.withHost(host, () => tool.run(/** @type {string} */ (vm), a, { ...ctx, session: s, host, current }));
}

/** vm_info hosts: the registered hosts, `host` marked current. @param {HostProfile} host @returns {ToolResult} */
export function hostsResult(host) {
	const hosts = core.describeHosts().map(({ name, destination, backend, default: def, same_as, dir }) =>
		({ name, destination, backend, current: name === host.name, default: def, same_as, dir }));
	const row = (/** @type {(typeof hosts)[number]} */ h) => [`${h.name}${h.current ? " *" : ""}`, h.destination ?? "-", h.backend ?? "-",
		[h.default && "default", h.same_as.length && `same host as ${h.same_as.join(", ")}`].filter(Boolean).join("; ") || "-", h.dir].join("\t");
	const text = ["NAME\tDESTINATION\tBACKEND\tNOTES\tPROFILE", ...hosts.map(row),
		"(* = this session's host; destination local = the machine running this controller; backend - = not recorded, run boxery --host NAME backend)"].join("\n");
	return { text, structured: { hosts } };
}

/**
 * vm_info: read-only lookups on the call's host. current: the current VM there.
 * @param {{ action?: string, vm?: string | null }} a @param {{ host: HostProfile, current?: string | null }} ctx @returns {Promise<ToolResult>}
 */
export async function infoAction(a, { host, current }) {
	const target = () => {
		const vm = a.vm ?? current;
		if (!vm) throw new Error("No VM given and no current VM. Pass `vm`.");
		return core.assertName(vm);
	};
	switch (a.action) {
		case "list": {
			const vms = await core.listVms();
			return { text: `${core.formatVms(vms)}\ncurrent: ${current ?? "(none)"} (host: ${host.name})`, structured: { vms, current: current ?? null, host: host.name } };
		}
		case "shapes": {
			const shapes = await core.listShapes();
			return { text: core.formatShapes(shapes), structured: shapes };
		}
		case "grants": {
			const vm = target();
			const grants = core.listGrants(vm);
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
			if (v.host) v.host = { ...v.host, name: host.name };
			return { text: core.formatVersions(v), structured: v };
		}
		case "hosts":
			return hostsResult(host);
		default:
			throw new Error(`unknown action ${a.action}`);
	}
}

/**
 * vm_manage on the call's host: VM lifecycle, plus the session's current VM and host (through the Session hooks).
 * Leased VMs can't be removed. progress: status lines from long controller operations (MCP progress).
 * @param {ManageArgs & { action: string, name?: string, dest?: string, backend?: string | null, profile?: string | null, buildBase?: boolean }} a
 * @param {{ session: Session, host: HostProfile, progress?: Progress }} ctx @returns {Promise<ToolResult>}
 */
export async function manageAction(a, { session: s, host, progress }) {
	switch (a.action) {
		case "use": {
			const vm = core.needVm(a);
			await core.ensureVm(vm, progress);
			const unapplied = await core.applyGrants(vm).then(() => "", (e) => `\ngrants not applied: ${e.message}`);
			s.adopt(vm, host);
			return { text: `current VM: ${vm}${unapplied}` };
		}
		case "none":
			s.clear();
			return { text: "no current VM" };
		case "new": {
			const vm = a.vm ? core.assertName(a.vm) : core.newName();
			const out = await core.manage({ ...a, vm }, { progress });
			if (a.use) s.adopt(vm, host);
			return { text: `${out}${a.use ? `\ncurrent VM: ${vm}` : ""}` };
		}
		case "rm": {
			const vm = core.needVm(a);
			if (s.keeper.find(vm)) throw new Error(`${vm} is leased from the pool; release it with vm_lease {action:"release"}`);
			const isCurrent = () => s.current === vm && sameHost(s.currentHost, host);
			if (isCurrent()) await s.removing?.(vm, host);
			const out = await core.manage(a, { progress });
			if (isCurrent()) s.clear();
			return { text: out };
		}
		case "host":
			if (a.host == null) throw new Error("host selection requires host:NAME");
			s.selectHost(host);
			return { text: `current host: ${host.name}; no current VM` };
		case "host_add": {
			if (Object.hasOwn(a, "host")) throw new Error("host_add takes the new host's alias as name, not host");
			const out = await core.addHost(/** @type {{ name: string, dest: string }} */ (a), { progress });
			const built = a.buildBase ? `\n${await core.withHost(/** @type {string} */ (a.name), () => core.manage({ action: "build-base" }, { progress }))}` : "";
			return { text: `${out}${built}\nselect it with vm_manage {action:"host", host:"${a.name}"}` };
		}
		case "host_rm": {
			if (Object.hasOwn(a, "host")) throw new Error("host_rm takes the host's alias as name, not host");
			const out = await core.removeHost(/** @type {string} */ (a.name));
			// Resolved sessions keep their profile directory; say so when this session is one of them.
			return { text: s.host.name === a.name ? `${out}\nthis session still uses ${a.name} until you select another host` : out };
		}
		default:
			if (INFO_ACTIONS.includes(a.action)) throw new Error(`vm_manage has no ${a.action}; use vm_info {action:"${a.action}"}`);
			return { text: await core.manage(a, { progress }) };
	}
}

/**
 * vm_lease on the call's host, with the session's lease keeper. current: the current VM there.
 * @param {{ action?: string, vm?: string | null, ttl?: number | null, wait?: number | null, use?: boolean }} a
 * @param {{ session: Session, host: HostProfile, current?: string | null }} ctx @returns {Promise<ToolResult>}
 */
export async function leaseAction(a, { session: s, host, current }) {
	const target = () => core.assertName(a.vm ?? current ?? "");
	switch (a.action) {
		case "acquire": {
			const l = await s.keeper.acquire({ ttl: a.ttl ?? undefined, wait: a.wait ?? undefined });
			if (a.use !== false) s.adopt(l.name, host);
			return { text: `leased ${l.name} (lease ${l.id}, ttl ${l.ttl}s, renewed automatically while this session is active)${a.use !== false ? `\ncurrent VM: ${l.name}` : ""}` };
		}
		case "renew": {
			const l = await s.keeper.renew(target(), a.ttl ?? undefined);
			return { text: `renewed ${l.name} for ${l.ttl}s` };
		}
		case "release": {
			const name = target();
			await s.keeper.release(name);
			const wasCurrent = current === name;
			if (wasCurrent) s.clear();
			return { text: `released ${name}; the host resets it to its clean image${wasCurrent ? "\nno current VM" : ""}` };
		}
		case "list":
			return { text: core.formatLeases(s.keeper.list(), current) };
		default:
			throw new Error(`unknown action ${a.action}`);
	}
}
