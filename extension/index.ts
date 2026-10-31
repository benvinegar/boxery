/**
 * agentvm pi extension: a laptop pi works inside a remote agentvm VM.
 *
 *   pi --vm demo        attach to VM "demo" (created if missing)
 *   pi --vm new         create a throwaway VM, removed when pi quits
 *   /vm use NAME | /vm new [NAME] | /vm local | /vm ls | /vm rm NAME | /vm desktop | /vm
 *
 * While attached, the built-in read/write/edit/bash/grep/find/ls tools and `!` commands run in the VM
 * (fail closed: if the VM is unreachable they error, they never fall back to the laptop), and the
 * vm_screenshot / vm_click / vm_type / vm_key / vm_scroll / vm_browser tools operate its desktop.
 * vm_manage and vm_exec let the agent create and use other VMs (fan-out).
 *
 * Requires `agentvm setup user@host` on this machine (writes ~/.agentvm/config and ssh_config).
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------- config

const AGENTVM_HOME = process.env.AGENTVM_HOME ?? path.join(homedir(), ".agentvm");
const SSH_CONF = path.join(AGENTVM_HOME, "ssh_config");
const REMOTE_HOME = "/home/agent";
const DEFAULT_REMOTE_CWD = `${REMOTE_HOME}/project`;
const CDP_PORT = 9222;

function controllerPath(): string {
	if (process.env.AGENTVM_BIN) return process.env.AGENTVM_BIN;
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const p = path.resolve(here, "../controller/agentvm");
		if (existsSync(p)) return p;
	} catch {}
	return "agentvm";
}
const AGENTVM = controllerPath();

type Vm = { name: string; rcwd: string; ephemeral: boolean };

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VALID_NAME = /^[a-z][a-z0-9-]{0,30}$/;

// ---------------------------------------------------------------- transport

type RunOpts = { input?: string | Buffer; signal?: AbortSignal; timeoutMs?: number; onData?: (b: Buffer) => void };
type RunResult = { code: number | null; stdout: Buffer; stderr: string };

/** Run a bash script in a VM over the agentvm ssh config. Exit 255 = transport failure → throws. */
function sshRun(vm: string, script: string, opts: RunOpts = {}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		if (!existsSync(SSH_CONF)) return reject(new Error(`agentvm not set up (${SSH_CONF} missing); run: agentvm setup user@host`));
		const child = spawn("ssh", ["-F", SSH_CONF, "-o", "BatchMode=yes", `${vm}.avm`, `bash -c ${q(script)}`], {
			stdio: [opts.input != null ? "pipe" : "ignore", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		let err = "";
		let timer: NodeJS.Timeout | undefined;
		child.stdout.on("data", (d: Buffer) => (opts.onData ? opts.onData(d) : out.push(d)));
		child.stderr.on("data", (d: Buffer) => (opts.onData ? opts.onData(d) : (err += d.toString())));
		const onAbort = () => child.kill();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts.timeoutMs) timer = setTimeout(() => child.kill(), opts.timeoutMs);
		child.on("error", reject);
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (code === 255) return reject(new Error(`VM "${vm}" unreachable over ssh: ${err.trim() || "connection failed"}`));
			resolve({ code, stdout: Buffer.concat(out), stderr: err });
		});
		if (opts.input != null) child.stdin!.end(opts.input);
	});
}

async function sshOk(vm: string, script: string, opts: RunOpts = {}): Promise<Buffer> {
	const r = await sshRun(vm, script, opts);
	if (r.code !== 0) throw new Error(r.stderr.trim() || `command failed (exit ${r.code})`);
	return r.stdout;
}

function agentvmCli(args: string[], timeoutMs = 300_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(AGENTVM, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (e, stdout, stderr) => {
			if (e) reject(new Error(`agentvm ${args.join(" ")}: ${(stderr || e.message).trim()}`));
			else resolve(`${stdout}${stderr}`.trim());
		});
	});
}

// ---------------------------------------------------------------- remote tool operations

function makeOps(vm: Vm, localCwd: string) {
	const localHome = homedir();
	/** Map a laptop path (cwd or ~ expansions) to the VM; VM paths pass through. */
	const toRemote = (p: string) => {
		if (p === localCwd || p.startsWith(`${localCwd}/`)) return vm.rcwd + p.slice(localCwd.length);
		if (p === localHome || p.startsWith(`${localHome}/`)) return REMOTE_HOME + p.slice(localHome.length);
		return p;
	};
	const run = (script: string, o?: RunOpts) => sshOk(vm.name, script, o);

	const read = {
		readFile: (p: string) => run(`cat -- ${q(toRemote(p))}`),
		access: (p: string) => run(`test -r ${q(toRemote(p))}`).then(() => {}),
		detectImageMimeType: async (p: string) => {
			try {
				const m = (await run(`file --mime-type -b -- ${q(toRemote(p))}`)).toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
	const write = {
		// Content goes over stdin: no shell interpolation, binary-safe.
		writeFile: (p: string, content: string) =>
			run(`f=${q(toRemote(p))}; mkdir -p "$(dirname "$f")" && cat > "$f"`, { input: content }).then(() => {}),
		mkdir: (d: string) => run(`mkdir -p -- ${q(toRemote(d))}`).then(() => {}),
	};
	const edit = {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: (p: string) => run(`test -r ${q(toRemote(p))} && test -w ${q(toRemote(p))}`).then(() => {}),
	};

	// ls: one round trip per directory (types cached), not one per entry.
	const kind = new Map<string, "d" | "f" | "n">();
	const probe = async (p: string) => {
		const rp = toRemote(p);
		if (!kind.has(rp)) {
			const k = (await run(`if test -d ${q(rp)}; then echo d; elif test -e ${q(rp)}; then echo f; else echo n; fi`)).toString().trim();
			kind.set(rp, k as "d" | "f" | "n");
		}
		return kind.get(rp)!;
	};
	const ls = {
		exists: async (p: string) => (await probe(p)) !== "n",
		stat: async (p: string) => {
			const k = await probe(p);
			if (k === "n") throw new Error(`not found: ${p}`);
			return { isDirectory: () => k === "d" };
		},
		readdir: async (p: string) => {
			const rp = toRemote(p);
			const out = (await run(`find ${q(rp)} -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\n'`)).toString();
			const names: string[] = [];
			for (const line of out.split("\n")) {
				if (!line) continue;
				const [t, ...rest] = line.split("\t");
				const n = rest.join("\t");
				kind.set(path.posix.join(rp, n), t === "d" ? "d" : "f");
				names.push(n);
			}
			return names;
		},
	};

	const find = {
		exists: async (p: string) => (await sshRun(vm.name, `test -e ${q(toRemote(p))}`)).code === 0,
		glob: async (pattern: string, cwd: string, o: { ignore: string[]; limit: number }) => {
			const rp = toRemote(cwd);
			let pat = pattern;
			let fullPath = "";
			if (pattern.includes("/")) {
				fullPath = "--full-path";
				if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") pat = `**/${pattern}`;
			}
			const out = await run(
				`nrg=--no-require-git; git -C ${q(rp)} rev-parse --is-inside-work-tree >/dev/null 2>&1 && nrg=; ` +
					`fdfind --glob --color=never --hidden --exclude .git --exclude node_modules $nrg ${fullPath} --max-results ${o.limit} -- ${q(pat)} ${q(rp)}`,
			);
			return out.toString().split("\n").filter(Boolean);
		},
	};

	const bash: BashOperations = {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				// Local env is deliberately NOT forwarded to the VM.
				const id = randomBytes(6).toString("hex");
				const script = `cd ${q(toRemote(cwd))} 2>/dev/null || cd ${q(vm.rcwd)} 2>/dev/null || cd ~; exec setsid -w bash -lc ${q(command)} agentvm-run-${id}`;
				let timedOut = false;
				const killRemote = () =>
					sshRun(vm.name, `g=$(pgrep -f -o 'agentvm-run-${id}$'); [ -n "$g" ] && { kill -TERM -- -$g; sleep 2; kill -KILL -- -$g; } 2>/dev/null; true`).catch(() => {});
				const ac = new AbortController();
				const onAbort = () => {
					void killRemote();
					ac.abort();
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							void killRemote();
							ac.abort();
						}, timeout * 1000)
					: undefined;
				sshRun(vm.name, script, { onData, signal: ac.signal })
					.then((r) => {
						if (timer) clearTimeout(timer);
						signal?.removeEventListener("abort", onAbort);
						if (signal?.aborted) reject(new Error("aborted"));
						else if (timedOut) reject(new Error(`timeout:${timeout}`));
						else resolve({ exitCode: r.code });
					})
					.catch((e) => {
						if (timer) clearTimeout(timer);
						reject(e);
					});
			}),
	};

	return { read, write, edit, ls, find, bash, toRemote };
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	pi.registerFlag("vm", { description: 'agentvm: attach to VM NAME (created if missing), or "new" for a throwaway VM', type: "string" });

	const localCwd = process.cwd();
	const local = {
		read: createReadToolDefinition(localCwd),
		write: createWriteToolDefinition(localCwd),
		edit: createEditToolDefinition(localCwd),
		bash: createBashToolDefinition(localCwd),
		grep: createGrepToolDefinition(localCwd),
		find: createFindToolDefinition(localCwd),
		ls: createLsToolDefinition(localCwd),
	};

	let attached: Vm | null = null;
	let remote: ReturnType<typeof buildRemote> | null = null;
	let desktopProc: ChildProcess | null = null;
	const screenScale = new Map<string, number>(); // screenshot px → screen px

	function buildRemote(vm: Vm) {
		const ops = makeOps(vm, localCwd);
		return {
			vm,
			ops,
			read: createReadToolDefinition(vm.rcwd, { operations: ops.read }),
			write: createWriteToolDefinition(vm.rcwd, { operations: ops.write }),
			edit: createEditToolDefinition(vm.rcwd, { operations: ops.edit }),
			bash: createBashToolDefinition(vm.rcwd, { operations: ops.bash, exposeSessionEnvironment: false }),
			find: createFindToolDefinition(vm.rcwd, { operations: ops.find }),
			ls: createLsToolDefinition(vm.rcwd, { operations: ops.ls }),
		};
	}

	/** Present the VM cwd to the built-in tools without touching the real context object. */
	const remoteCtx = (ctx: any, rcwd: string) =>
		ctx &&
		new Proxy(ctx, {
			get(t, k) {
				if (k === "cwd") return rcwd;
				const v = Reflect.get(t, k, t);
				return typeof v === "function" ? v.bind(t) : v;
			},
		});
	/** Model-supplied "~/x" must mean the VM's home, not the laptop's. */
	const fixPath = (params: any) =>
		params && typeof params.path === "string" && /^~(\/|$)/.test(params.path)
			? { ...params, path: REMOTE_HOME + params.path.slice(1) }
			: params;

	for (const name of ["read", "write", "edit", "bash", "find", "ls"] as const) {
		const def: any = local[name];
		pi.registerTool({
			...def,
			async execute(id: string, params: any, signal: any, onUpdate: any, ctx: any) {
				if (!attached || !remote) return def.execute(id, params, signal, onUpdate, ctx);
				return (remote as any)[name].execute(id, fixPath(params), signal, onUpdate, remoteCtx(ctx, attached.rcwd));
			},
		});
	}

	// grep: the built-in always spawns a local ripgrep, so the remote path is a separate implementation.
	pi.registerTool({
		...(local.grep as any),
		async execute(id: string, params: any, signal: any, onUpdate: any, ctx: any) {
			if (!attached || !remote) return (local.grep as any).execute(id, params, signal, onUpdate, ctx);
			const { pattern, glob, ignoreCase, literal, context, limit } = params;
			const p = fixPath(params).path ?? ".";
			const target = remote.ops.toRemote(path.posix.isAbsolute(p) ? p : path.posix.join(attached.rcwd, p));
			const flags = [
				"--no-heading", "--with-filename", "--line-number", "--color=never", "--hidden",
				ignoreCase ? "--ignore-case" : "", literal ? "--fixed-strings" : "",
				glob ? `--glob ${q(glob)}` : "", context && context > 0 ? `-C ${Math.floor(context)}` : "",
			].filter(Boolean).join(" ");
			const r = await sshRun(
				attached.name,
				`t=${q(target)}; if [ -d "$t" ]; then cd "$t" && a=.; elif [ -e "$t" ]; then cd "$(dirname "$t")" && a="$(basename "$t")"; else echo "Path not found: $t" >&2; exit 2; fi; ` +
					`rg ${flags} -- ${q(pattern)} "$a" | head -c 2000000; e=\${PIPESTATUS[0]}; [ $e -le 1 ] || [ $e -eq 141 ] || exit $e`,
				{ signal },
			);
			if (r.code !== 0) throw new Error(r.stderr.trim() || `grep failed (exit ${r.code})`);
			const max = Math.max(1, limit ?? 100);
			const lines = r.stdout.toString().split("\n").filter((l) => l !== "");
			const outLines: string[] = [];
			let matches = 0;
			let limited = false;
			for (const raw of lines) {
				const l = raw.replace(/^\.\//, "");
				if (/^.+?:\d+:/.test(l)) {
					if (matches >= max) {
						limited = true;
						break;
					}
					matches++;
				}
				outLines.push(truncateLine(l).text);
			}
			if (matches === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
			const tr = truncateHead(outLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let text = tr.content;
			const notes = [];
			if (limited) notes.push(`${max} matches limit reached. Use limit=${max * 2} for more, or refine pattern`);
			if (tr.truncated) notes.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
			if (notes.length) text += `\n\n[${notes.join(". ")}]`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	// `!cmd` from the user also runs in the VM while attached.
	pi.on("user_bash", () => (attached && remote ? { operations: remote.ops.bash } : undefined));

	// ------------------------------------------------------------ attach / detach

	const VM_TOOLS = ["vm_screenshot", "vm_click", "vm_type", "vm_key", "vm_scroll", "vm_browser"];
	const syncActiveTools = () => {
		const active = new Set(pi.getActiveTools());
		for (const t of VM_TOOLS) attached ? active.add(t) : active.delete(t);
		pi.setActiveTools([...active]);
	};

	async function vmExists(name: string) {
		const out = await agentvmCli(["ls"], 60_000);
		return out.split("\n").some((l) => l.split(/\s+/)[0] === name);
	}

	async function ensureVm(name: string, notify: (m: string) => void) {
		if (!(await vmExists(name))) {
			notify(`agentvm: creating VM "${name}" (~15s)…`);
			await agentvmCli(["new", name]);
		}
	}

	function attach(vm: Vm, ctx: any, persist = true) {
		attached = vm;
		remote = buildRemote(vm);
		if (persist) pi.appendEntry("agentvm-attach", { vm: vm.name, rcwd: vm.rcwd, ephemeral: vm.ephemeral });
		ctx.ui?.setStatus?.("agentvm", ctx.ui.theme?.fg?.("accent", `⛁ vm:${vm.name}`) ?? `vm:${vm.name}`);
		syncActiveTools();
	}

	function detach(ctx: any, persist = true) {
		attached = null;
		remote = null;
		if (persist) pi.appendEntry("agentvm-attach", { vm: null });
		ctx.ui?.setStatus?.("agentvm", undefined);
		syncActiveTools();
	}

	async function useVm(name: string, ctx: any, ephemeral = false) {
		if (!VALID_NAME.test(name)) throw new Error(`invalid VM name "${name}"`);
		const notify = (m: string) => ctx.ui?.notify?.(m, "info");
		await ensureVm(name, notify);
		await sshOk(name, "true", { timeoutMs: 30_000 });
		attach({ name, rcwd: DEFAULT_REMOTE_CWD, ephemeral }, ctx);
		notify(`agentvm: tools now run in VM "${name}" (${DEFAULT_REMOTE_CWD}). /vm local to return.`);
	}

	const newName = () => `pi-${randomBytes(3).toString("hex")}`;

	pi.on("session_start", async (_event, ctx) => {
		const flag = pi.getFlag("vm") as string | undefined;
		try {
			if (flag) {
				if (flag === "new") await useVm(newName(), ctx, true);
				else await useVm(flag, ctx);
				return;
			}
			// Restore the attachment recorded in this session (resume / reload / --continue).
			let last: any;
			for (const e of ctx.sessionManager.getBranch() as any[]) if (e.type === "custom" && e.customType === "agentvm-attach") last = e.data;
			if (last?.vm) {
				attach({ name: last.vm, rcwd: last.rcwd ?? DEFAULT_REMOTE_CWD, ephemeral: !!last.ephemeral }, ctx, false);
				ctx.ui?.notify?.(`agentvm: re-attached to VM "${last.vm}". Tools fail if it is gone; /vm local to detach.`, "info");
			} else syncActiveTools();
		} catch (e: any) {
			// Fail closed: a requested VM that can't be reached must not silently become local execution.
			ctx.ui?.notify?.(`agentvm: ${e.message}`, "error");
			if (flag) {
				attach({ name: flag === "new" ? "unavailable" : flag, rcwd: DEFAULT_REMOTE_CWD, ephemeral: false }, ctx, false);
			} else syncActiveTools();
		}
	});

	pi.on("session_shutdown", async (event) => {
		desktopProc?.kill();
		desktopProc = null;
		if (event.reason === "quit" && attached?.ephemeral) {
			await agentvmCli(["rm", attached.name], 120_000).catch(() => {});
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!attached) return;
		const o = event.systemPromptOptions;
		o.cwd = attached.rcwd;
		o.sections.agentvm = [
			`You are working inside a remote Linux VM named "${attached.name}" (Ubuntu 24.04, user "agent", passwordless sudo), reached through agentvm.`,
			`All file and shell tools (read, write, edit, bash, grep, find, ls) execute in the VM; the working directory is ${attached.rcwd}. Nothing you run touches the user's own machine, and paths are VM paths.`,
			"The VM has an XFCE desktop on DISPLAY=:1 that the user may be watching. GUI programs started from bash appear there (start them detached, e.g. `setsid nohup prog >/dev/null 2>&1 &`).",
			"To see and operate the desktop use vm_screenshot, vm_click, vm_type, vm_key and vm_scroll (coordinates are in screenshot pixels). For web pages prefer vm_browser, which drives Google Chrome on that desktop through Playwright.",
			`Servers you start are reachable from the user's machine with \`agentvm forward ${attached.name} PORT\`. Other VMs: vm_manage / vm_exec.`,
		].join("\n");
	});

	// ------------------------------------------------------------ /vm command

	pi.registerCommand("vm", {
		description: "agentvm: /vm [use NAME | new [NAME] | local | ls | rm NAME | desktop]",
		handler: async (args, ctx) => {
			const [sub, arg] = (args ?? "").trim().split(/\s+/);
			const say = (m: string, lvl = "info") => ctx.ui.notify(m, lvl as any);
			try {
				switch (sub || "status") {
					case "status":
						say(attached ? `attached to VM "${attached.name}" (${attached.rcwd})${attached.ephemeral ? ", throwaway" : ""}` : "not attached; tools run locally");
						break;
					case "use":
						if (!arg) throw new Error("usage: /vm use NAME");
						await useVm(arg, ctx);
						break;
					case "new":
						await useVm(arg || newName(), ctx, !arg);
						break;
					case "local":
						detach(ctx);
						say("agentvm: detached; tools run locally");
						break;
					case "ls":
						say(await agentvmCli(["ls"], 60_000));
						break;
					case "rm":
						if (!arg) throw new Error("usage: /vm rm NAME");
						if (attached?.name === arg) detach(ctx);
						say(await agentvmCli(["rm", arg], 120_000));
						break;
					case "desktop": {
						const name = arg || attached?.name;
						if (!name) throw new Error("usage: /vm desktop [NAME]");
						desktopProc?.kill();
						desktopProc = spawn(AGENTVM, ["desktop", name], { stdio: "ignore", detached: false });
						say(`agentvm: opening desktop of "${name}" in your browser (tunnel closes when pi exits)`);
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

	// ------------------------------------------------------------ computer use

	const needVm = () => {
		if (!attached) throw new Error("No VM attached. Use /vm use NAME (or start pi with --vm NAME).");
		return attached;
	};
	const X = "export DISPLAY=:1; ";

	async function screenshot(vm: Vm, maxWidth = 1280) {
		// geometry on stderr, PNG on stdout (downscaled so it fits model image limits; clicks scale back)
		const r = await sshRun(vm.name, `${X}xdotool getdisplaygeometry >&2; import -window root -resize '${maxWidth}x>' png:-`, { timeoutMs: 30_000 });
		if (r.code !== 0) throw new Error(r.stderr.trim() || "screenshot failed");
		const [sw, sh] = r.stderr.trim().split(/\s+/).map(Number);
		const shotW = Math.min(sw, maxWidth);
		const scale = sw / shotW;
		screenScale.set(vm.name, scale);
		return {
			image: { type: "image" as const, data: r.stdout.toString("base64"), mimeType: "image/png" },
			text: `Screen of VM "${vm.name}": ${sw}x${sh}, shown at ${shotW}x${Math.round(sh / scale)}. Use coordinates in this screenshot's pixels.`,
		};
	}
	const toScreen = (vm: Vm, n: number) => Math.round(n * (screenScale.get(vm.name) ?? 1600 / 1280));

	async function afterAction(vm: Vm, msg: string, want: boolean | undefined) {
		if (want === false) return { content: [{ type: "text", text: msg }], details: undefined };
		await sleep(500);
		const s = await screenshot(vm);
		return { content: [{ type: "text", text: `${msg}\n${s.text}` }, s.image], details: undefined };
	}

	const shotParam = Type.Optional(Type.Boolean({ description: "Return a screenshot after the action (default true)" }));

	pi.registerTool({
		name: "vm_screenshot",
		label: "vm screenshot",
		description: "Take a screenshot of the attached VM's desktop (DISPLAY=:1).",
		parameters: Type.Object({}),
		async execute() {
			const vm = needVm();
			const s = await screenshot(vm);
			return { content: [{ type: "text", text: s.text }, s.image], details: undefined };
		},
	});

	pi.registerTool({
		name: "vm_click",
		label: "vm click",
		description: "Move the mouse to (x, y) in screenshot pixels on the VM desktop and click.",
		parameters: Type.Object({
			x: Type.Number(),
			y: Type.Number(),
			button: Type.Optional(Type.String({ description: "left (default), right or middle" })),
			double: Type.Optional(Type.Boolean({ description: "Double-click" })),
			screenshot: shotParam,
		}),
		async execute(_id, p: any) {
			const vm = needVm();
			const b = { left: 1, middle: 2, right: 3 }[(p.button ?? "left") as string] ?? 1;
			await sshOk(vm.name, `${X}xdotool mousemove ${toScreen(vm, p.x)} ${toScreen(vm, p.y)} click ${p.double ? "--repeat 2 " : ""}${b}`);
			return afterAction(vm, `clicked ${p.button ?? "left"} at (${p.x}, ${p.y})`, p.screenshot);
		},
	});

	pi.registerTool({
		name: "vm_type",
		label: "vm type",
		description: "Type text on the VM desktop into the focused window.",
		parameters: Type.Object({ text: Type.String(), screenshot: shotParam }),
		async execute(_id, p: any) {
			const vm = needVm();
			await sshOk(vm.name, `${X}xdotool type --clearmodifiers --delay 8 --file -`, { input: p.text });
			return afterAction(vm, `typed ${p.text.length} chars`, p.screenshot);
		},
	});

	pi.registerTool({
		name: "vm_key",
		label: "vm key",
		description: 'Press keys on the VM desktop, xdotool syntax, space-separated: e.g. "Return", "ctrl+l", "ctrl+shift+t", "Escape".',
		parameters: Type.Object({ keys: Type.String(), screenshot: shotParam }),
		async execute(_id, p: any) {
			const vm = needVm();
			const keys = String(p.keys).trim().split(/\s+/);
			if (!keys.every((k) => /^[A-Za-z0-9_+\-]+$/.test(k))) throw new Error(`invalid key spec: ${p.keys}`);
			await sshOk(vm.name, `${X}xdotool key --clearmodifiers -- ${keys.join(" ")}`);
			return afterAction(vm, `pressed ${keys.join(" ")}`, p.screenshot);
		},
	});

	pi.registerTool({
		name: "vm_scroll",
		label: "vm scroll",
		description: "Scroll at (x, y) in screenshot pixels on the VM desktop.",
		parameters: Type.Object({
			x: Type.Number(),
			y: Type.Number(),
			direction: Type.String({ description: "up, down, left or right" }),
			amount: Type.Optional(Type.Number({ description: "Wheel clicks (default 5)" })),
			screenshot: shotParam,
		}),
		async execute(_id, p: any) {
			const vm = needVm();
			const btn = { up: 4, down: 5, left: 6, right: 7 }[p.direction as string];
			if (!btn) throw new Error("direction must be up, down, left or right");
			const n = Math.max(1, Math.min(50, Math.floor(p.amount ?? 5)));
			await sshOk(vm.name, `${X}xdotool mousemove ${toScreen(vm, p.x)} ${toScreen(vm, p.y)} click --repeat ${n} ${btn}`);
			return afterAction(vm, `scrolled ${p.direction} x${n}`, p.screenshot);
		},
	});

	pi.registerTool({
		name: "vm_browser",
		label: "vm browser",
		description:
			"Drive Google Chrome on the attached VM's desktop with Playwright (visible to the user). " +
			"`code` is the body of an async function receiving (page, context, browser); its return value is sent back as JSON. " +
			"Chrome is started if needed and keeps its state between calls. Example: `await page.goto('https://example.com'); return await page.title();`",
		parameters: Type.Object({
			code: Type.String(),
			screenshot: Type.Optional(Type.Boolean({ description: "Also return a screenshot of the page (default false)" })),
			timeout: Type.Optional(Type.Number({ description: "Seconds (default 60)" })),
		}),
		async execute(_id, p: any, signal: any) {
			const vm = needVm();
			const program = `
import { chromium } from '/opt/agentvm/node_modules/playwright-core/index.mjs';
const out = (o) => process.stdout.write('\\n__AVM__' + JSON.stringify(o) + '\\n');
try {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:${CDP_PORT}');
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = context.pages().filter((pg) => !pg.url().startsWith('devtools:')).at(-1) ?? await context.newPage();
  await page.bringToFront().catch(() => {});
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const result = await new AsyncFunction('page', 'context', 'browser', ${JSON.stringify(p.code)})(page, context, browser);
  const shot = ${p.screenshot ? "(await page.screenshot()).toString('base64')" : "null"};
  out({ ok: true, result: result === undefined ? null : result, url: page.url(), shot });
} catch (e) { out({ ok: false, error: String(e && e.stack || e) }); }
process.exit(0);`;
			const script =
				`${X}if ! curl -fs -m1 127.0.0.1:${CDP_PORT}/json/version >/dev/null; then ` +
				`setsid nohup google-chrome --remote-debugging-port=${CDP_PORT} --remote-debugging-address=127.0.0.1 --user-data-dir=$HOME/.config/agentvm-chrome ` +
				`--no-first-run --no-default-browser-check --password-store=basic --start-maximized about:blank >/tmp/agentvm-chrome.log 2>&1 & ` +
				`for i in $(seq 75); do curl -fs -m1 127.0.0.1:${CDP_PORT}/json/version >/dev/null && break; sleep 0.2; done; fi; ` +
				`cd /opt/agentvm && exec node --input-type=module`;
			const r = await sshRun(vm.name, script, { input: program, signal, timeoutMs: (p.timeout ?? 60) * 1000 });
			const m = r.stdout.toString().match(/__AVM__(.*)\n?$/s);
			if (!m) throw new Error(`browser script produced no result (exit ${r.code}): ${r.stderr.slice(-2000)}`);
			const res = JSON.parse(m[1]);
			if (!res.ok) throw new Error(res.error);
			const text = truncateHead(`url: ${res.url}\nresult: ${JSON.stringify(res.result, null, 2)}`, { maxLines: 2000 }).content;
			const content: any[] = [{ type: "text", text }];
			if (res.shot) content.push({ type: "image", data: res.shot, mimeType: "image/png" });
			return { content, details: undefined };
		},
	});

	// ------------------------------------------------------------ fan-out (any VM, attached or not)

	pi.registerTool({
		name: "vm_manage",
		label: "vm manage",
		description:
			"Manage agentvm VMs (Ubuntu desktop VMs on the user's VM host). action: list | new | rm | snap | revert | attach | detach. " +
			"attach routes all of your file/shell tools into that VM; detach returns them to the local machine.",
		parameters: Type.Object({
			action: Type.String(),
			name: Type.Optional(Type.String()),
			snapshot: Type.Optional(Type.String({ description: "snapshot name for snap/revert" })),
		}),
		async execute(_id, p: any, _s, _u, ctx: any) {
			const name = p.name as string | undefined;
			const need = () => {
				if (!name || !VALID_NAME.test(name)) throw new Error("a valid name is required");
				return name;
			};
			let text: string;
			switch (p.action) {
				case "list": text = await agentvmCli(["ls"], 60_000); break;
				case "new": text = await agentvmCli(["new", need()]); break;
				case "rm":
					if (attached?.name === need()) detach(ctx);
					text = await agentvmCli(["rm", need()], 120_000);
					break;
				case "snap": text = await agentvmCli(["snap", need(), ...(p.snapshot ? [p.snapshot] : [])], 600_000); break;
				case "revert":
					if (!p.snapshot) throw new Error("snapshot is required");
					text = await agentvmCli(["revert", need(), p.snapshot], 600_000);
					break;
				case "attach": await useVm(need(), ctx); text = `attached to ${name}; your tools now run there`; break;
				case "detach": detach(ctx); text = "detached; tools run locally"; break;
				default: throw new Error(`unknown action ${p.action}`);
			}
			return { content: [{ type: "text", text: text || "ok" }], details: undefined };
		},
	});

	pi.registerTool({
		name: "vm_exec",
		label: "vm exec",
		description: "Run a bash command in any agentvm VM by name (login shell, cwd /home/agent/project). Use for VMs other than the attached one.",
		parameters: Type.Object({
			name: Type.String(),
			command: Type.String(),
			timeout: Type.Optional(Type.Number({ description: "Seconds (default 120)" })),
		}),
		async execute(_id, p: any, signal: any) {
			if (!VALID_NAME.test(p.name)) throw new Error("invalid VM name");
			const r = await sshRun(p.name, `cd ${DEFAULT_REMOTE_CWD} 2>/dev/null || cd ~; bash -lc ${q(p.command)} 2>&1`, {
				signal,
				timeoutMs: (p.timeout ?? 120) * 1000,
			});
			const out = truncateHead(r.stdout.toString(), { maxLines: 2000 }).content;
			return { content: [{ type: "text", text: `${out}\n[exit ${r.code}]` }], details: undefined };
		},
	});
}
