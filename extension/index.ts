/**
 * agentvm pi extension: a laptop pi gets explicit tools for remote agentvm VMs.
 *
 * Built-in tools (bash, read, write, edit, …) are NOT touched: they keep acting on this machine, so
 * other extensions that wrap them keep working. VM work goes through clearly named vm_* tools:
 *
 *   vm_bash  vm_read  vm_write  vm_edit  vm_copy           files and shell in a VM
 *   vm_screenshot  vm_click  vm_type  vm_key  vm_scroll    computer use on the VM desktop
 *   vm_browser                                              Playwright → Chrome on the VM desktop
 *   vm_manage                                               list / new / rm / snap / revert / use
 *
 * Every vm_* tool takes an optional `vm`; it defaults to the current VM (--vm NAME, /vm use NAME).
 *
 *   pi --vm demo     current VM "demo" (created if missing)
 *   pi --vm new      throwaway VM, removed when pi quits
 *   /vm use NAME | /vm new [NAME] | /vm off | /vm ls | /vm rm NAME | /vm desktop [NAME] | /vm
 *
 * Requires `agentvm setup user@host` on this machine (writes ~/.agentvm/config and ssh_config).
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------- config

const AGENTVM_HOME = process.env.AGENTVM_HOME ?? path.join(homedir(), ".agentvm");
const SSH_CONF = path.join(AGENTVM_HOME, "ssh_config");
const REMOTE_HOME = "/home/agent";
const PROJECT = `${REMOTE_HOME}/project`;
const CDP_PORT = 9222;
const VALID_NAME = /^[a-z][a-z0-9-]{0,30}$/;

function controllerPath(): string {
	if (process.env.AGENTVM_BIN) return process.env.AGENTVM_BIN;
	try {
		const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../controller/agentvm");
		if (existsSync(p)) return p;
	} catch {}
	return "agentvm";
}
const AGENTVM = controllerPath();

export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** VM path for a model-supplied path: ~ → VM home, relative → VM project dir. */
export function vmPath(p: string | undefined): string {
	const s = (p ?? ".").trim() || ".";
	if (s === "~") return REMOTE_HOME;
	if (s.startsWith("~/")) return REMOTE_HOME + s.slice(1);
	return path.posix.isAbsolute(s) ? path.posix.normalize(s) : path.posix.join(PROJECT, s);
}

/** Parse "vmname:/path", "local:/path" or a plain path (= current VM). */
export function parseLoc(spec: string, current: string | undefined): { vm: string | null; path: string } {
	const m = spec.match(/^([a-z][a-z0-9-]{0,30}|local):(.*)$/);
	if (m) return m[1] === "local" ? { vm: null, path: m[2] } : { vm: m[1], path: vmPath(m[2]) };
	if (!current) throw new Error(`"${spec}" has no VM prefix and no current VM is set (use NAME:path or local:path)`);
	return { vm: current, path: vmPath(spec) };
}

// ---------------------------------------------------------------- transport

type RunOpts = { input?: string | Buffer; signal?: AbortSignal; timeoutMs?: number; onData?: (b: Buffer) => void };
type RunResult = { code: number | null; stdout: Buffer; stderr: string };

/** Run a bash script in a VM over the agentvm ssh config. Exit 255 = transport failure → throws. */
function sshRun(vm: string, script: string, opts: RunOpts = {}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		if (!VALID_NAME.test(vm)) return reject(new Error(`invalid VM name "${vm}"`));
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

// ---------------------------------------------------------------- remote operations for pi's tool engines

function fileOps(vm: string) {
	const run = (script: string, o?: RunOpts) => sshOk(vm, script, o);
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
		// content over stdin: no shell interpolation, binary-safe
		writeFile: (p: string, content: string) => run(`f=${q(p)}; mkdir -p "$(dirname "$f")" && cat > "$f"`, { input: content }).then(() => {}),
		mkdir: (d: string) => run(`mkdir -p -- ${q(d)}`).then(() => {}),
	};
	const edit = {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: (p: string) => run(`test -r ${q(p)} && test -w ${q(p)}`).then(() => {}),
	};
	const bash: BashOperations = {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				// Own process group + tag, so abort/timeout kill the remote job too. Local env is not forwarded.
				const id = randomBytes(6).toString("hex");
				const script = `cd ${q(cwd)} 2>/dev/null || cd ${q(PROJECT)} 2>/dev/null || cd ~; exec setsid -w bash -lc ${q(command)} agentvm-run-${id} </dev/null`; // no stdin: tools like rg would otherwise search the ssh pipe
				let timedOut = false;
				const killRemote = () =>
					sshRun(vm, `g=$(pgrep -f -o 'agentvm-run-${id}$'); [ -n "$g" ] && { kill -TERM -- -$g; sleep 2; kill -KILL -- -$g; } 2>/dev/null; true`).catch(() => {});
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
				sshRun(vm, script, { onData, signal: ac.signal })
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
	return { read, write, edit, bash };
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	pi.registerFlag("vm", { description: 'agentvm: current VM NAME (created if missing), or "new" for a throwaway VM', type: "string" });

	let current: { name: string; ephemeral: boolean } | null = null;
	let desktopProc: ChildProcess | null = null;
	const screenScale = new Map<string, number>(); // screenshot px → screen px

	const vmParam = Type.Optional(Type.String({ description: "VM name (default: the current VM)" }));
	const pick = (vm?: string) => {
		const name = vm || current?.name;
		if (!name) throw new Error("No VM given and no current VM. Pass `vm`, or create one with vm_manage {action:'new'}.");
		if (!VALID_NAME.test(name)) throw new Error(`invalid VM name "${name}"`);
		return name;
	};
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

	// Engines from pi's built-ins, pointed at the VM (same truncation, edit semantics, image handling).
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

	pi.registerTool({
		name: "vm_read",
		label: "vm read",
		description: `Read a file ${where} Images are returned as images. Supports offset/limit like read.`,
		promptSnippet: "Read files in the VM",
		parameters: withVm(readDef.parameters),
		async execute(id, p: any, signal, onUpdate, ctx) {
			const { vm, ...rest } = p;
			return (engines(pick(vm)).read as any).execute(id, { ...rest, path: vmPath(rest.path) }, signal, onUpdate, vmCtx(ctx));
		},
	});

	pi.registerTool({
		name: "vm_write",
		label: "vm write",
		description: `Create or overwrite a file ${where} Parent directories are created.`,
		promptSnippet: "Write files in the VM",
		parameters: withVm(writeDef.parameters),
		async execute(id, p: any, signal, onUpdate, ctx) {
			const { vm, ...rest } = p;
			return (engines(pick(vm)).write as any).execute(id, { ...rest, path: vmPath(rest.path) }, signal, onUpdate, vmCtx(ctx));
		},
	});

	pi.registerTool({
		name: "vm_edit",
		label: "vm edit",
		description: `Edit a file ${where} Same exact-text replacement semantics as edit.`,
		promptSnippet: "Edit files in the VM",
		parameters: withVm(editDef.parameters),
		async execute(id, p: any, signal, onUpdate, ctx) {
			const { vm, ...rest } = p;
			return (engines(pick(vm)).edit as any).execute(id, { ...rest, path: vmPath(rest.path) }, signal, onUpdate, vmCtx(ctx));
		},
	});

	pi.registerTool({
		name: "vm_copy",
		label: "vm copy",
		description:
			"Copy a file or directory between this machine and a VM, or between VMs. Locations are `local:/path`, `NAME:/path`, or a bare path (= current VM). " +
			"Directories are copied recursively (tar over ssh). Example: from `local:./notes.md` to `notes.md`.",
		parameters: Type.Object({ from: Type.String(), to: Type.String() }),
		async execute(_id, p: any, signal, _u, ctx) {
			const src = parseLoc(p.from, current?.name);
			const dst = parseLoc(p.to, current?.name);
			const localAbs = (s: string) => path.resolve(ctx?.cwd ?? process.cwd(), s.replace(/^~(?=\/|$)/, homedir()));
			// Stream a tar of the source (file or dir) into the destination directory/name.
			const tarOut = async (): Promise<Buffer> => {
				if (src.vm) {
					return sshOk(src.vm, `s=${q(src.path)}; cd "$(dirname "$s")" && tar -cf - -- "$(basename "$s")"`, { signal });
				}
				const abs = localAbs(src.path);
				return new Promise((res, rej) => {
					execFile("tar", ["-cf", "-", "-C", path.dirname(abs), "--", path.basename(abs)], { encoding: "buffer", maxBuffer: 1 << 30 }, (e, out) =>
						e ? rej(e) : res(out as Buffer),
					);
				});
			};
			const srcBase = path.posix.basename(src.vm ? src.path : localAbs(src.path));
			const tarball = await tarOut();
			if (dst.vm) {
				// If destination is an existing dir, extract into it; otherwise extract and rename to the destination name.
				await sshOk(
					dst.vm,
					`d=${q(dst.path)}; t=$(mktemp -d); tar -xf - -C "$t"; if [ -d "$d" ]; then cp -a "$t"/. "$d"/; else mkdir -p "$(dirname "$d")"; mv "$t"/${q(srcBase)} "$d"; fi; rm -rf "$t"`,
					{ input: tarball, signal },
				);
			} else {
				const d = localAbs(dst.path);
				const tmp = path.join(path.dirname(d), `.agentvm-copy-${randomBytes(4).toString("hex")}`);
				await mkdir(tmp, { recursive: true });
				await new Promise<void>((res, rej) => {
					const c = spawn("tar", ["-xf", "-", "-C", tmp]);
					c.on("error", rej);
					c.on("close", (code) => (code === 0 ? res() : rej(new Error(`tar exit ${code}`))));
					c.stdin.end(tarball);
				});
				await new Promise<void>((res, rej) =>
					execFile("sh", ["-c", 'if [ -d "$2" ]; then cp -a "$1"/. "$2"/; else mv "$1"/"$3" "$2"; fi; rm -rf "$1"', "sh", tmp, d, srcBase], (e) =>
						e ? rej(e) : res(),
					),
				);
			}
			const fmt = (l: { vm: string | null; path: string }) => `${l.vm ?? "local"}:${l.vm ? l.path : localAbs(l.path)}`;
			return text(`copied ${fmt(src)} → ${fmt(dst)} (${tarball.length} bytes tar)`);
		},
	});

	// ------------------------------------------------------------ computer use

	const X = "export DISPLAY=:1; ";

	async function screenshot(vm: string, maxWidth = 1280) {
		// geometry on stderr, PNG on stdout (downscaled for model image limits; clicks scale back)
		const r = await sshRun(vm, `${X}xdotool getdisplaygeometry >&2; import -window root -resize '${maxWidth}x>' png:-`, { timeoutMs: 30_000 });
		if (r.code !== 0) throw new Error(r.stderr.trim() || "screenshot failed");
		const [sw, sh] = r.stderr.trim().split(/\s+/).map(Number);
		const shotW = Math.min(sw, maxWidth);
		const scale = sw / shotW;
		screenScale.set(vm, scale);
		return {
			image: { type: "image" as const, data: r.stdout.toString("base64"), mimeType: "image/png" },
			text: `Screen of VM "${vm}": ${sw}x${sh}, shown at ${shotW}x${Math.round(sh / scale)}. Use coordinates in this screenshot's pixels.`,
		};
	}
	const toScreen = (vm: string, n: number) => Math.round(n * (screenScale.get(vm) ?? 1600 / 1280));
	async function afterAction(vm: string, msg: string, want: boolean | undefined) {
		if (want === false) return text(msg);
		await sleep(500);
		const s = await screenshot(vm);
		return { content: [{ type: "text" as const, text: `${msg}\n${s.text}` }, s.image], details: undefined };
	}
	const shotParam = Type.Optional(Type.Boolean({ description: "Return a screenshot after the action (default true)" }));

	pi.registerTool({
		name: "vm_screenshot",
		label: "vm screenshot",
		description: "Screenshot of a VM's desktop (DISPLAY=:1).",
		parameters: Type.Object({ vm: vmParam }),
		async execute(_id, p: any) {
			const s = await screenshot(pick(p.vm));
			return { content: [{ type: "text", text: s.text }, s.image], details: undefined };
		},
	});

	pi.registerTool({
		name: "vm_click",
		label: "vm click",
		description: "Click at (x, y), in screenshot pixels, on a VM's desktop.",
		parameters: Type.Object({
			x: Type.Number(),
			y: Type.Number(),
			button: Type.Optional(Type.String({ description: "left (default), right or middle" })),
			double: Type.Optional(Type.Boolean({ description: "Double-click" })),
			screenshot: shotParam,
			vm: vmParam,
		}),
		async execute(_id, p: any) {
			const vm = pick(p.vm);
			const b = { left: 1, middle: 2, right: 3 }[(p.button ?? "left") as string] ?? 1;
			await sshOk(vm, `${X}xdotool mousemove ${toScreen(vm, p.x)} ${toScreen(vm, p.y)} click ${p.double ? "--repeat 2 " : ""}${b}`);
			return afterAction(vm, `clicked ${p.button ?? "left"} at (${p.x}, ${p.y})`, p.screenshot);
		},
	});

	pi.registerTool({
		name: "vm_type",
		label: "vm type",
		description: "Type text into the focused window on a VM's desktop.",
		parameters: Type.Object({ text: Type.String(), screenshot: shotParam, vm: vmParam }),
		async execute(_id, p: any) {
			const vm = pick(p.vm);
			await sshOk(vm, `${X}xdotool type --clearmodifiers --delay 8 --file -`, { input: p.text });
			return afterAction(vm, `typed ${p.text.length} chars`, p.screenshot);
		},
	});

	pi.registerTool({
		name: "vm_key",
		label: "vm key",
		description: 'Press keys on a VM\'s desktop, xdotool syntax, space-separated: "Return", "ctrl+l", "ctrl+shift+t", "Escape".',
		parameters: Type.Object({ keys: Type.String(), screenshot: shotParam, vm: vmParam }),
		async execute(_id, p: any) {
			const vm = pick(p.vm);
			const keys = String(p.keys).trim().split(/\s+/);
			if (!keys.every((k) => /^[A-Za-z0-9_+\-]+$/.test(k))) throw new Error(`invalid key spec: ${p.keys}`);
			await sshOk(vm, `${X}xdotool key --clearmodifiers -- ${keys.join(" ")}`);
			return afterAction(vm, `pressed ${keys.join(" ")}`, p.screenshot);
		},
	});

	pi.registerTool({
		name: "vm_scroll",
		label: "vm scroll",
		description: "Scroll at (x, y), in screenshot pixels, on a VM's desktop.",
		parameters: Type.Object({
			x: Type.Number(),
			y: Type.Number(),
			direction: Type.String({ description: "up, down, left or right" }),
			amount: Type.Optional(Type.Number({ description: "Wheel clicks (default 5)" })),
			screenshot: shotParam,
			vm: vmParam,
		}),
		async execute(_id, p: any) {
			const vm = pick(p.vm);
			const btn = { up: 4, down: 5, left: 6, right: 7 }[p.direction as string];
			if (!btn) throw new Error("direction must be up, down, left or right");
			const n = Math.max(1, Math.min(50, Math.floor(p.amount ?? 5)));
			await sshOk(vm, `${X}xdotool mousemove ${toScreen(vm, p.x)} ${toScreen(vm, p.y)} click --repeat ${n} ${btn}`);
			return afterAction(vm, `scrolled ${p.direction} x${n}`, p.screenshot);
		},
	});

	pi.registerTool({
		name: "vm_browser",
		label: "vm browser",
		description:
			"Drive Google Chrome on a VM's desktop with Playwright (the user can watch it). `code` is the body of an async function receiving (page, context, browser); " +
			"its return value comes back as JSON. Chrome starts if needed and keeps state between calls. Example: `await page.goto('https://example.com'); return await page.title();`",
		parameters: Type.Object({
			code: Type.String(),
			screenshot: Type.Optional(Type.Boolean({ description: "Also return a screenshot of the page (default false)" })),
			timeout: Type.Optional(Type.Number({ description: "Seconds (default 60)" })),
			vm: vmParam,
		}),
		async execute(_id, p: any, signal: any) {
			const vm = pick(p.vm);
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
			const r = await sshRun(vm, script, { input: program, signal, timeoutMs: (p.timeout ?? 60) * 1000 });
			const m = r.stdout.toString().match(/__AVM__(.*)\n?$/s);
			if (!m) throw new Error(`browser script produced no result (exit ${r.code}): ${r.stderr.slice(-2000)}`);
			const res = JSON.parse(m[1]);
			if (!res.ok) throw new Error(res.error);
			const content: any[] = [{ type: "text", text: truncateHead(`url: ${res.url}\nresult: ${JSON.stringify(res.result, null, 2)}`, { maxLines: 2000 }).content }];
			if (res.shot) content.push({ type: "image", data: res.shot, mimeType: "image/png" });
			return { content, details: undefined };
		},
	});

	// ------------------------------------------------------------ VM lifecycle

	async function vmExists(name: string) {
		const out = await agentvmCli(["ls"], 60_000);
		return out.split("\n").some((l) => l.split(/\s+/)[0] === name);
	}

	function setCurrent(c: typeof current, ctx: any, persist = true) {
		current = c;
		if (persist) pi.appendEntry("agentvm-current", c ? { vm: c.name, ephemeral: c.ephemeral } : { vm: null });
		ctx?.ui?.setStatus?.("agentvm", c ? (ctx.ui.theme?.fg?.("accent", `⛁ vm:${c.name}`) ?? `vm:${c.name}`) : undefined);
	}

	async function useVm(name: string, ctx: any, ephemeral = false) {
		if (!VALID_NAME.test(name)) throw new Error(`invalid VM name "${name}"`);
		if (!(await vmExists(name))) {
			ctx?.ui?.notify?.(`agentvm: creating VM "${name}" (~15s)…`, "info");
			await agentvmCli(["new", name]);
		}
		await sshOk(name, "true", { timeoutMs: 30_000 });
		setCurrent({ name, ephemeral }, ctx);
	}

	const newName = () => `pi-${randomBytes(3).toString("hex")}`;

	pi.registerTool({
		name: "vm_manage",
		label: "vm manage",
		description:
			"Manage agentvm VMs (Ubuntu desktop VMs on the user's VM host). action: list | new | rm | snap | revert | use | none. " +
			"`use` makes NAME the current VM (default for all vm_* tools); `new` creates (and, with use=true, selects) a VM; `none` clears the current VM.",
		parameters: Type.Object({
			action: Type.String(),
			name: Type.Optional(Type.String()),
			snapshot: Type.Optional(Type.String({ description: "snapshot name for snap/revert" })),
			use: Type.Optional(Type.Boolean({ description: "for new: also make it the current VM" })),
		}),
		async execute(_id, p: any, _s, _u, ctx: any) {
			const need = () => {
				if (!p.name || !VALID_NAME.test(p.name)) throw new Error("a valid name is required");
				return p.name as string;
			};
			switch (p.action) {
				case "list":
					return text(`${await agentvmCli(["ls"], 60_000)}\ncurrent: ${current?.name ?? "(none)"}`);
				case "new": {
					const n = p.name ? need() : newName();
					const out = await agentvmCli(["new", n]);
					if (p.use) setCurrent({ name: n, ephemeral: false }, ctx);
					return text(`${out}${p.use ? `\ncurrent VM: ${n}` : ""}`);
				}
				case "rm": {
					const n = need();
					if (current?.name === n) setCurrent(null, ctx);
					return text(await agentvmCli(["rm", n], 120_000));
				}
				case "snap":
					return text(await agentvmCli(["snap", need(), ...(p.snapshot ? [p.snapshot] : [])], 600_000));
				case "revert":
					if (!p.snapshot) throw new Error("snapshot is required");
					return text(await agentvmCli(["revert", need(), p.snapshot], 600_000));
				case "use":
					await useVm(need(), ctx);
					return text(`current VM: ${p.name}`);
				case "none":
					setCurrent(null, ctx);
					return text("no current VM");
				default:
					throw new Error(`unknown action ${p.action}`);
			}
		},
	});

	// ------------------------------------------------------------ session wiring

	pi.on("session_start", async (_event, ctx) => {
		const flag = pi.getFlag("vm") as string | undefined;
		try {
			if (flag) {
				await (flag === "new" ? useVm(newName(), ctx, true) : useVm(flag, ctx));
				ctx.ui?.notify?.(`agentvm: current VM "${current!.name}". vm_* tools work there; built-in tools stay local.`, "info");
				return;
			}
			let last: any;
			for (const e of ctx.sessionManager.getBranch() as any[]) if (e.type === "custom" && e.customType === "agentvm-current") last = e.data;
			if (last?.vm) setCurrent({ name: last.vm, ephemeral: !!last.ephemeral }, ctx, false);
		} catch (e: any) {
			ctx.ui?.notify?.(`agentvm: ${e.message}`, "error");
			// Keep the requested name as current so vm_* tools report the failure instead of guessing.
			if (flag && flag !== "new" && VALID_NAME.test(flag)) setCurrent({ name: flag, ephemeral: false }, ctx, false);
		}
	});

	pi.on("session_shutdown", async (event) => {
		desktopProc?.kill();
		desktopProc = null;
		if (event.reason === "quit" && current?.ephemeral) await agentvmCli(["rm", current.name], 120_000).catch(() => {});
	});

	pi.on("before_agent_start", async (event) => {
		event.systemPromptOptions.sections.agentvm = current
			? [
					`The user's project work happens in a remote Linux VM named "${current.name}" (Ubuntu 24.04, user "agent", passwordless sudo), project directory ${PROJECT}.`,
					"Use the vm_* tools for that work: vm_bash, vm_read, vm_write, vm_edit (and vm_copy to move files between this machine and the VM).",
					"The built-in bash, read, write, edit, grep, find and ls tools act on the user's LOCAL machine, not the VM. Use them only when you deliberately need something local.",
					"The VM has an XFCE desktop on DISPLAY=:1 the user may be watching; GUI programs started via vm_bash appear there (start them detached: `setsid nohup prog >/dev/null 2>&1 &`).",
					"See and operate it with vm_screenshot, vm_click, vm_type, vm_key, vm_scroll (screenshot-pixel coordinates). For web pages prefer vm_browser (Playwright → Chrome on that desktop).",
					`Servers started in the VM are reachable from the user's machine with \`agentvm forward ${current.name} PORT\`. vm_manage lists/creates/removes/snapshots VMs; every vm_* tool takes an optional \`vm\`.`,
				].join("\n")
			: "agentvm is available: vm_manage creates and lists remote Linux desktop VMs; vm_bash/vm_read/vm_write/vm_edit/vm_copy and computer-use tools (vm_screenshot, vm_click, …, vm_browser) operate them (pass `vm`). The built-in tools act on the local machine.";
	});

	// ------------------------------------------------------------ /vm command

	pi.registerCommand("vm", {
		description: "agentvm: /vm [use NAME | new [NAME] | off | ls | rm NAME | desktop [NAME]]",
		handler: async (args, ctx) => {
			const [sub, arg] = (args ?? "").trim().split(/\s+/);
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
						const n = arg || newName();
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
						say(await agentvmCli(["ls"], 60_000));
						break;
					case "rm":
						if (!arg) throw new Error("usage: /vm rm NAME");
						if (current?.name === arg) setCurrent(null, ctx);
						say(await agentvmCli(["rm", arg], 120_000));
						break;
					case "desktop": {
						const name = arg || current?.name;
						if (!name) throw new Error("usage: /vm desktop [NAME]");
						desktopProc?.kill();
						desktopProc = spawn(AGENTVM, ["desktop", name], { stdio: "ignore" });
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
