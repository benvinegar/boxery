// CLI ↔ agent-tool parity. Agents get the vm_* tools (core/boxery-tools.mjs, shared by MCP and pi);
// people and scripts get controller/boxery. Each side must account for the other: a new tool or
// action fails here until it names its CLI command (or says why there is none), and so does a new
// CLI command. Where both exist, prefer one implementation (boxery cp runs vm_copy's own code).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TOOLS } from "../core/boxery-tools.mjs";

class NoCli { constructor(why) { this.why = why; } }
const none = (why) => new NoCli(why);
const DESKTOP = none("people drive the desktop and Chrome themselves: boxery desktop NAME");
const NO_CURRENT = none("the CLI has no current VM; every command names its VM");

// tool → CLI command, or {action: CLI command} for tools with an `action` enum.
const CLI_FOR_TOOL = {
	vm_bash: "run",
	vm_jobs: { start: "run --bg", list: "jobs", logs: "logs", wait: "wait", kill: "kill" },
	vm_read: "run", // boxery run NAME cat PATH, or boxery cp NAME:PATH ./
	vm_write: "cp",
	vm_edit: none("people edit in their editor, over boxery ssh or after boxery cp"),
	vm_copy: "cp",
	vm_screenshot: DESKTOP,
	vm_click: DESKTOP,
	vm_type: DESKTOP,
	vm_key: DESKTOP,
	vm_scroll: DESKTOP,
	vm_browser: DESKTOP,
	vm_manage: {
		list: "ls", new: "new", fork: "fork", rm: "rm", start: "start", stop: "stop", resize: "resize",
		snap: "snap", snaps: "snaps", "snap-rm": "snap-rm", revert: "revert", images: "images",
		use: NO_CURRENT, none: NO_CURRENT, grants: "grants", shapes: "shapes", "build-base": "build-base",
	},
	vm_info: { list: "ls", shapes: "shapes", grants: "grants", snaps: "snaps", version: "version" },
	vm_lease: { acquire: "acquire", renew: "renew", release: "release", list: "leases" },
	vm_grant: "grant", // the agent asks; the user approves in a prompt, then it runs boxery grant
};

// CLI commands no tool maps to, and why agents don't get them.
const CLI_ONLY = {
	help: "usage text",
	host: "the host registry belongs to the CLI user (MCP adds vm_manage host_add/host_rm outside the shared tools; selecting the default stays theirs)",
	setup: "configuring the VM host is the user's setup",
	"upgrade-host": "upgrading the host is the user's to run (vm_info version tells agents to ask)",
	revoke: "only the user takes access away (agents can only ask for it, with vm_grant)",
	"agent-forward": "only the user changes what a VM may access",
	ssh: "interactive shell (agents use vm_bash)",
	attach: "interactive tmux session",
	desktop: "opens noVNC in the user's browser (agents use the computer-use tools)",
	forward: "binds a port on the user's machine",
	prompt: "starts a pi task in the VM; agents run commands with vm_jobs",
	sessions: "lists the tmux sessions behind attach/prompt",
	"proxy-log": "host-wide LLM/edge request log, for the user",
	pool: "host admin",
};

function cliCommands() {
	const src = readFileSync(new URL("../controller/boxery", import.meta.url), "utf8");
	const top = src.slice(src.lastIndexOf("\ncase $cmd in\n"));
	const arms = [...top.slice(0, top.indexOf("\nesac")).matchAll(/^([a-z][a-z-]*(?: \| [a-z-]+)*)\)/gm)];
	const cmds = new Set(arms.map((m) => m[1].split(" | ")[0])); // ls | list: one command, its first name
	for (const m of src.matchAll(/^if \[ "\$cmd" = ([a-z-]+) \]/gm)) cmds.add(m[1]); // host
	return cmds;
}

const mapped = () =>
	TOOLS.flatMap((t) => {
		const v = CLI_FOR_TOOL[t.name];
		if (typeof v === "object" && !(v instanceof NoCli)) return Object.entries(v).map(([action, cli]) => [`${t.name} ${action}`, cli]);
		return [[t.name, v]];
	});

test("every vm_* tool and action names its CLI command, or why it has none", () => {
	for (const t of TOOLS) {
		assert.ok(t.name in CLI_FOR_TOOL, `${t.name} is new: add it to CLI_FOR_TOOL in test/parity.test.mjs with its boxery command, or none("why")`);
		const actions = t.parameters.properties.action?.enum;
		const v = CLI_FOR_TOOL[t.name];
		if (actions && !(v instanceof NoCli)) {
			assert.ok(typeof v === "object", `${t.name} has actions: map each one`);
			assert.deepEqual(Object.keys(v).sort(), [...actions].sort(), `${t.name}: map exactly its actions (${actions.join(", ")})`);
		}
	}
	assert.deepEqual(Object.keys(CLI_FOR_TOOL).filter((n) => !TOOLS.some((t) => t.name === n)), [], "CLI_FOR_TOOL lists tools that no longer exist");
	for (const [tool, cli] of mapped()) {
		if (cli instanceof NoCli) assert.ok(cli.why.length > 10, `${tool}: say why there is no CLI command`);
		else assert.ok(cliCommands().has(cli.split(" ")[0]), `${tool} maps to "boxery ${cli}", which controller/boxery doesn't dispatch`);
	}
});

test("every CLI command maps to a vm_* tool or says why agents don't get it", () => {
	const reached = new Set(mapped().flatMap(([, cli]) => (cli instanceof NoCli ? [] : [cli.split(" ")[0]])));
	for (const c of cliCommands()) {
		assert.ok(reached.has(c) || c in CLI_ONLY, `boxery ${c} is new: map a vm_* tool to it in CLI_FOR_TOOL, or add it to CLI_ONLY with a reason`);
		assert.ok(!(reached.has(c) && c in CLI_ONLY), `boxery ${c} is mapped to a tool and listed in CLI_ONLY`);
	}
	for (const c of Object.keys(CLI_ONLY)) assert.ok(cliCommands().has(c), `CLI_ONLY lists boxery ${c}, which controller/boxery doesn't dispatch`);
});
