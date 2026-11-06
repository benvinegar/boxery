// A VM's desktop in a browser on this machine: a fresh VNC password for the session, and an ssh tunnel to
// its noVNC (127.0.0.1:PORT → the VM's 6080). Shared by `boxery desktop` and pi's /vm desktop.
//
// The VM's VNC server asks for a password (image/layers/desktop.sh): each session sets a fresh one and hands
// it to noVNC in the URL fragment, which the browser never sends, so it stays out of logs. It replaces the
// previous session's for new logins; connections already open stay.
import { spawn } from "node:child_process";
import net from "node:net";
import { assertName, currentHost, sshRun } from "./boxery-core.mjs";
import { profileConfig } from "./profile.mjs";

const SETUP = 'if test -e /etc/boxery/headless; then echo headless\nelif command -v boxery-vnc-password >/dev/null; then p=$(boxery-vnc-password --new) && echo "password $p"\nelse echo nopassword; fi';

/** The first free local TCP port from START. @param {number} start */
export async function freePort(start) {
	for (let p = start; p < start + 1000; p++) {
		const free = await new Promise((resolve) => {
			const sock = net.connect({ port: p, host: "127.0.0.1" });
			sock.once("connect", () => { sock.destroy(); resolve(false); });
			sock.once("error", () => resolve(true));
		});
		if (free) return p;
	}
	throw new Error(`no free local port from ${start}`);
}

/**
 * Prepare VM NAME's desktop: a fresh VNC password, a free local port and the URL. warning: an image from
 * before VNC passwords (its desktop is open to this machine while the tunnel is). Throws for a headless or
 * unreachable VM, with ssh's or the VM's reason. terminal: ssh may ask (a key's passphrase), as in the CLI.
 * @param {string} name @param {{ terminal?: boolean }} [opts] @returns {Promise<{ url: string, port: number, warning: string | null }>}
 */
export async function prepareDesktop(name, { terminal = false } = {}) {
	assertName(name);
	const { env } = await profileConfig();
	const r = await sshRun(name, SETUP, { timeoutMs: terminal ? 0 : 60_000, env, batch: !terminal });
	const out = r.stdout.toString("utf8").trim();
	const why = r.stderr.trim().split("\n").slice(-3).join(" ");
	let pw = "", warning = null;
	if (out === "headless") throw new Error(`${name} is headless (boxery new --headless): it has no desktop`);
	else if (out.startsWith("password ")) { pw = out.slice(9); if (!/^[A-Za-z0-9]+$/.test(pw)) throw new Error(`unexpected VNC password from ${name}`); }
	else if (out === "nopassword") warning = `${name}'s desktop has no VNC password: its image predates it, so while this tunnel is open any process on this machine (or a web page) can use it. Rebuild the desktop base (boxery build-base) and create the VM again.`;
	else throw new Error(`couldn't set up the desktop of ${name} (is it running? boxery ls)${why ? `: ${why}` : ""}`);
	const port = await freePort(16080);
	return { url: `http://127.0.0.1:${port}/vnc.html?autoconnect=1&resize=remote&reconnect=1${pw ? `#password=${pw}` : ""}`, port, warning };
}

/** ssh's arguments for the tunnel to NAME's noVNC on local PORT (a connection of its own). batch: nothing may
 *  ask (no terminal to answer in: pi). @param {string} name @param {number} port @param {{ batch?: boolean }} [opts] */
export const tunnelArgs = (name, port, { batch = false } = {}) => ["-F", currentHost().sshConf, "-N", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ExitOnForwardFailure=yes",
	...(batch ? ["-o", "BatchMode=yes"] : []), "-L", `127.0.0.1:${port}:127.0.0.1:6080`, `${assertName(name)}.boxery`];

/** Open URL in the browser (macOS open, else xdg-open). false if neither could start. @param {string} url @returns {Promise<boolean>} */
export function openUrl(url) {
	return new Promise((resolve) => {
		const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
		child.once("error", () => resolve(false));
		child.once("spawn", () => { child.unref(); resolve(true); });
	});
}

/**
 * For a long-lived process (pi): open NAME's desktop and keep its tunnel in the background, sharing no stdio
 * (ssh in batch mode: nothing can ask), until close() (or the tunnel ends). open: also open it in the browser
 * once the tunnel is up; opened says whether that worked.
 * @param {string} name @param {{ open?: boolean }} [opts]
 * @returns {Promise<{ url: string, warning: string | null, opened: boolean, close: () => void, ended: Promise<number> }>}
 */
export async function openDesktop(name, { open = true } = {}) {
	const { url, port, warning } = await prepareDesktop(name);
	const { env } = await profileConfig();
	const child = spawn("ssh", tunnelArgs(name, port, { batch: true }), { stdio: "ignore", env });
	const ended = new Promise((resolve) => { child.once("error", () => resolve(127)); child.once("exit", (code) => resolve(code ?? 1)); });
	// Up once the port answers and our ssh is still there (another program taking the port first makes ssh
	// exit: ExitOnForwardFailure). A slow ProxyCommand or jump host gets 30 s.
	const alive = () => child.exitCode === null && child.signalCode === null;
	let up = false;
	for (let i = 0; i < 300 && alive() && !up; i++) {
		if (!(await freePortAt(port))) { await new Promise((r) => setTimeout(r, 200)); up = alive(); }
		else await new Promise((r) => setTimeout(r, 100));
	}
	if (!up) { child.kill(); throw new Error(`the tunnel to ${name}'s desktop didn't come up (is it running? boxery ls)`); }
	const opened = open ? await openUrl(url) : false;
	return { url, warning, opened, close: () => { child.kill(); }, ended };
}
/** Is local PORT free (nothing listening)? @param {number} port */
async function freePortAt(port) {
	return new Promise((resolve) => {
		const sock = net.connect({ port, host: "127.0.0.1" });
		sock.once("connect", () => { sock.destroy(); resolve(false); });
		sock.once("error", () => resolve(true));
	});
}
