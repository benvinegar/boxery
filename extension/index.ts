/**
 * boxery pi extension: a laptop pi gets explicit tools for remote boxery VMs.
 *
 * Built-in tools (bash, read, write, edit, …) are NOT touched: they keep acting on this machine, so
 * other extensions that wrap them keep working. VM work goes through clearly named vm_* tools:
 *
 *   vm_bash  vm_read  vm_write  vm_edit  vm_copy           files and shell in a VM
 *   vm_jobs                                                 background command jobs (start / list / logs / wait / kill)
 *   vm_screenshot  vm_click  vm_type  vm_key  vm_scroll    computer use on the VM desktop
 *   vm_browser                                              Playwright → Chrome on the VM desktop
 *   vm_manage                                               list / new / fork / rm / start / stop / resize / snap / snaps / snap-rm / revert / images / use / grants / shapes / build-base
 *   vm_lease                                                acquire / renew / release / list pool leases
 *   vm_grant                                                ask the user (confirm dialog) to grant the VM access
 *
 * The same tools are available to any MCP client (Claude Code, Cursor, …) via mcp/boxery-mcp.mjs.
 * Both are built from one tool table (core/boxery-tools.mjs) on top of core/boxery-core.mjs. Here,
 * bash/read/write/edit run on pi's own tool engines (same rendering, truncation and edit semantics
 * as the built-ins) over ssh-backed operations.
 *
 *   pi --vm demo [--vm-grant ssh-agent,env:GH_TOKEN,file:.env]
 *   pi --vm new      throwaway VM, removed when pi quits
 *   pi --vm pool     lease a pool VM, released when pi quits
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
// @ts-ignore: plain ESM shared with the MCP server
import * as core from "../core/boxery-core.mjs";
// @ts-ignore: the vm_* tool table the MCP server is built from too
import { leaseAction, manageAction, TOOLS, VM_PARAM } from "../core/boxery-tools.mjs";

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
	pi.registerFlag("vm", {
		description: 'boxery: current VM NAME (created if missing), "new" for a throwaway VM, or "pool" to lease one from the shared pool',
		type: "string",
	});
	pi.registerFlag("vm-ttl", { description: "boxery: lease length in seconds for --vm pool (renewed automatically while pi runs; default 1800)", type: "string" });
	pi.registerFlag("vm-grant", {
		description: "boxery: comma-separated grants for the --vm VM, e.g. ssh-agent,env:GH_TOKEN,file:.env (see `boxery grant`)",
		type: "string",
	});

	// lease: the current VM is a pool lease from --vm pool or /vm pool, released when it stops being current.
	// Every lease this process holds (those, and vm_lease's) lives in `leases`: renewed while pi runs,
	// released when the session ends.
	let current: { name: string; ephemeral: boolean; lease?: boolean } | null = null;
	let uiCtx: any = null;
	const leases = new core.LeaseKeeper({
		// The lease is gone (expired, reaped, host rebooted) and the VM may already belong to someone else: stop using it.
		onLost(l: any, e: any) {
			if (current?.name !== l.name) return;
			current = null;
			uiCtx?.ui?.setStatus?.("boxery", undefined);
			uiCtx?.ui?.notify?.(`boxery: lost the lease on "${l.name}" (${e.message}); vm_* tools are disabled until you pick a VM`, "error");
		},
	});
	let desktopProc: ChildProcess | null = null;

	const pick = (vm?: string) => {
		const name = vm || current?.name;
		if (!name) throw new Error("No VM given and no current VM. Pass `vm`, or create/select one with vm_manage.");
		return core.assertName(name);
	};

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

	// ------------------------------------------------------------ VM lifecycle + current VM

	/** Give back whatever this process holds for VM `c`: release a lease, or delete a throwaway VM. */
	function dropOwned(c: NonNullable<typeof current>, ctx: any) {
		if (c.lease) {
			ctx?.ui?.notify?.(`boxery: releasing lease on "${c.name}" (the VM is reset for the next user)`, "info");
			return leases.release(c.name).catch(() => {});
		}
		if (c.ephemeral) {
			ctx?.ui?.notify?.(`boxery: removing throwaway VM "${c.name}"`, "info");
			return core.boxeryCli(["rm", c.name], 120_000).catch(() => {});
		}
	}

	async function acquireLease(ctx: any, grants: string[] = []) {
		uiCtx = ctx;
		const ttl = Math.min(core.LEASE_TTL.max, Math.max(core.LEASE_TTL.min, Math.round(Number(pi.getFlag("vm-ttl") ?? core.LEASE_TTL.default) || core.LEASE_TTL.default)));
		ctx?.ui?.notify?.("boxery: leasing a VM from the pool…", "info");
		const { name } = await leases.acquire({ ttl, wait: 60 });
		if (grants.length) await applyGrants(name, ctx, grants);
		setCurrent({ name, ephemeral: false, lease: true }, ctx);
	}

	function setCurrent(c: typeof current, ctx: any, persist = true) {
		// Leases and throwaway VMs are given back as soon as they stop being current, not only on quit.
		if (current && current.name !== c?.name) void dropOwned(current, ctx);
		current = c;
		// Leased VMs belong to this process and are never re-adopted; persistent VMs also
		// record their host so a changed default cannot redirect a resumed session.
		const leased = !!c && (!!c.lease || !!leases.find(c.name));
		if (persist) pi.appendEntry("boxery-current", c ? { vm: c.name, ephemeral: c.ephemeral || leased, host: core.currentHost().name, configDir: core.currentHost().dir } : { vm: null });
		const label = c ? `⛁ vm:${c.name}${leased ? " (leased)" : ""}` : undefined;
		ctx?.ui?.setStatus?.("boxery", label ? (ctx.ui.theme?.fg?.("accent", label) ?? label) : undefined);
	}

	/** Grants (ssh-agent / env / file) are owned by the controller CLI; the extension asks it to apply them. */
	async function applyGrants(name: string, ctx: any, specs: string[] = []) {
		if (specs.length) {
			const out = await core.boxeryCli(["grant", name, ...specs], 120_000);
			ctx?.ui?.notify?.(`boxery: ${out.split("\n").filter((l: string) => !l.startsWith("==> granted")).join(" ").replace(/==> /g, "")}`, "info");
		} else {
			await core.boxeryCli(["grants", name, "apply", "--quiet"], 120_000).catch((e: any) => ctx?.ui?.notify?.(`boxery: ${e.message}`, "warning"));
		}
	}

	async function useVm(name: string, ctx: any, ephemeral = false, grants: string[] = []) {
		await core.ensureVm(name, (m: string) => ctx?.ui?.notify?.(m, "info"));
		await applyGrants(name, ctx, grants);
		setCurrent({ name, ephemeral }, ctx);
	}

	/** A current VM that is about to be removed stops being current first (leases are released instead). */
	function forgetBeforeRm(name: string, ctx: any, releaseHint: string) {
		if (current?.name !== name) return;
		if (current.lease || leases.find(name)) throw new Error(`${name} is leased from the pool; ${releaseHint} to release it`);
		current = { ...current, ephemeral: false }; // the caller deletes it; setCurrent must not race it
		setCurrent(null, ctx);
	}

	// ------------------------------------------------------------ vm_* tools (shared table: core/boxery-tools.mjs)

	// bash/read/write/edit run on pi's own tool engines (same rendering, truncation and edit semantics
	// as the built-ins), so they keep those engines' parameter schemas; everything else is the table's.
	const engineDefs: Record<string, any> = {
		bash: createBashToolDefinition(PROJECT),
		read: createReadToolDefinition(PROJECT),
		write: createWriteToolDefinition(PROJECT),
		edit: createEditToolDefinition(PROJECT),
	};
	const promptSnippets: Record<string, string> = {
		vm_bash: "Run shell commands in the VM (project work)",
		vm_read: "Read files in the VM",
		vm_write: "Create files in the VM",
		vm_edit: "Edit files in the VM",
	};
	const withVm = (schema: any) => ({ ...schema, properties: { ...schema.properties, vm: VM_PARAM } });
	// vm_grant's approval: pi's own confirm dialog, which the agent cannot answer. No UI (print mode): no prompt.
	const confirmGrant = core.oneAtATime(async ({ ctx, message }: any) => ((await ctx.ui.confirm("boxery: grant VM access?", message)) ? "accept" : "decline"));
	const grantApprover = (ctx: any) => (ctx?.hasUI && ctx.ui?.confirm ? (message: string) => confirmGrant({ ctx, message }) : undefined);
	const manageSession = (ctx: any) => ({
		current: current?.name ?? null,
		use: (name: string) => useVm(name, ctx),
		adopt: (name: string) => setCurrent({ name, ephemeral: false }, ctx),
		clear: () => setCurrent(null, ctx),
		removing: (name: string) => forgetBeforeRm(name, ctx, 'use vm_lease {action:"release"}'),
		keeper: leases,
	});
	const leaseSession = (ctx: any) => ({
		keeper: leases,
		current: current?.name ?? null,
		adopt: (name: string) => setCurrent({ name, ephemeral: false }, ctx),
		// release already gave the lease back: setCurrent must not release it again
		clear: () => {
			if (current) current = { ...current, lease: false };
			setCurrent(null, ctx);
		},
	});

	for (const t of TOOLS as any[]) {
		const base = { name: t.name, label: t.name.replace("_", " "), description: t.description, promptSnippet: promptSnippets[t.name] };
		if (t.engine) {
			const def = engineDefs[t.engine];
			pi.registerTool({
				...base,
				parameters: withVm(def.parameters),
				...(t.engine === "bash" ? { renderCall: def.renderCall, renderResult: def.renderResult } : {}),
				async execute(id, p: any, signal, onUpdate, ctx) {
					const { vm, ...rest } = p;
					const args = t.engine === "bash" ? rest : { ...rest, path: core.vmPath(rest.path) };
					return (engines(pick(vm)) as any)[t.engine].execute(id, args, signal, onUpdate, vmCtx(ctx));
				},
			});
			continue;
		}
		pi.registerTool({
			...base,
			parameters: t.parameters,
			async execute(_id, p: any, signal, _u, ctx) {
				uiCtx = ctx;
				if (t.name === "vm_manage") return toPi(await manageAction(p, manageSession(ctx)));
				if (t.name === "vm_lease") return toPi(await leaseAction(p, leaseSession(ctx)));
				const { vm, ...rest } = p;
				const approve = t.name === "vm_grant" ? grantApprover(ctx) : undefined;
				return toPi(await t.run(t.noVm ? null : pick(vm), t.noVm ? p : rest, { signal, current: current?.name, localCwd: ctx?.cwd, approve }));
			},
		});
	}

	// ------------------------------------------------------------ session wiring

	pi.on("session_start", async (event, ctx) => {
		uiCtx = ctx;
		const flag = pi.getFlag("vm") as string | undefined;
		try {
			// --vm is a process-level choice: apply it at startup only. /new, /resume, reload and fork get a
			// fresh extension instance; they use what that session recorded (or no VM) and never create VMs.
			if (flag && event.reason === "startup") {
				const grants = String(pi.getFlag("vm-grant") ?? "").split(",").map((g) => g.trim()).filter(Boolean);
				if (flag === "pool") await acquireLease(ctx, grants);
				else await (flag === "new" ? useVm(core.newName(), ctx, true, grants) : useVm(flag, ctx, false, grants));
				ctx.ui?.notify?.(`boxery: current VM "${current!.name}". vm_* tools work there; built-in tools stay local.`, "info");
				return;
			}
			let last: any;
			for (const e of ctx.sessionManager.getBranch() as any[]) if (e.type === "custom" && e.customType === "boxery-current") last = e.data;
			// A recorded throwaway VM belongs to its original process; don't adopt it.
			if (last?.vm && !last.ephemeral) {
				const host = core.currentHost();
				if (last.host === host.name && last.configDir === host.dir)
					setCurrent({ name: last.vm, ephemeral: false }, ctx, false);
				else ctx.ui?.notify?.("boxery: saved VM belongs to another host; select a VM with /vm use NAME", "warning");
			}
		} catch (e: any) {
			ctx.ui?.notify?.(`boxery: ${e.message}`, "error");
			// Keep the requested name as current so vm_* tools report the failure instead of guessing.
			if (flag && flag !== "new" && flag !== "pool" && core.VALID_NAME.test(flag)) setCurrent({ name: flag, ephemeral: false }, ctx, false);
		}
	});

	pi.on("session_shutdown", async (event) => {
		desktopProc?.kill();
		desktopProc = null;
		// Throwaway VMs and leases live exactly as long as the session that created them (quit, /new,
		// /resume, fork, reload): the next session never re-adopts them, so give them back now.
		if (current) await dropOwned(current, null);
		current = null;
		await leases.releaseAll();
	});

	pi.on("before_agent_start", async (event) => {
		event.systemPromptOptions.sections.boxery = core.guidance(current?.name, {
			localToolsNote:
				"The built-in bash, read, write, edit, grep, find and ls tools act on the user's LOCAL machine, not the VM. Use them only when you deliberately need something local.",
		});
	});

	// ------------------------------------------------------------ /vm command

	pi.registerCommand("vm", {
		description: "boxery: /vm [use NAME | new [NAME] | pool | off | ls | rm NAME | desktop [NAME] | grant SPEC… | revoke SPEC… | grants]",
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
						say(`boxery: current VM "${arg}"`);
						break;
					case "new": {
						const n = arg || core.newName();
						await useVm(n, ctx, !arg);
						say(`boxery: current VM "${n}"${!arg ? " (throwaway)" : ""}`);
						break;
					}
					case "pool":
						await acquireLease(ctx);
						say(`boxery: leased "${current!.name}" from the pool (released when pi exits or with /vm off)`);
						break;
					case "off":
					case "local":
						setCurrent(null, ctx);
						say("boxery: no current VM");
						break;
					case "ls":
						say(core.formatVms(await core.listVms()));
						break;
					case "rm":
						if (!arg) throw new Error("usage: /vm rm NAME");
						forgetBeforeRm(arg, ctx, "use /vm off");
						say(await core.boxeryCli(["rm", arg], 120_000));
						break;
					case "grant":
					case "revoke": {
						if (!current) throw new Error("no current VM (/vm use NAME first)");
						const specs = [arg, ...more].filter(Boolean);
						if (!specs.length) throw new Error(`usage: /vm ${sub} ssh-agent | env:VAR | file:PATH[=REMOTE] …`);
						say(await core.boxeryCli([sub, current.name, ...specs], 120_000));
						break;
					}
					case "grants":
						if (!current && !arg) throw new Error("usage: /vm grants [NAME]");
						say(core.formatGrants(arg || current!.name, await core.boxeryJson(["grants", core.assertName(arg || current!.name)])));
						break;
					case "desktop": {
						const name = arg || current?.name;
						if (!name) throw new Error("usage: /vm desktop [NAME]");
						desktopProc?.kill();
						const command = core.controllerCommand(["desktop", name]);
						desktopProc = spawn(core.BOXERY, command.args, { env: command.env, stdio: "ignore" });
						say(`boxery: opening the desktop of "${name}" in your browser (tunnel closes when pi exits)`);
						break;
					}
					default:
						throw new Error(`unknown subcommand "${sub}"`);
				}
			} catch (e: any) {
				say(`boxery: ${e.message}`, "error");
			}
		},
	});
}
