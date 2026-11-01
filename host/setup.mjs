// One-time host setup: init (state directory, settings, proxy and reaper services), build-base and
// add-key. Administrative: these run outside the lifecycle lock protocol (docs/lifecycle.md).
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOST_ENV } from "./config.mjs";
import { baseUserdata } from "./seed.mjs";
import { fail, log, readFd, sleep } from "./util.mjs";

const PROXY_ENV = `# Optional upstream API keys for the boxery LLM proxy (stay on the host).
# ChatGPT/Codex OAuth is read from ~/.pi/agent/auth.json automatically.
#OPENAI_API_KEY=
#ANTHROPIC_API_KEY=
`;

const which = (cmd) => (process.env.PATH ?? "").split(":").some((d) => {
	try { accessSync(path.join(d || ".", cmd), constants.X_OK); return true; } catch { return false; }
});
const need = (cmd) => { if (!which(cmd)) fail(`missing dependency: ${cmd}`); };
// quiet: discard stdout; silent: discard stderr too
function run(cmd, args, { quiet = false, silent = false, check = true } = {}) {
	return new Promise((resolve, reject) => {
		spawn(cmd, args, { stdio: ["ignore", quiet || silent ? "ignore" : 2, silent ? "ignore" : 2] }).on("error", reject).on("close", (code) => {
			if (code !== 0 && check) reject(new Error(`${cmd} ${args.join(" ")} failed`)); else resolve(code);
		});
	});
}
function writeSecret(file, text) {
	writeFileSync(file, text, { mode: 0o600 });
	chmodSync(file, 0o600);
}

/** host.env: the settings later commands use when the environment doesn't set them. */
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

// ---------------------------------------------------------------- services
// The LLM proxy and the lease reaper: systemd user units on Linux, launchd agents on macOS.
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
/** The reaper's PATH: node's directory, the directories of SERVICE_TOOLS on `searchPath`, then `system`. */
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

/** {file: contents} for this platform. bind: the proxy's listen address (backend_proxy_bind or loopback). */
export function serviceFiles({ conf, root, proxyPort, proxyUnit, reaperUnit, backend }, { node, bind, home = homedir(), platform = process.platform, searchPath }) {
	const pathEnv = (extra) => servicePath(node, `/usr/local/bin:${extra}`, searchPath);
	if (platform === "darwin") {
		const agents = path.join(home, "Library/LaunchAgents"), logs = path.join(home, "Library/Logs");
		return {
			[path.join(agents, `dev.${proxyUnit}.plist`)]: plist(`dev.${proxyUnit}`, [node, path.join(root, "proxy/boxery-proxy.mjs")],
				{ BOXERY_PROXY_PORT: proxyPort, BOXERY_PROXY_BIND: bind, BOXERY_CONF: conf }, "<key>KeepAlive</key><true/><key>RunAtLoad</key><true/>", path.join(logs, `${proxyUnit}.log`)),
			[path.join(agents, `dev.${reaperUnit}.plist`)]: plist(`dev.${reaperUnit}`, [path.join(root, "host/boxery-host"), "reap"],
				{ BOXERY_CONF: conf, PATH: pathEnv("/opt/homebrew/bin:/usr/bin:/bin") }, "<key>StartInterval</key><integer>60</integer>", path.join(logs, `${reaperUnit}.log`)),
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
	};
}

async function startServices(rt, { reaper }) {
	const bind = await rt.vms.has("backend_proxy_bind") ? (await rt.vms.call("backend_proxy_bind", [], { capture: true })).trim() : "127.0.0.1";
	const files = serviceFiles(rt, { node: process.execPath, bind });
	for (const [file, text] of Object.entries(files)) {
		if (!reaper && file.includes(rt.reaperUnit)) continue;
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	}
	if (process.platform === "darwin") {
		mkdirSync(path.join(homedir(), "Library/Logs"), { recursive: true });
		const uid = process.getuid();
		for (const unit of [rt.proxyUnit, ...(reaper ? [rt.reaperUnit] : [])]) {
			await run("launchctl", ["bootout", `gui/${uid}/dev.${unit}`], { silent: true, check: false }); // not loaded yet is fine
			await run("launchctl", ["bootstrap", `gui/${uid}`, path.join(homedir(), "Library/LaunchAgents", `dev.${unit}.plist`)]);
		}
	} else {
		// The backend's guest → proxy bridge units (may be none).
		const extra = (await rt.vms.call("backend_proxy_services", [], { capture: true })).split(/\s+/).filter(Boolean);
		await run("systemctl", ["--user", "daemon-reload"]);
		await run("systemctl", ["--user", "enable", "--now", `${rt.proxyUnit}.service`, ...extra], { quiet: true });
		await run("systemctl", ["--user", "restart", `${rt.proxyUnit}.service`, ...extra]);
		if (reaper) await run("systemctl", ["--user", "enable", "--now", `${rt.reaperUnit}.timer`], { quiet: true });
	}
	await sleep(1000);
}

// ---------------------------------------------------------------- commands
export async function init(rt) {
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
	const proxyEnv = path.join(rt.conf, "proxy.env");
	if (!existsSync(proxyEnv)) writeSecret(proxyEnv, PROXY_ENV);
	chmodSync(proxyEnv, 0o600);
	writeFileSync(path.join(rt.conf, "host.env"), hostEnv(rt, process.execPath));
	await rt.vms.call("backend_init");
	mkdirSync(path.join(homedir(), ".local/bin"), { recursive: true });
	if (!process.env.BOXERY_CONF) {
		for (const [link, target] of [["boxery-host", "host/boxery-host"], ["boxery", "controller/boxery"]]) {
			const file = path.join(homedir(), ".local/bin", link);
			try { unlinkSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
			symlinkSync(path.join(rt.root, target), file);
		}
	}
	await startServices(rt, { reaper: !process.env.BOXERY_NO_SERVICES });
	log("init done. Next: boxery-host build-base");
}

export async function buildBase(rt) {
	await rt.vms.call("backend_check");
	// The desktop build's cloud-config: image/base-user-data.yaml with the layers filled in.
	const file = path.join(rt.cache, "base-user-data.yaml");
	mkdirSync(rt.cache, { recursive: true });
	writeFileSync(`${file}.tmp`, baseUserdata(rt.root, await rt.vms.layerFiles()));
	renameSync(`${file}.tmp`, file);
	await rt.vms.call("backend_build_base", [], { extraEnv: { BASE_USERDATA: file } });
}

/** Authorize a controller's ssh key (stdin) for VMs created from now on. */
export function addKey(rt) {
	const key = readFd(0).replace(/\n+$/, "");
	if (!key.startsWith("ssh-") && !key.startsWith("ecdsa-")) fail("expected an ssh public key on stdin");
	mkdirSync(rt.conf, { recursive: true });
	const file = path.join(rt.conf, "authorized_keys");
	let text = "";
	try { text = readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
	if (!text.split("\n").includes(key)) text += `${text && !text.endsWith("\n") ? "\n" : ""}${key}\n`;
	writeFileSync(file, text);
	log(`key registered (${text.split("\n").length - 1} total)`);
}
