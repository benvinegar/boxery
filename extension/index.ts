/**
 * agentvm pi extension: a laptop pi gets explicit tools for remote agentvm VMs.
 *
 * Built-in tools (bash, read, write, edit, …) are NOT touched: they keep acting on this machine, so
 * other extensions that wrap them keep working. VM work goes through clearly named vm_* tools:
 *
 *   vm_bash  vm_read  vm_write  vm_edit  vm_copy           files and shell in a VM
 *   vm_screenshot  vm_click  vm_type  vm_key  vm_scroll    computer use on the VM desktop
 *   vm_browser                                              Playwright → Chrome on the VM desktop
 *   vm_manage                                               list / new / rm / snap / revert / use / grants
 *
 * The same tools are available to any MCP client (Claude Code, Cursor, …) via mcp/agentvm-mcp.mjs;
 * both share core/agentvm-core.mjs. Here, bash/read/write/edit reuse pi's own tool engines (same
 * rendering, truncation and edit semantics as the built-ins) on top of ssh-backed operations.
 *
 *   pi --vm demo [--vm-grant ssh-agent,env:GH_TOKEN,file:.env]
 *   pi --vm new      throwaway VM, removed when pi quits
 *   /vm use NAME | new [NAME] | off | ls | rm NAME | desktop [NAME] | grant SPEC… | revoke SPEC… | grants
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// @ts-ignore: plain ESM shared with the MCP server
import * as core from "../core/agentvm-core.mjs";

const { PROJECT, q } = core;

// ---------------------------------------------------------------- ssh-backed operations for pi's tool engines

function fileOps(vm: string) {
	const run = (script: string, o?: any): Promise<Buffer> => core.sshOk(vm, script, o);
	const read = {
		readFile: (p: string) => run(`cat -- ${q(p)}`),
		access: (p: string) => run(`test -r ${q(p)}`).then(() => {}),
		detectImageMimeType: async (p: string) => {
			try {
				const m = (await run(`file --mime-type -b -- ${q(p)}`)).toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
	const write = {
		writeFile: (p: string, content: string) => run(`f=${q(p)}; mkdir -p "$(dirname "$f")" && cat > "$f"`, { input: content }).then(() => {}),
		mkdir: (d: string) => run(`mkdir -p -- ${q(d)}`).then(() => {}),
	};
	const edit = {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: (p: string) => run(`test -r ${q(p)} && test -w ${q(p)}`).then(() => {}),
	};
	const bash: BashOperations = { exec: (command, cwd, o) => core.execRemote(vm, command, cwd, o) };
	return { read, write, edit, bash };
}

/** core tool result {text, image?, isError?} → pi tool result (throw on error so pi marks it failed). */
function toPi(r: { text?: string; image?: { data: string; mimeType: string }; isError?: boolean }) {
	if (r.isError) throw new Error(r.text ?? "failed");
	const content: any[] = [{ type: "text", text: r.text ?? "" }];
	if (r.image) content.push({ type: "image", data: r.image.data, mimeType: r.image.mimeType });
	return { content, details: undefined };
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	pi.registerFlag("vm", { description: 'agentvm: current VM NAME (created if missing), or "new" for a throwaway VM', type: "string" });
	pi.registerFlag("vm-grant", {
		description: "agentvm: comma-separated grants for the --vm VM, e.g. ssh-agent,env:GH_TOKEN,file:.env (see `agentvm grant`)",
		type: "string",
	});

	let current: { name: string; ephemeral: boolean } | null = null;
	let desktopProc: ChildProcess | null = null;

	const vmParam = Type.Optional(Type.String({ description: "VM name (default: the current VM)" }));
	const shotParam = Type.Optional(Type.Boolean({ description: "Return a screenshot after the action (default true)" }));
	const pick = (vm?: string) => {
		const name = vm || current?.name;
		if (!name) throw new Error("No VM given and no current VM. Pass `vm`, or create/select one with vm_manage.");
		return core.assertName(name);
	};
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

	const engines = (vm: string) => {
		const ops = fileOps(vm);
		return {
			read: createReadToolDefinition(PROJECT, { operations: ops.read }),
			write: createWriteToolDefinition(PROJECT, { operations: ops.write }),
			edit: createEditToolDefinition(PROJECT, { operations: ops.edit }),
			bash: createBashToolDefinition(PROJECT, { operations: ops.bash, exposeSessionEnvironment: false }),
		};
	};
	// The built-in engines resolve relative paths against ctx.cwd: present the VM project dir instead.
	const vmCtx = (ctx: any) =>
		ctx &&
		new Proxy(ctx, {
			get(t, k) {
				if (k === "cwd") return PROJECT;
				const v = Reflect.get(t, k, t);
				return typeof v === "function" ? v.bind(t) : v;
			},
		});

	// ------------------------------------------------------------ files and shell

	const bashDef = createBashToolDefinition(PROJECT);
	const readDef = createReadToolDefinition(PROJECT);
	const writeDef = createWriteToolDefinition(PROJECT);
	const editDef = createEditToolDefinition(PROJECT);
	const withVm = (schema: any) => ({ ...schema, properties: { ...schema.properties, vm: vmParam } });
	const where = "in an agentvm VM (default: the current VM). Relative paths are under /home/agent/project; ~ is /home/agent.";

	pi.registerTool({
		name: "vm_bash",
		label: "vm bash",
		description: `Run a bash command ${where} Login shell, user "agent" with passwordless sudo, cwd /home/agent/project. Use rg / fdfind / ls here for searching. Output is truncated like bash.`,
		promptSnippet: "Run shell commands in the VM (project work)",
		parameters: withVm(bashDef.parameters),
		renderCall: bashDef.renderCall as any,
		renderResult: bashDef.renderResult as any,
		async execute(id, p: any, signal, onUpdate, ctx) {
			const { vm, ...rest } = p;
			return (engines(pick(vm)).bash as any).execute(id, rest, signal, onUpdate, vmCtx(ctx));
		},
	});

	for (const [name, def, verb] of [
		["vm_read", readDef, "Read a file"],
		["vm_write", writeDef, "Create or overwrite a file"],
		["vm_edit", editDef, "Edit a file"],
	] as const) {
		const key = name.slice(3) as "read" | "write" | "edit";
		pi.registerTool({
			name,
			label: name.replace("_", " "),
			description: `${verb} ${where} ${key === "read" ? "Images are returned as images. Supports offset/limit like read." : key === "edit" ? "Same exact-text replacement semantics as edit." : "Parent directories are created."}`,
			promptSnippet: `${verb.split(" ")[0]} files in the VM`,
			parameters: withVm((def as any).parameters),
			async execute(id, p: any, signal, onUpdate, ctx) {
				const { vm, ...rest } = p;
				return (engines(pick(vm))[key] as any).execute(id, { ...rest, path: core.vmPath(rest.path) }, signal, onUpdate, vmCtx(ctx));
			},
		});
	}

	pi.registerTool({
		name: "vm_copy",
		label: "vm copy",
		description:
			"Copy a file or directory between this machine and a VM, or between VMs. Locations are `local:/path`, `NAME:/path`, or a bare path (= current VM). " +
			"Directories are copied recursively. Example: from `local:./notes.md` to `notes.md`.",
		parameters: Type.Object({ from: Type.String(), to: Type.String() }),
		async execute(_id, p: any, signal, _u, ctx) {
			return toPi(await core.copyTool(p, { current: current?.name, localCwd: ctx?.cwd, signal }));
		},
	});

	// ------------------------------------------------------------ computer use + browser

	const desktopTool = (name: string, description: string, params: any, fn: (vm: string, p: any, signal?: AbortSignal) => Promise<any>) =>
		pi.registerTool({
			name,
			label: name.replace("_", " "),
			description,
			parameters: Type.Object({ ...params, vm: vmParam }),
			async execute(_id, p: any, signal) {
				const { vm, ...rest } = p;
				return toPi(await fn(pick(vm), rest, signal));
			},
		});

	desktopTool("vm_screenshot", "Screenshot of a VM's desktop (DISPLAY=:1).", {}, (vm) => core.screenshot(vm));
	desktopTool(
		"vm_click",
		"Click at (x, y), in screenshot pixels, on a VM's desktop.",
		{
			x: Type.Number(),
			y: Type.Number(),
			button: Type.Optional(Type.String({ description: "left (default), right or middle" })),
			double: Type.Optional(Type.Boolean({ description: "Double-click" })),
			screenshot: shotParam,
		},
		(vm, p) => core.click(vm, p),
	);
	desktopTool("vm_type", "Type text into the focused window on a VM's desktop.", { text: Type.String(), screenshot: shotParam }, (vm, p) => core.typeText(vm, p));
	desktopTool(
		"vm_key",
		'Press keys on a VM\'s desktop, xdotool syntax, space-separated: "Return", "ctrl+l", "ctrl+shift+t", "Escape".',
		{ keys: Type.String(), screenshot: shotParam },
		(vm, p) => core.pressKeys(vm, p),
	);
	desktopTool(
		"vm_scroll",
		"Scroll at (x, y), in screenshot pixels, on a VM's desktop.",
		{
			x: Type.Number(),
			y: Type.Number(),
			direction: Type.String({ description: "up, down, left or right" }),
			amount: Type.Optional(Type.Number({ description: "Wheel clicks (default 5)" })),
			screenshot: shotParam,
		},
		(vm, p) => core.scroll(vm, p),
	);
	desktopTool(
		"vm_browser",
		"Drive Google Chrome on a VM's desktop with Playwright (the user can watch it). `code` is the body of an async function receiving (page, context, browser); " +
			"its return value comes back as JSON. Chrome starts if needed and keeps state between calls. Example: `await page.goto('https://example.com'); return await page.title();`",
		{
			code: Type.String(),
			screenshot: Type.Optional(Type.Boolean({ description: "Also return a screenshot of the page (default false)" })),
			timeout: Type.Optional(Type.Number({ description: "Seconds (default 60)" })),
		},
		(vm, p, signal) => core.browser(vm, p, { signal }),
	);

	// ------------------------------------------------------------ VM lifecycle + current VM

	function setCurrent(c: typeof current, ctx: any, persist = true) {
		// A throwaway VM is removed as soon as it stops being current, not only on quit.
		if (current?.ephemeral && current.name !== c?.name) {
			const old = current.name;
			void core.agentvmCli(["rm", old], 120_000).catch(() => {});
			ctx?.ui?.notify?.(`agentvm: removing throwaway VM "${old}"`, "info");
		}
		current = c;
		if (persist) pi.appendEntry("agentvm-current", c ? { vm: c.name, ephemeral: c.ephemeral } : { vm: null });
		ctx?.ui?.setStatus?.("agentvm", c ? (ctx.ui.theme?.fg?.("accent", `⛁ vm:${c.name}`) ?? `vm:${c.name}`) : undefined);
	}

	/** Grants (ssh-agent / env / file) are owned by the controller CLI; the extension asks it to apply them. */
	async function applyGrants(name: string, ctx: any, specs: string[] = []) {
		if (specs.length) {
			const out = await core.agentvmCli(["grant", name, ...specs], 120_000);
			ctx?.ui?.notify?.(`agentvm: ${out.split("\n").filter((l: string) => !l.startsWith("==> granted")).join(" ").replace(/==> /g, "")}`, "info");
		} else {
			await core.agentvmCli(["grants", name, "apply", "--quiet"], 120_000).catch((e: any) => ctx?.ui?.notify?.(`agentvm: ${e.message}`, "warning"));
		}
	}

	async function useVm(name: string, ctx: any, ephemeral = false, grants: string[] = []) {
		await core.ensureVm(name, (m: string) => ctx?.ui?.notify?.(m, "info"));
		await applyGrants(name, ctx, grants);
		setCurrent({ name, ephemeral }, ctx);
	}

	pi.registerTool({
		name: "vm_manage",
		label: "vm manage",
		description:
			"Manage agentvm VMs (Ubuntu desktop VMs on the user's VM host). action: list | new | rm | snap | revert | use | none | grants. " +
			"`use` makes NAME the current VM (default for all vm_* tools; created if missing); `none` clears it; `new` creates a VM (with use=true also selects it); " +
			"`grants` shows what the VM may access from the user's machine (only the user can change grants).",
		parameters: Type.Object({
			action: Type.String(),
			name: Type.Optional(Type.String()),
			snapshot: Type.Optional(Type.String({ description: "snapshot name for snap/revert" })),
			use: Type.Optional(Type.Boolean({ description: "for new: also make it the current VM" })),
		}),
		async execute(_id, p: any, _s, _u, ctx: any) {
			switch (p.action) {
				case "use":
					await useVm(core.assertName(p.name), ctx);
					return text(`current VM: ${p.name}`);
				case "none":
					setCurrent(null, ctx);
					return text("no current VM");
				case "list":
					return text(`${await core.manage(p)}\ncurrent: ${current?.name ?? "(none)"}`);
				case "new": {
					const name = p.name ? core.assertName(p.name) : core.newName();
					const out = await core.manage({ ...p, name });
					if (p.use) setCurrent({ name, ephemeral: false }, ctx);
					return text(`${out}${p.use ? `\ncurrent VM: ${name}` : ""}`);
				}
				case "rm": {
					if (current?.name === p.name) setCurrent(null, ctx);
					return text(await core.manage(p));
				}
				default:
					return text(await core.manage(p));
			}
		},
	});

	// ------------------------------------------------------------ session wiring

	pi.on("session_start", async (event, ctx) => {
		const flag = pi.getFlag("vm") as string | undefined;
		try {
			// --vm is a process-level choice: apply it at startup only. /new, /resume, reload and fork get a
			// fresh extension instance; they use what that session recorded (or no VM) and never create VMs.
			if (flag && event.reason === "startup") {
				const grants = String(pi.getFlag("vm-grant") ?? "").split(",").map((g) => g.trim()).filter(Boolean);
				await (flag === "new" ? useVm(core.newName(), ctx, true, grants) : useVm(flag, ctx, false, grants));
				ctx.ui?.notify?.(`agentvm: current VM "${current!.name}". vm_* tools work there; built-in tools stay local.`, "info");
				return;
			}
			let last: any;
			for (const e of ctx.sessionManager.getBranch() as any[]) if (e.type === "custom" && e.customType === "agentvm-current") last = e.data;
			// A recorded throwaway VM belongs to its original process; don't adopt it.
			if (last?.vm && !last.ephemeral) setCurrent({ name: last.vm, ephemeral: false }, ctx, false);
		} catch (e: any) {
			ctx.ui?.notify?.(`agentvm: ${e.message}`, "error");
			// Keep the requested name as current so vm_* tools report the failure instead of guessing.
			if (flag && flag !== "new" && core.VALID_NAME.test(flag)) setCurrent({ name: flag, ephemeral: false }, ctx, false);
		}
	});

	pi.on("session_shutdown", async (event) => {
		desktopProc?.kill();
		desktopProc = null;
		// A throwaway VM lives exactly as long as the session that created it (quit, /new, /resume, fork).
		// A reload keeps the same session, so the VM stays; the reloaded instance re-adopts nothing,
		// hence the reload case also removes it rather than leaking it.
		if (current?.ephemeral) await core.agentvmCli(["rm", current.name], 120_000).catch(() => {});
	});

	pi.on("before_agent_start", async (event) => {
		event.systemPromptOptions.sections.agentvm = core.guidance(current?.name, {
			localToolsNote:
				"The built-in bash, read, write, edit, grep, find and ls tools act on the user's LOCAL machine, not the VM. Use them only when you deliberately need something local.",
		});
	});

	// ------------------------------------------------------------ /vm command

	pi.registerCommand("vm", {
		description: "agentvm: /vm [use NAME | new [NAME] | off | ls | rm NAME | desktop [NAME] | grant SPEC… | revoke SPEC… | grants]",
		handler: async (args, ctx) => {
			const [sub, arg, ...more] = (args ?? "").trim().split(/\s+/);
			const say = (m: string, lvl = "info") => ctx.ui.notify(m, lvl as any);
			try {
				switch (sub || "status") {
					case "status":
						say(current ? `current VM: "${current.name}"${current.ephemeral ? " (throwaway)" : ""}` : "no current VM");
						break;
					case "use":
						if (!arg) throw new Error("usage: /vm use NAME");
						await useVm(arg, ctx);
						say(`agentvm: current VM "${arg}"`);
						break;
					case "new": {
						const n = arg || core.newName();
						await useVm(n, ctx, !arg);
						say(`agentvm: current VM "${n}"${!arg ? " (throwaway)" : ""}`);
						break;
					}
					case "off":
					case "local":
						setCurrent(null, ctx);
						say("agentvm: no current VM");
						break;
					case "ls":
						say(await core.agentvmCli(["ls"], 60_000));
						break;
					case "rm":
						if (!arg) throw new Error("usage: /vm rm NAME");
						if (current?.name === arg) setCurrent(null, ctx);
						say(await core.agentvmCli(["rm", arg], 120_000));
						break;
					case "grant":
					case "revoke": {
						if (!current) throw new Error("no current VM (/vm use NAME first)");
						const specs = [arg, ...more].filter(Boolean);
						if (!specs.length) throw new Error(`usage: /vm ${sub} ssh-agent | env:VAR | file:PATH[=REMOTE] …`);
						say(await core.agentvmCli([sub, current.name, ...specs], 120_000));
						break;
					}
					case "grants":
						if (!current && !arg) throw new Error("usage: /vm grants [NAME]");
						say(await core.agentvmCli(["grants", arg || current!.name], 60_000));
						break;
					case "desktop": {
						const name = arg || current?.name;
						if (!name) throw new Error("usage: /vm desktop [NAME]");
						desktopProc?.kill();
						desktopProc = spawn(core.AGENTVM, ["desktop", name], { stdio: "ignore" });
						say(`agentvm: opening the desktop of "${name}" in your browser (tunnel closes when pi exits)`);
						break;
					}
					default:
						throw new Error(`unknown subcommand "${sub}"`);
				}
			} catch (e: any) {
				say(`agentvm: ${e.message}`, "error");
			}
		},
	});
}
