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
 *   vm_manage                                               new / fork / rm / start / stop / resize / snap / snap-rm / revert / use / none / build-base
 *                                                           host / host_add / host_rm
 *   vm_info                                                 read-only list / shapes / grants / snaps / images / version / hosts
 *   vm_lease                                                acquire / renew / release / list pool leases
 *   vm_grant                                                ask the user (confirm dialog) to grant the VM access
 *
 * The same tools are available to any MCP client (Claude Code, Cursor, …) via mcp/boxery-mcp.mjs.
 * Both are built from one tool table (core/boxery-tools.mjs) on top of core/boxery-core.mjs, and run
 * through its runTool(), so every tool takes `host` and acts on the right one. Here, bash/read/write/edit
 * run on pi's own tool engines (same rendering, truncation and edit semantics as the built-ins) over
 * ssh-backed operations. What this file adds is pi glue only: flags, /vm, session state, the status line.
 *
 *   pi --vm demo [--vm-grant llm:chatgpt,ssh-agent,env:GH_TOKEN,file:.env] [--vm-host NAME]
 *   pi --vm new      throwaway VM, removed when pi quits
 *   pi --vm pool     lease a pool VM, released when pi quits
 *   /vm use NAME | new [NAME] | off | ls | rm NAME | host [NAME] | desktop [NAME] | grant SPEC… | revoke SPEC… | grants
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
import { callTarget, HOST_PARAM, hostsResult, runTool, sameHost, TOOLS, VM_PARAM } from "../core/boxery-tools.mjs";

const { PROJECT, q } = core;
type HostProfile = ReturnType<typeof core.resolveHost>;

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
		description: "boxery: comma-separated grants for the --vm VM, e.g. llm:chatgpt,ssh-agent,env:GH_TOKEN,file:.env (see `boxery grant`)",
		type: "string",
	});
	pi.registerFlag("vm-host", { description: "boxery: registered host to start on (default: the controller's default host; see `boxery host ls`)", type: "string" });

	// The session's host: --vm-host, else the controller's default, resolved on first use and then pinned
	// (a changed default never redirects a running session). vm_manage host and /vm host change it.
	// current: the current VM, always on that host. lease: a pool lease from --vm pool or /vm pool,
	// released when it stops being current. Every lease this process holds (those, and vm_lease's)
	// lives in `leases`: renewed while pi runs, released when the session ends.
	let selectedHost: HostProfile | null = null;
	const sessionHost = (): HostProfile => (selectedHost ??= core.resolveHost((pi.getFlag("vm-host") as string | undefined) || undefined));
	const hostOrNull = () => {
		try {
			return sessionHost();
		} catch {
			return null;
		}
	};
	let current: { name: string; host: HostProfile; ephemeral: boolean } | null = null;
	let uiCtx: any = null;
	const leases = new core.LeaseKeeper({
		// The lease is gone (expired, reaped, host rebooted) and the VM may already belong to someone else: stop using it.
		onLost(l: any, e: any) {
			if (!current || current.name !== l.name || !sameHost(current.host, l.host)) return;
			current = null;
			uiCtx?.ui?.setStatus?.("boxery", undefined);
			uiCtx?.ui?.notify?.(`boxery: lost the lease on "${l.name}" (${e.message}); vm_* tools are disabled until you pick a VM`, "error");
		},
	});
	let desktopProc: ChildProcess | null = null;

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
		if (leases.find(c.name, c.host)) {
			ctx?.ui?.notify?.(`boxery: releasing lease on "${c.name}" (the VM is reset for the next user)`, "info");
			return core.withHost(c.host, () => leases.release(c.name)).catch(() => {});
		}
		if (c.ephemeral) {
			ctx?.ui?.notify?.(`boxery: removing throwaway VM "${c.name}"`, "info");
			return core.withHost(c.host, () => core.boxeryCli(["rm", c.name], 120_000)).catch(() => {});
		}
	}

	async function acquireLease(ctx: any, grants: string[] = []) {
		uiCtx = ctx;
		const host = sessionHost();
		const ttl = Math.min(core.LEASE_TTL.max, Math.max(core.LEASE_TTL.min, Math.round(Number(pi.getFlag("vm-ttl") ?? core.LEASE_TTL.default) || core.LEASE_TTL.default)));
		ctx?.ui?.notify?.("boxery: leasing a VM from the pool…", "info");
		const { name } = await core.withHost(host, async () => {
			const l = await leases.acquire({ ttl, wait: 60 });
			if (grants.length) await applyGrants(l.name, ctx, grants);
			return l;
		});
		setCurrent({ name, host, ephemeral: false }, ctx);
	}

	function setCurrent(c: typeof current, ctx: any, persist = true) {
		// Leases and throwaway VMs are given back as soon as they stop being current, not only on quit.
		if (current && (current.name !== c?.name || !sameHost(current.host, c?.host))) void dropOwned(current, ctx);
		current = c;
		if (c) selectedHost = c.host;
		// Leased VMs belong to this process and are never re-adopted. Every entry records its host, so a
		// resumed session goes back to the same host and a changed default cannot redirect it.
		const leased = !!c && !!leases.find(c.name, c.host);
		const host = c?.host ?? hostOrNull();
		if (persist) pi.appendEntry("boxery-current", { vm: c?.name ?? null, ...(c ? { ephemeral: c.ephemeral || leased } : {}), ...(host ? { host: host.name, configDir: host.dir } : {}) });
		// With more than one host registered, say which one the VM is on (HOST/NAME, as vm_copy writes it).
		const where = c && core.registeredHosts().length > 1 ? `${c.host.name}/` : "";
		const label = c ? `⛁ vm:${where}${c.name}${leased ? " (leased)" : ""}` : undefined;
		ctx?.ui?.setStatus?.("boxery", label ? (ctx.ui.theme?.fg?.("accent", label) ?? label) : undefined);
	}

	/** Grants (llm / http / ssh-agent / env / file) are owned by the controller CLI; the extension asks it to apply them. Runs on the current host context. */
	async function applyGrants(name: string, ctx: any, specs: string[] = []) {
		if (specs.length) {
			const out = await core.boxeryCli(["grant", name, ...specs], 120_000);
			ctx?.ui?.notify?.(`boxery: ${out.split("\n").filter((l: string) => !l.startsWith("==> granted")).join(" ").replace(/==> /g, "")}`, "info");
		} else {
			await core.boxeryCli(["grants", name, "apply", "--quiet"], 120_000).catch((e: any) => ctx?.ui?.notify?.(`boxery: ${e.message}`, "warning"));
		}
	}

	async function useVm(name: string, ctx: any, ephemeral = false, grants: string[] = []) {
		const host = sessionHost();
		await core.withHost(host, async () => {
			await core.ensureVm(name, (m: string) => ctx?.ui?.notify?.(m, "info"));
			await applyGrants(name, ctx, grants);
		});
		setCurrent({ name, host, ephemeral }, ctx);
	}

	/** A current VM that is about to be removed stops being current first (leases are released instead). */
	function forgetBeforeRm(name: string, host: HostProfile, ctx: any, releaseHint: string) {
		if (!current || current.name !== name || !sameHost(current.host, host)) return;
		if (leases.find(name, host)) throw new Error(`${name} is leased from the pool; ${releaseHint} to release it`);
		current = { ...current, ephemeral: false }; // the caller deletes it; setCurrent must not race it
		setCurrent(null, ctx);
	}

	/** Make `host` the session's host, with no current VM. */
	function selectHost(host: HostProfile, ctx: any) {
		selectedHost = host;
		setCurrent(null, ctx);
	}

	// ------------------------------------------------------------ vm_* tools (shared table: core/boxery-tools.mjs)

	// The session the shared tools act on (see Session in core/boxery-tools.mjs).
	const toolSession = (ctx: any) => ({
		get host() {
			return sessionHost();
		},
		get current() {
			return current?.name ?? null;
		},
		get currentHost() {
			return current?.host ?? null;
		},
		keeper: leases,
		adopt: (name: string, host: HostProfile) => setCurrent({ name, host, ephemeral: false }, ctx),
		clear: () => setCurrent(null, ctx),
		selectHost: (host: HostProfile) => selectHost(host, ctx),
		removing: (name: string, host: HostProfile) => forgetBeforeRm(name, host, ctx, 'use vm_lease {action:"release"}'),
	});

	// bash/read/write/edit run on pi's own tool engines (same rendering, truncation and edit semantics
	// as the built-ins), so they keep those engines' parameter schemas plus vm and host; everything else is the table's.
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
	const withTarget = (schema: any) => ({ ...schema, properties: { ...schema.properties, vm: VM_PARAM, host: HOST_PARAM } });
	// vm_grant's approval: pi's own confirm dialog, which the agent cannot answer. No UI (print mode): no prompt.
	const confirmGrant = core.oneAtATime(async ({ ctx, message }: any) => ((await ctx.ui.confirm("boxery: grant VM access?", message)) ? "accept" : "decline"));
	const grantApprover = (ctx: any) => (ctx?.hasUI && ctx.ui?.confirm ? (message: string) => confirmGrant({ ctx, message }) : undefined);

	for (const t of TOOLS as any[]) {
		const base = { name: t.name, label: t.name.replace("_", " "), description: t.description, promptSnippet: promptSnippets[t.name] };
		if (t.engine) {
			const def = engineDefs[t.engine];
			pi.registerTool({
				...base,
				parameters: withTarget(def.parameters),
				...(t.engine === "bash" ? { renderCall: def.renderCall, renderResult: def.renderResult } : {}),
				async execute(id, p: any, signal, onUpdate, ctx) {
					const { host, vm, args } = callTarget(t, p, toolSession(ctx));
					const a = t.engine === "bash" ? args : { ...args, path: core.vmPath(args.path) };
					return core.withHost(host, () => (engines(vm as string) as any)[t.engine].execute(id, a, signal, onUpdate, vmCtx(ctx)));
				},
			});
			continue;
		}
		pi.registerTool({
			...base,
			parameters: t.parameters,
			async execute(_id, p: any, signal, _u, ctx) {
				uiCtx = ctx;
				// Long operations (new, fork, build-base) report their latest line in pi's status bar.
				const progress = (m: string) => ctx?.ui?.setStatus?.("boxery-op", m);
				try {
					const approve = t.name === "vm_grant" ? grantApprover(ctx) : undefined;
					return toPi(await runTool(t, p, toolSession(ctx), { signal, localCwd: ctx?.cwd, approve, progress }));
				} finally {
					ctx?.ui?.setStatus?.("boxery-op", undefined);
				}
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
				ctx.ui?.notify?.(`boxery: current VM "${current!.name}" on host "${current!.host.name}". vm_* tools work there; built-in tools stay local.`, "info");
				return;
			}
			let last: any;
			for (const e of ctx.sessionManager.getBranch() as any[]) if (e.type === "custom" && e.customType === "boxery-current") last = e.data;
			// An explicit --vm-host wins over the host a resumed session recorded.
			if (!last?.host || (event.reason === "startup" && pi.getFlag("vm-host"))) return;
			let saved: HostProfile | null = null;
			try {
				saved = core.resolveHost(last.host);
			} catch {}
			// The registration must still point at the profile the session used: same name, same directory.
			if (!saved || saved.dir !== last.configDir) {
				if (last.vm && !last.ephemeral) ctx.ui?.notify?.(`boxery: saved VM "${last.vm}" belongs to host "${last.host}", which is no longer registered as it was; select a VM with /vm use NAME`, "warning");
				return;
			}
			selectedHost = saved;
			// A recorded throwaway VM belongs to its original process; don't adopt it.
			if (last.vm && !last.ephemeral) setCurrent({ name: last.vm, host: saved, ephemeral: false }, ctx, false);
		} catch (e: any) {
			ctx.ui?.notify?.(`boxery: ${e.message}`, "error");
			// Keep the requested name as current so vm_* tools report the failure instead of guessing.
			const host = hostOrNull();
			if (host && flag && flag !== "new" && flag !== "pool" && core.VALID_NAME.test(flag)) setCurrent({ name: flag, host, ephemeral: false }, ctx, false);
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
			host: hostOrNull()?.name,
			localToolsNote:
				"The built-in bash, read, write, edit, grep, find and ls tools act on the user's LOCAL machine, not the VM. Use them only when you deliberately need something local.",
		});
	});

	// ------------------------------------------------------------ /vm command

	pi.registerCommand("vm", {
		description: "boxery: /vm [use NAME | new [NAME] | pool | off | ls | rm NAME | host [NAME] | desktop [NAME] | grant SPEC… | revoke SPEC… | grants]",
		handler: async (args, ctx) => {
			const [sub, arg, ...more] = (args ?? "").trim().split(/\s+/);
			const say = (m: string, lvl = "info") => ctx.ui.notify(m, lvl as any);
			try {
				switch (sub || "status") {
					case "status":
						say(current ? `current VM: "${current.name}" on host "${current.host.name}"${current.ephemeral ? " (throwaway)" : ""}` : `no current VM (host "${sessionHost().name}")`);
						return;
					case "host":
						if (!arg) say(hostsResult(sessionHost()).text);
						else {
							selectHost(core.resolveHost(core.assertHost(arg)), ctx);
							say(`boxery: current host "${arg}"; no current VM`);
						}
						return;
				}
				// Everything else acts on the session's host (the current VM is always on it).
				await core.withHost(sessionHost(), async () => {
					switch (sub) {
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
							forgetBeforeRm(arg, sessionHost(), ctx, "use /vm off");
							say(await core.boxeryCli(["rm", arg], 120_000));
							break;
						case "grant":
						case "revoke": {
							if (!current) throw new Error("no current VM (/vm use NAME first)");
							const specs = [arg, ...more].filter(Boolean);
							if (!specs.length) throw new Error(`usage: /vm ${sub} llm:PROVIDER | ssh-agent | env:VAR | file:PATH[=REMOTE] …`);
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
				});
			} catch (e: any) {
				say(`boxery: ${e.message}`, "error");
			}
		},
	});
}
