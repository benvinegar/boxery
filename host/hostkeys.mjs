// Pinned ssh host keys (#70). Every VM's sshd presents an ed25519 host key that boxery knows, and every
// ssh to a VM checks it: StrictHostKeyChecking=yes under HostKeyAlias=NAME.boxery, against the record
// $CONF/host-keys/NAME (one known_hosts line). The host's own ssh (guest.mjs, backend.sh) reads the
// record directly; controllers get it from `boxery-host known-hosts NAME` (their KnownHostsCommand). A
// guest that answers on another VM's address (a spoofed IP, a stale DHCP lease) presents the wrong key
// and is refused, so it never receives that VM's pushed grants, agent forward or proxy token.
//
// Where the key comes from:
//   - seeded (every backend but boat): the host generates the pair, the VM's seed writes it to
//     /etc/ssh/boxery_host_ed25519_key with an sshd drop-in that makes it sshd's only host key
//     (seed.mjs), and the public half is recorded before the VM boots. A new seed (new, fork, new
//     --from) means a new pair; an image carries its VM's key, so revert and pool resets keep the
//     record; rm removes it.
//   - platform (boat): the platform reports each machine's key through its API (backend_platform_host_key);
//     the record is refreshed from it whenever the VM may have moved (every wait for ssh).
// A VM made before this has no record. It is pinned automatically only through a channel a guest can't
// spoof: the hypervisor (backend_host_key: libvirt's guest agent) or a loopback endpoint the host itself
// forwards (Lima, exe, boat tunnels). Otherwise `boxery-host pin NAME --from-guest` trusts what it
// answers once (docs/security.md).
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fail, validName } from "./util.mjs";
/** @import { Runtime } from "./runtime.mjs" */
/** @import { GuestEndpoint } from "./guest.mjs" */

const KEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;
const normal = (/** @type {unknown} */ key) => String(key ?? "").trim().split(/\s+/).slice(0, 2).join(" ");
/** The ssh HostKeyAlias every boxery ssh uses for VM NAME (also the controller's Host pattern). */
export const hostAlias = (/** @type {string} */ name) => `${name}.boxery`;
export const hostKeysDir = (/** @type {string} */ conf) => path.join(conf, "host-keys");
/** NAME's known_hosts file (exists only while NAME has a pinned key). */
export const hostKeyFile = (/** @type {string} */ conf, /** @type {string} */ name) => path.join(hostKeysDir(conf), validName(name));

/** NAME's pinned public key ("ssh-ed25519 AAAA…"), or null if it has none.
 *  @param {string} conf @param {string} name @returns {string | null} */
export function hostKey(conf, name) {
	let line;
	try { line = readFileSync(hostKeyFile(conf, name), "utf8").trim(); }
	catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null; throw e; }
	const [alias, ...key] = line.split(/\s+/);
	const k = key.slice(0, 2).join(" ");
	return alias === hostAlias(name) && KEY.test(k) ? k : null;
}
export const hasHostKey = (/** @type {string} */ conf, /** @type {string} */ name) => hostKey(conf, name) !== null;
/** Record KEY as NAME's host key (atomically). Returns the normalized key.
 *  @param {string} conf @param {string} name @param {string} key @returns {string} */
export function setHostKey(conf, name, key) {
	const k = normal(key);
	if (!KEY.test(k)) fail(`not an ed25519 ssh public key: ${String(key).slice(0, 80)}`);
	mkdirSync(hostKeysDir(conf), { recursive: true, mode: 0o700 });
	const f = hostKeyFile(conf, name), t = `${f}.${process.pid}.tmp`;
	writeFileSync(t, `${hostAlias(name)} ${k}\n`, { mode: 0o600 });
	renameSync(t, f);
	return k;
}
export const deleteHostKey = (/** @type {string} */ conf, /** @type {string} */ name) => rmSync(hostKeyFile(conf, name), { force: true });

// OpenSSH's private key format ("openssh-key-v1", unencrypted), written by hand so that making a host key
// needs neither ssh-keygen nor a temporary file holding the private key.
const sshString = (/** @type {Buffer} */ b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
/** A new ed25519 host key pair for NAME: {private (OpenSSH PEM), public ("ssh-ed25519 AAAA…")}.
 *  @param {string} name @returns {{ private: string, public: string }} */
export function newHostKey(name) {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const pub = Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url");
	const seed = Buffer.from(String(privateKey.export({ format: "jwk" }).d), "base64url");
	const type = Buffer.from("ssh-ed25519"), blob = Buffer.concat([sshString(type), sshString(pub)]);
	const check = randomBytes(4);
	let priv = Buffer.concat([check, check, sshString(type), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(Buffer.from(`boxery:${name}`))]);
	priv = Buffer.concat([priv, Buffer.from([1, 2, 3, 4, 5, 6, 7]).subarray(0, (8 - (priv.length % 8)) % 8)]);
	const none = sshString(Buffer.from("none")), one = Buffer.from([0, 0, 0, 1]);
	const body = Buffer.concat([Buffer.from("openssh-key-v1\0"), none, none, sshString(Buffer.alloc(0)), one, sshString(blob), sshString(priv)]);
	return {
		private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${(body.toString("base64").match(/.{1,70}/g) ?? []).join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
		public: `ssh-ed25519 ${blob.toString("base64")}`,
	};
}

/** The key's SHA256 fingerprint, as ssh prints it. @param {string} key */
export function fingerprint(key) {
	const b = Buffer.from(normal(key).split(" ")[1] ?? "", "base64");
	return `SHA256:${createHash("sha256").update(b).digest("base64").replace(/=+$/, "")}`;
}

/** The ed25519 key the sshd at EP presents (ssh-keyscan). Over the network: trust on first use.
 *  @param {GuestEndpoint} ep @returns {string | null} */
export function scanKey({ host, port }) {
	const r = spawnSync("ssh-keyscan", ["-T", "10", "-t", "ed25519", "-p", String(port), host], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const line = (r.stdout ?? "").split("\n").find((l) => / ssh-ed25519 /.test(l));
	return line ? normal(line.split(/\s+/).slice(1).join(" ")) : null;
}
const loopback = (/** @type {string} */ host) => host === "localhost" || /^127\./.test(host) || host === "::1";

/** The key NAME's guest presents, read through a channel no other guest can answer on: the platform's
 *  API (boat), the hypervisor (libvirt's guest agent), or a loopback endpoint the host forwards (Lima,
 *  exe, boat). null if there is none, or it can't tell (yet).
 *  @param {Runtime} rt @param {string} name @param {GuestEndpoint} [ep] @returns {Promise<{ key: string, how: string } | null>} */
export async function trustedKey(rt, name, ep) {
	for (const fn of ["backend_platform_host_key", "backend_host_key"]) {
		if (!await rt.vms.has(fn)) continue;
		try {
			const k = normal(await rt.vms.call(fn, [name], { capture: true, quiet: true }));
			if (KEY.test(k)) return { key: k, how: fn === "backend_host_key" ? "the hypervisor" : `the ${rt.backend} API` };
		} catch { /* not running yet, no guest agent: try the next way */ }
	}
	if (ep && loopback(ep.host)) {
		const k = scanKey(ep);
		if (k) return { key: k, how: `its endpoint on this host's loopback (${ep.host}:${ep.port})` };
	}
	return null;
}

/** Before boxery's own ssh to NAME: refresh a platform-managed key (boat moves VMs between machines),
 *  and pin a VM that has no record through a trusted channel. Returns why NAME can't be checked, or null.
 *  @param {Runtime} rt @param {string} name @param {GuestEndpoint} ep @returns {Promise<string | null>} */
export async function ensureHostKey(rt, name, ep) {
	const platform = await rt.vms.has("backend_platform_host_key");
	if (!platform && hasHostKey(rt.conf, name)) return null;
	const t = await trustedKey(rt, name, ep);
	if (t) {
		const before = hostKey(rt.conf, name);
		const k = setHostKey(rt.conf, name, t.key);
		if (before !== k) rt.log(`${name}: pinned ssh host key ${fingerprint(k)} from ${t.how}`);
		return null;
	}
	if (platform && hasHostKey(rt.conf, name)) return null; // the API was briefly unavailable: keep the last one
	return `no pinned ssh host key for ${name} (a VM made before boxery pinned keys, or its record was lost); ` +
		`if you trust the network path to it, run: boxery pin ${name} --from-guest`;
}

/** `boxery-host known-hosts NAME`: NAME's known_hosts line on stdout (a controller's KnownHostsCommand).
 *  NAME may end in .boxery. Prints nothing for a VM without a record: ssh then refuses it.
 *  @param {Runtime} rt @param {string[]} args */
export function knownHosts(rt, [name = ""]) {
	const n = name.replace(/\.boxery$/, "");
	validName(n);
	const k = hostKey(rt.conf, n);
	if (k) process.stdout.write(`${hostAlias(n)} ${k}\n`);
}

/** `boxery-host pin NAME [--from-guest]`: (re-)record running NAME's host key. Through a trusted channel
 *  if there is one (hypervisor, platform API, loopback endpoint); --from-guest falls back to what NAME's
 *  ssh endpoint answers, trusting it once. Prints the fingerprint. @param {Runtime} rt @param {string[]} args */
export async function pin(rt, args) {
	const names = args.filter((a) => !a.startsWith("-"));
	for (const a of args) if (a.startsWith("-") && a !== "--from-guest") fail(`unknown flag ${a}`);
	if (names.length !== 1) fail("usage: pin NAME [--from-guest]");
	const name = validName(names[0]);
	rt.requireLock(name);
	if (!await rt.vms.exists(name)) fail(`no such vm: ${name}`);
	const ep = await rt.vms.sshEndpoint(name).catch(() => fail(`${name} isn't running; start it first`));
	let t = await trustedKey(rt, name, ep);
	if (!t) {
		if (!args.includes("--from-guest")) {
			fail(`cannot read ${name}'s host key through the ${rt.backend} hypervisor (no guest agent?); ` +
				`if you trust the network path to ${ep.host}:${ep.port}, run: boxery pin ${name} --from-guest`);
		}
		const k = scanKey(ep);
		if (!k) fail(`no ed25519 ssh host key from ${ep.host}:${ep.port}`);
		t = { key: k, how: `its ssh endpoint ${ep.host}:${ep.port} (trusted on first use)` };
	}
	const before = hostKey(rt.conf, name);
	const k = setHostKey(rt.conf, name, t.key);
	rt.log(`${name}: pinned ssh host key ${fingerprint(k)} from ${t.how}${before && before !== k ? `; it replaces ${fingerprint(before)}` : ""}`);
	process.stdout.write(`${fingerprint(k)}\n`);
}

/** Seed files (cloud-config write_files) that make KEY sshd's only host key. The drop-in sorts before
 *  the image's own and HostKey replaces sshd's default list. Not named ssh_host_*: images and identity
 *  scripts delete those. @param {{ private: string, public: string }} key @returns {[string, string, string][]} */
export function hostKeySeedFiles(key) {
	return [
		["/etc/ssh/boxery_host_ed25519_key", key.private, "0600"],
		["/etc/ssh/boxery_host_ed25519_key.pub", `${key.public}\n`, "0644"],
		["/etc/ssh/sshd_config.d/05-boxery-hostkey.conf", "# boxery: this VM's pinned host key (host/hostkeys.mjs)\nHostKey /etc/ssh/boxery_host_ed25519_key\n", "0644"],
	];
}
