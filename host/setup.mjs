// One-time host setup: init (state directory, settings, proxy and reaper services), build-base and
// add-key. Administrative: these run outside the lifecycle lock protocol (docs/lifecycle.md).
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { discover } from "./boxery-upgrade.mjs";
import { defaultConf, HOST_ENV } from "./config.mjs";
import { ensureHostKey, hasHostKey } from "./hostkeys.mjs";
import { baseUserdata } from "./seed.mjs";
import { fail, jsonArray, log, print, readFd, sleep, table } from "./util.mjs";
/** @import { Config } from "./config.mjs" */
/** @import { Runtime } from "./runtime.mjs" */

/** An initialized profile on this host. @typedef {{ name: string, conf: string, backend: string, proxyPort: string, proxyUnit: string, env: Record<string, string> }} HostProfile */

const PROXY_ENV = `# Optional upstream API keys for the boxery LLM proxy (stay on the host).
# ChatGPT/Codex OAuth is read from ~/.pi/agent/auth.json automatically.
# A VM can use a provider only after it's granted: boxery grant VM llm:chatgpt|openai|anthropic|ollama
#OPENAI_API_KEY=
# For a key in several OpenAI orgs/projects: which one VMs bill (VMs can't choose it themselves).
#OPENAI_ORG_ID=
#OPENAI_PROJECT_ID=
#ANTHROPIC_API_KEY=
`;
// runners.env: the GitHub runner manager's token (host/runners.mjs reads it; never sent to a VM).
export const RUNNERS_TOKEN_TEMPLATE = `# GitHub token for boxery's runner manager (boxery-host runners; docs/github-runners.md). Stays on the host.
# A fine-grained token: repository "Administration: read and write" for a repo's runners, or
# organization "Self-hosted runners: read and write" for an org's. Set it with: boxery-host runners token < FILE
#GITHUB_TOKEN=
`;

const which = (/** @type {string} */ cmd) => (process.env.PATH ?? "").split(":").some((d) => {
	try { accessSync(path.join(d || ".", cmd), constants.X_OK); return true; } catch { return false; }
});
const need = (/** @type {string} */ cmd) => { if (!which(cmd)) fail(`missing dependency: ${cmd}`); };
// quiet: discard stdout; silent: discard stderr too
/** @param {string} cmd @param {string[]} args @param {{ quiet?: boolean, silent?: boolean, check?: boolean }} [opts] @returns {Promise<number | null>} */
function run(cmd, args, { quiet = false, silent = false, check = true } = {}) {
	return new Promise((resolve, reject) => {
		spawn(cmd, args, { stdio: ["ignore", quiet || silent ? "ignore" : 2, silent ? "ignore" : 2] }).on("error", reject).on("close", (code) => {
			if (code !== 0 && check) reject(new Error(`${cmd} ${args.join(" ")} failed`)); else resolve(code);
		});
	});
}
/** @param {string} file @param {string} text */
function writeSecret(file, text) {
	writeFileSync(file, text, { mode: 0o600 });
	chmodSync(file, 0o600);
}

/** host.env: the settings later commands use when the environment doesn't set them.
 * @param {Pick<Config, "backend" | "proxyPort" | "proxyUnit" | "env">} config @param {string} node */
export function hostEnv(config, node) {
	const { env } = config;
	const lines = [`BOXERY_BACKEND=${config.backend}`, `BOXERY_PROXY_PORT=${config.proxyPort}`, `BOXERY_PROXY_UNIT=${config.proxyUnit}`,
		// host/boxery-host runs this node: nvm/fnm shims are often missing from PATH over ssh.
		`BOXERY_NODE=${node}`];
	for (const k of HOST_ENV) {
		if (["BOXERY_BACKEND", "BOXERY_PROXY_PORT", "BOXERY_PROXY_UNIT"].includes(k)) continue;
		if (k === "BOXERY_CH_SUDO" ? env[k] !== undefined : env[k]) lines.push(`${k}=${env[k]}`); // CH_SUDO "" (run as root) is a real value
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- profiles
// Several profiles can share a host: each has its own BOXERY_CONF (state, host.env), proxy port and
// service names. `--profile NAME` ones live in ~/.config/boxery-NAME; others are found from the
// services they installed.

const readEnvFile = (/** @type {string} */ file) => {
	/** @type {Record<string, string>} */
	const env = {};
	let text = "";
	try { text = readFileSync(file, "utf8"); } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; }
	for (const line of text.split("\n")) { const i = line.indexOf("="); if (i > 0) env[line.slice(0, i)] = line.slice(i + 1); }
	return env;
};

/** Every initialized profile on this host: {name, conf, backend, proxyPort, proxyUnit}.
 * @param {{ home?: string, services?: ReturnType<typeof discover> }} [opts] */
export function hostProfiles({ home = homedir(), services = discover() } = {}) {
	const def = defaultConf(), parent = path.dirname(def);
	const confs = new Set([def, ...services.profiles.keys(), ...services.others.map((o) => o.conf)]);
	try { for (const d of readdirSync(parent)) if (/^boxery-[a-z][a-z0-9-]{0,30}$/.test(d)) confs.add(path.join(parent, d)); }
	catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; }
	/** @type {HostProfile[]} */
	const out = [];
	for (const conf of [...confs].sort()) {
		if (!existsSync(path.join(conf, "host.env"))) continue;
		const env = readEnvFile(path.join(conf, "host.env"));
		const base = path.basename(conf);
		const name = conf === def ? "default" : path.dirname(conf) === parent && base.startsWith("boxery-") ? base.slice("boxery-".length) : conf.replace(home, "~");
		out.push({ name, conf, backend: env.BOXERY_BACKEND || "libvirt", proxyPort: env.BOXERY_PROXY_PORT || "8088", proxyUnit: env.BOXERY_PROXY_UNIT || "boxery-proxy", env });
	}
	return out;
}

// The settings that say where a backend keeps its VMs. Two profiles of one backend with the same
// values would manage the same VMs (and ports) under two lease stores. Backends not listed (fake, a
// new one) aren't checked.
/** @type {Record<string, RegExp>} */
const NAMESPACE = {
	libvirt: /^(BOXERY_(POOL|POOL_DIR|BASE_VOL|DOMAIN_PREFIX|NET)|LIBVIRT_DEFAULT_URI)$/,
	lima: /^(LIMA_HOME|BOXERY_LIMA_PREFIX)$/,
	"cloud-hypervisor": /^BOXERY_CH_(DIR|NET)$/,
	exe: /^BOXERY_EXE_(DIR|PORT_BASE)$/,
	boat: /^BOXERY_BOAT_(DIR|PORT_BASE)$/,
	openshell: /^BOXERY_OPENSHELL_(GATEWAY|WORKSPACE|PREFIX)$/,
};
/** @param {string} backend @param {Record<string, string | undefined>} env */
const namespace = (backend, env) => JSON.stringify(HOST_ENV.filter((k) => NAMESPACE[backend]?.test(k)).map((k) => env[k] || ""));

/** @param {number} port @returns {Promise<boolean>} */
const portFree = (port) => new Promise((resolve) => {
	const srv = createServer().once("error", () => resolve(false));
	srv.listen(Number(port), "127.0.0.1", () => srv.close(() => resolve(true)));
});

/** Fail if this profile would share a proxy port, service names or backend VMs with another one. */
/** @param {Runtime} rt @param {HostProfile[]} others */
function checkProfiles(rt, others) {
	const hint = rt.profile ? "" : " (a second profile on one host: boxery-host --profile NAME init --backend B)";
	for (const o of others) {
		if (o.proxyPort === rt.proxyPort) fail(`proxy port ${rt.proxyPort} is already used by profile ${o.name} (${o.conf}); set BOXERY_PROXY_PORT${hint}`);
		if (o.proxyUnit === rt.proxyUnit) fail(`service name ${rt.proxyUnit} is already used by profile ${o.name} (${o.conf}); set BOXERY_PROXY_UNIT${hint}`);
		if (NAMESPACE[rt.backend] && o.backend === rt.backend && namespace(o.backend, o.env) === namespace(rt.backend, rt.env)) {
			const keys = HOST_ENV.filter((k) => NAMESPACE[rt.backend].test(k));
			fail(`profile ${o.name} (${o.conf}) already uses the ${rt.backend} backend with the same settings, so both would manage the same VMs; ` +
				`give this one its own ${keys.join(", ")} or use another backend`);
		}
	}
}

/** A named profile's first init picks a proxy port no other profile uses and nothing listens on. */
/** @param {HostProfile[]} others */
async function pickProxyPort(others) {
	const taken = new Set(["8088", ...others.map((o) => o.proxyPort)]);
	for (let p = 8089; p < 8189; p++) if (!taken.has(String(p)) && await portFree(p)) return String(p);
	return fail("no free proxy port in 8089-8188; set BOXERY_PROXY_PORT");
}

/** @param {unknown} _rt @param {string[]} args */
export function profiles(_rt, [arg]) {
	const list = hostProfiles().map(({ env: _env, ...p }) => p);
	if (arg === "--json") return print(jsonArray(list));
	if (arg) fail("usage: profiles [--json]");
	print(table([16, 18, 7, 24], [["PROFILE", "BACKEND", "PORT", "UNIT", "CONF"], ...list.map((p) => [p.name, p.backend, p.proxyPort, p.proxyUnit, p.conf])]));
}

// ---------------------------------------------------------------- services
// The LLM proxy and the lease reaper: systemd user units on Linux, launchd agents on macOS.
/** @param {string} label @param {string[]} args @param {Record<string, string>} env @param {string} extra @param {string} log */
const plist = (label, args, env, extra, log) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict>
  ${extra}
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;

// Tools the reaper's backend calls may need. Services don't get the login shell's PATH, so the reaper's
// PATH names where they are now (nvm, ~/.local/bin, Homebrew…): Lima's limactl is often in ~/.local/bin.
const SERVICE_TOOLS = ["node", "jq", "nc", "ssh", "ssh-keygen", "ps", "socat", "limactl", "virsh", "virt-install", "qemu-img", "cloud-localds", "cloud-hypervisor"];
/** The reaper's PATH: node's directory, the directories of SERVICE_TOOLS on `searchPath`, then `system`.
 * @param {string} node @param {string} system */
export function servicePath(node, system, searchPath = process.env.PATH ?? "") {
	const dirs = [path.dirname(node)];
	for (const tool of SERVICE_TOOLS) {
		const dir = searchPath.split(":").find((d) => {
			if (!d.startsWith("/")) return false;
			try { accessSync(path.join(d, tool), constants.X_OK); return true; } catch { return false; }
		});
		if (dir) dirs.push(dir);
	}
	return [...new Set([...dirs, ...system.split(":")])].join(":");
}

/** {file: contents} for this platform. bind: the proxy's listen address (backend_proxy_bind or loopback).
 * The runner manager's file (runnersUnit) is installed but not enabled: `boxery-host runners start` does that.
 * @param {Pick<Config, "conf" | "root" | "proxyPort" | "proxyUnit" | "reaperUnit" | "runnersUnit" | "backend">} config
 * @param {{ node: string, bind: string, home?: string, platform?: NodeJS.Platform, searchPath?: string }} opts
 * @returns {Record<string, string>} */
export function serviceFiles({ conf, root, proxyPort, proxyUnit, reaperUnit, runnersUnit, backend }, { node, bind, home = homedir(), platform = process.platform, searchPath }) {
	const pathEnv = (/** @type {string} */ extra) => servicePath(node, `/usr/local/bin:${extra}`, searchPath);
	if (platform === "darwin") {
		const agents = path.join(home, "Library/LaunchAgents"), logs = path.join(home, "Library/Logs");
		return {
			[path.join(agents, `dev.${proxyUnit}.plist`)]: plist(`dev.${proxyUnit}`, [node, path.join(root, "proxy/boxery-proxy.mjs")],
				{ BOXERY_PROXY_PORT: proxyPort, BOXERY_PROXY_BIND: bind, BOXERY_CONF: conf }, "<key>KeepAlive</key><true/><key>RunAtLoad</key><true/>", path.join(logs, `${proxyUnit}.log`)),
			[path.join(agents, `dev.${reaperUnit}.plist`)]: plist(`dev.${reaperUnit}`, [path.join(root, "host/boxery-host"), "reap"],
				{ BOXERY_CONF: conf, PATH: pathEnv("/opt/homebrew/bin:/usr/bin:/bin") }, "<key>StartInterval</key><integer>60</integer>", path.join(logs, `${reaperUnit}.log`)),
			// launchd loads every agent in LaunchAgents at login, so this one is only there while it's started.
			[path.join(agents, `dev.${runnersUnit}.plist`)]: plist(`dev.${runnersUnit}`, [path.join(root, "host/boxery-host"), "runners", "run"],
				{ BOXERY_CONF: conf, PATH: pathEnv("/opt/homebrew/bin:/usr/bin:/bin") }, "<key>KeepAlive</key><true/><key>RunAtLoad</key><true/><key>ExitTimeOut</key><integer>180</integer>", path.join(logs, `${runnersUnit}.log`)),
		};
	}
	const units = path.join(home, ".config/systemd/user");
	return {
		[path.join(units, `${proxyUnit}.service`)]: `[Unit]
Description=boxery LLM proxy (per-VM tokens -> host credentials)
[Service]
Environment=BOXERY_PROXY_PORT=${proxyPort}
Environment=BOXERY_PROXY_BIND=${bind}
Environment=BOXERY_CONF=${conf}
ExecStart=${node} ${root}/proxy/boxery-proxy.mjs
Restart=always
RestartSec=2
[Install]
WantedBy=default.target
`,
		[path.join(units, `${reaperUnit}.service`)]: `[Unit]
Description=boxery: reset expired/orphaned leases
[Service]
Type=oneshot
Environment=BOXERY_CONF=${conf} BOXERY_BACKEND=${backend} PATH=${pathEnv("/usr/bin:/bin:/usr/sbin:/sbin")}
ExecStart=${root}/host/boxery-host reap
`,
		[path.join(units, `${reaperUnit}.timer`)]: `[Unit]
Description=boxery: lease reaper every minute
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s
[Install]
WantedBy=timers.target
`,
		// KillMode=mixed: SIGTERM reaches the manager only; the acquire/release it waits for finish (180 s at most).
		[path.join(units, `${runnersUnit}.service`)]: `[Unit]
Description=boxery: GitHub Actions runners on pool VMs (boxery-host runners)
[Service]
Environment=BOXERY_CONF=${conf} BOXERY_BACKEND=${backend} PATH=${pathEnv("/usr/bin:/bin:/usr/sbin:/sbin")}
ExecStart=${root}/host/boxery-host runners run
Restart=on-failure
RestartSec=30
KillMode=mixed
TimeoutStopSec=180
[Install]
WantedBy=default.target
`,
	};
}

/** (Re)load a launch agent. bootout returns before launchd has removed the job, and a bootstrap in that
 *  window fails with "5: Input/output error": wait for it to go (5 s at most), and retry a failed bootstrap.
 *  @param {string} domain @param {string} label @param {string} plist */
export async function reloadAgent(domain, label, plist) {
	await run("launchctl", ["bootout", `${domain}/${label}`], { silent: true, check: false }); // not loaded yet is fine
	for (let i = 0; i < 50 && await run("launchctl", ["print", `${domain}/${label}`], { silent: true, check: false }) === 0; i++) await sleep(100);
	for (let attempt = 1; attempt < 5; attempt++) {
		if (await run("launchctl", ["bootstrap", domain, plist], { silent: true, check: false }) === 0) return;
		await sleep(500);
	}
	await run("launchctl", ["bootstrap", domain, plist]); // the last try shows launchctl's error
}

// launchd's gui/<uid> domain and systemd's user manager belong to the account, not to $HOME. With HOME
// pointed elsewhere (a test's temp dir), loading this profile's services would replace the account's real
// ones of the same name (dev.boxery-proxy) with a job whose files are elsewhere, and launchd/systemd would
// not find them again at the next login. Tests that stub launchctl and systemctl set BOXERY_STUB_SERVICES=1.
function checkServiceHome() {
	if (process.env.BOXERY_STUB_SERVICES === "1") return;
	let account;
	try { account = userInfo().homedir; } catch { return; } // no passwd entry (some containers): nothing to compare
	const real = (/** @type {string} */ p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
	if (real(homedir()) !== real(account)) fail(`HOME=${homedir()} is not this account's home (${account}): init installs services for the account, so run it with HOME=${account}`);
}

/** @param {Runtime} rt @param {{ reaper: boolean }} opts */
async function startServices(rt, { reaper }) {
	const bind = await rt.vms.has("backend_proxy_bind") ? (await rt.vms.call("backend_proxy_bind", [], { capture: true })).trim() : "127.0.0.1";
	const files = serviceFiles(rt, { node: process.execPath, bind });
	// The runner manager (host/runners.mjs) runs only once `runners start` turned it on. Re-running init (an
	// upgrade) restarts it if it runs, so it runs the new code. On macOS its agent exists only while started.
	const runnersFile = Object.keys(files).find((f) => path.basename(f).startsWith(process.platform === "darwin" ? `dev.${rt.runnersUnit}.` : `${rt.runnersUnit}.`));
	const runnersOn = reaper && (process.platform === "darwin" ? Boolean(runnersFile && existsSync(runnersFile))
		: (await run("systemctl", ["--user", "is-active", "--quiet", `${rt.runnersUnit}.service`], { silent: true, check: false })) === 0);
	for (const [file, text] of Object.entries(files)) {
		if (!reaper && (file.includes(rt.reaperUnit) || file === runnersFile)) continue;
		if (process.platform === "darwin" && file === runnersFile && !runnersOn) continue;
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	}
	if (process.platform === "darwin") {
		mkdirSync(path.join(homedir(), "Library/Logs"), { recursive: true });
		const uid = /** @type {() => number} */ (process.getuid)();
		for (const unit of [rt.proxyUnit, ...(reaper ? [rt.reaperUnit] : []), ...(runnersOn ? [rt.runnersUnit] : [])]) {
			await reloadAgent(`gui/${uid}`, `dev.${unit}`, path.join(homedir(), "Library/LaunchAgents", `dev.${unit}.plist`));
		}
	} else {
		// The backend's guest → proxy bridge units (may be none).
		// Named after this profile's proxy unit, which is passed explicitly: two profiles of one backend
		// must not share a bridge (#117).
		const extra = (await rt.vms.call("backend_proxy_services", [], { capture: true, extraEnv: { BOXERY_PROXY_UNIT: rt.proxyUnit } })).split(/\s+/).filter(Boolean);
		await run("systemctl", ["--user", "daemon-reload"]);
		await run("systemctl", ["--user", "enable", "--now", `${rt.proxyUnit}.service`, ...extra], { quiet: true });
		await run("systemctl", ["--user", "restart", `${rt.proxyUnit}.service`, ...extra]);
		if (reaper) await run("systemctl", ["--user", "enable", "--now", `${rt.reaperUnit}.timer`], { quiet: true });
		// --no-block: an upgrade runs init under the host-wide lock; don't wait for the manager's shutdown
		// (a SIGTERM that isn't `runners stop` leaves its leases for the next manager: host/runners.mjs).
		if (runnersOn) await run("systemctl", ["--user", "restart", "--no-block", `${rt.runnersUnit}.service`]);
	}
	await sleep(1000);
}

/** VMs made before host keys were pinned (#70) have no record, and every ssh to them is refused. Pin the
 *  running ones through a channel their network can't spoof (hostkeys.mjs trustedKey); say which are left
 *  for `boxery pin`. Best effort: init never fails over it. @param {Runtime} rt */
async function pinExisting(rt) {
	let vms;
	try { vms = await rt.vms.list({ quiet: true }); } catch { return; }
	const left = [];
	for (const vm of vms) {
		if (hasHostKey(rt.conf, vm.name) && !await rt.vms.has("backend_platform_host_key")) continue;
		if (vm.state !== "running") { if (!hasHostKey(rt.conf, vm.name)) left.push(vm.name); continue; }
		try {
			if (await ensureHostKey(rt, vm.name, await rt.vms.sshEndpoint(vm.name, { quiet: true }))) left.push(vm.name);
		} catch { left.push(vm.name); }
	}
	if (left.length) log(`${left.length} VM(s) have no pinned ssh host key yet (${left.join(", ")}): boxery start pins a stopped one; for a running one run boxery pin NAME`);
}

// ---------------------------------------------------------------- commands
/** @param {Runtime} rt */
export async function init(rt) {
	const others = hostProfiles().filter((p) => path.resolve(p.conf) !== rt.conf);
	if (rt.profile && !rt.env.BOXERY_PROXY_PORT) {
		// First init of a named profile (later ones read the port back from its host.env). Loaded here:
		// the runtime needs node:sqlite, and this module also loads on older Node (tests, build-base).
		const { createRuntime } = await import("./runtime.mjs");
		const sub = createRuntime({ ...process.env, BOXERY_PROXY_PORT: await pickProxyPort(others) });
		try { return await initProfile(sub, others); } finally { sub.close(); }
	}
	return initProfile(rt, others);
}

/** @param {Runtime} rt @param {HostProfile[]} others */
async function initProfile(rt, others) {
	checkServiceHome();
	// Only a profile's first init: re-running init (or an upgrade) never fails over an existing setup.
	if (!existsSync(path.join(rt.conf, "host.env"))) checkProfiles(rt, others);
	need("nc"); need("ps");
	await rt.vms.call("backend_check");
	mkdirSync(rt.conf, { recursive: true });
	chmodSync(rt.conf, 0o700);
	const tokens = path.join(rt.conf, "tokens.json");
	if (!existsSync(tokens)) writeFileSync(tokens, "{}\n");
	chmodSync(tokens, 0o600);
	const keys = path.join(rt.conf, "authorized_keys");
	if (!existsSync(keys)) writeFileSync(keys, "");
	chmodSync(keys, 0o600);
	rt.guest.hostPubkey();
	for (const [name, template] of [["proxy.env", PROXY_ENV], ["runners.env", RUNNERS_TOKEN_TEMPLATE]]) {
		const file = path.join(rt.conf, name);
		if (!existsSync(file)) writeSecret(file, template);
		chmodSync(file, 0o600);
	}
	writeFileSync(path.join(rt.conf, "host.env"), hostEnv(rt, process.execPath));
	await rt.vms.call("backend_init");
	await pinExisting(rt);
	mkdirSync(path.join(homedir(), ".local/bin"), { recursive: true });
	if (!process.env.BOXERY_CONF) {
		for (const [link, target] of [["boxery-host", "host/boxery-host"], ["boxery", "controller/boxery"]]) {
			const file = path.join(homedir(), ".local/bin", link);
			try { unlinkSync(file); } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; }
			symlinkSync(path.join(rt.root, target), file);
		}
	}
	if (rt.backend !== "openshell") await startServices(rt, { reaper: !process.env.BOXERY_NO_SERVICES });
	if (rt.profile) log(`profile ${rt.profile}: ${rt.backend} backend, ${rt.conf}, proxy port ${rt.proxyPort}, services ${rt.proxyUnit}/${rt.reaperUnit}`);
	log(`init done. Next: boxery-host ${rt.profile ? `--profile ${rt.profile} ` : ""}${rt.backend === "openshell" ? "new demo --headless" : "build-base"}`);
}

/** @param {Runtime} rt */
export async function buildBase(rt) {
	await rt.vms.call("backend_check");
	// The desktop build's cloud-config: image/base-user-data.yaml with the layers filled in.
	const file = path.join(rt.cache, "base-user-data.yaml");
	mkdirSync(rt.cache, { recursive: true });
	writeFileSync(`${file}.tmp`, baseUserdata(rt.root, await rt.vms.layerFiles()));
	renameSync(`${file}.tmp`, file);
	await rt.vms.call("backend_build_base", [], { extraEnv: { BASE_USERDATA: file } });
}

/** Authorize a controller's ssh key (stdin) for VMs created from now on. @param {Runtime} rt */
export function addKey(rt) {
	const key = readFd(0).replace(/\n+$/, "");
	if (!key.startsWith("ssh-") && !key.startsWith("ecdsa-")) fail("expected an ssh public key on stdin");
	mkdirSync(rt.conf, { recursive: true });
	const file = path.join(rt.conf, "authorized_keys");
	let text = "";
	try { text = readFileSync(file, "utf8"); } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; }
	if (!text.split("\n").includes(key)) text += `${text && !text.endsWith("\n") ? "\n" : ""}${key}\n`;
	writeFileSync(file, text);
	log(`key registered (${text.split("\n").length - 1} total)`);
}
