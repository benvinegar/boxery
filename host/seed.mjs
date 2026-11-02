// Per-VM identity as cloud-config user-data: hostname, ssh keys, LLM proxy token, pi/opencode config.
// Backend-agnostic: each backend delivers this file to its guest (host/backends/README.md, "Identity").
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
/** @import { Runtime } from "./runtime.mjs" */

/** A tool-capable model of the host's Ollama. @typedef {{ id: string }} OllamaModel */

// In the guest, socat always listens here and forwards to the host proxy.
const PROXY = "http://127.0.0.1:8088";

/** The Codex client derives an account id from a JWT, so hand it an unsigned JWT that carries our token. @param {string} cred */
export function fakeJwt(cred) {
	const b = (/** @type {unknown} */ o) => Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${b({ alg: "none", typ: "JWT" })}.${b({ boxery: cred, "https://api.openai.com/auth": { chatgpt_account_id: "boxery" } })}.boxery`;
}

/** @param {string} cred @param {OllamaModel[]} [ollama] */
export function piModels(cred, ollama = []) {
	return { providers: {
		"openai-codex": { baseUrl: `${PROXY}/chatgpt/backend-api`, apiKey: fakeJwt(cred) },
		...(ollama.length ? { ollama: { baseUrl: `${PROXY}/ollama/v1`, api: "openai-completions", apiKey: cred, models: ollama } } : {}),
	} };
}
export const piSettings = () => ({ transport: "sse", defaultProvider: "openai-codex", defaultModel: "gpt-6.1-sol", defaultThinkingLevel: "medium" });
/** @param {string} cred @param {OllamaModel[]} [ollama] */
export function opencodeConfig(cred, ollama = []) {
	const ids = ollama.map((m) => m.id);
	const def = ids.includes("qwen3-coder:latest") ? "qwen3-coder:latest" : ids[0];
	return {
		$schema: "https://opencode.ai/config.json",
		autoupdate: false,
		provider: { boxery: { npm: "@ai-sdk/openai-compatible", name: "boxery host proxy (ollama)",
			options: { baseURL: `${PROXY}/ollama/v1`, apiKey: cred }, models: Object.fromEntries(ids.map((id) => [id, { name: id }])) } },
		...(def ? { model: `boxery/${def}` } : {}),
	};
}

/** Guest files (under the agent's home) that carry the proxy token CRED.
 *  @param {string} cred @param {OllamaModel[]} [ollama] @returns {Array<[string, string]>} */
function credentialFiles(cred, ollama = []) {
	return [
		[".pi/agent/models.json", JSON.stringify(piModels(cred, ollama), null, 2)],
		[".config/opencode/opencode.json", JSON.stringify(opencodeConfig(cred, ollama), null, 2)],
		[".boxery/token", cred],
	];
}

/** Tool-capable models of the host's Ollama, if it runs ([] otherwise). @returns {Promise<OllamaModel[]>} */
export async function ollamaModels() {
	try {
		const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(3000) });
		if (!r.ok) return [];
		/** @type {{ models: Array<{ name: string, capabilities?: unknown }> }} */
		const { models } = await r.json();
		return models.filter((m) => Array.isArray(m.capabilities) && m.capabilities.includes("tools")).map((m) => ({ id: m.name }));
	} catch { return []; }
}

// ---------------------------------------------------------------- image layers (image/layers/)
// plumbing (every VM) → devtools → desktop. The desktop base build applies all three; a headless VM boots
// the backend's stock image and applies plumbing + devtools at first boot. Both carry every layer's file
// and the runner (boxery-provision) as write_files entries: `layers`, from host/backend.sh __layer_files.
/** The desktop build's cloud-config: image/base-user-data.yaml with the layers at its marker line.
 *  @param {string} root @param {string[]} layers */
export function baseUserdata(root, layers) {
	return readFileSync(path.join(root, "image", "base-user-data.yaml"), "utf8").split("\n")
		.flatMap((line) => (line === "  # @boxery-layers" ? layers : [line])).join("\n");
}

/** The user-data text. keys: authorized keys; upstream: the backend's guest proxy upstream (socat address).
 * provision (headless VMs on the stock image): layers to apply at first boot, e.g. "plumbing devtools",
 * with layers: their write_files lines.
 * @param {{ name: string, keys: string[], upstream: string, cred: string, ollama?: OllamaModel[], provision?: string, layers?: string[] }} opts */
export function cloudConfig({ name, keys, upstream, cred, ollama = [], provision = "", layers = [] }) {
	const [models, opencode, token] = credentialFiles(cred, ollama);
	const files = [models, [".pi/agent/settings.json", JSON.stringify(piSettings(), null, 2)], opencode, token];
	return [
		"#cloud-config",
		`hostname: ${name}`,
		`fqdn: ${name}.boxery`,
		"ssh_pwauth: false",
		"ssh_authorized_keys:",
		...keys.map((k) => `  - ${JSON.stringify(k)}`),
		// The stock image's default user isn't agent (plumbing makes it so for VMs made from this disk).
		...(provision ? ["users:", "  - name: agent", "    gecos: boxery agent", "    groups: [sudo, adm]", "    shell: /bin/bash",
			'    sudo: "ALL=(ALL) NOPASSWD:ALL"', "    lock_passwd: true", "    ssh_authorized_keys:", ...keys.map((k) => `      - ${JSON.stringify(k)}`)] : []),
		// First boot of this instance (also when the disk came from another VM: fork): start with no
		// authorized keys (cloud-init's ssh module merges into the existing file, and a fork's disk carries
		// its source's keys) and a fresh machine-id. bootcmd runs before sshd starts.
		"bootcmd:",
		"  - [cloud-init-per, instance, boxery-keys, sh, -c, 'rm -f /home/agent/.ssh/authorized_keys']",
		"  - [cloud-init-per, instance, boxery-machine-id, sh, -c, 'rm -f /etc/machine-id /var/lib/dbus/machine-id; systemd-machine-id-setup >/dev/null']",
		"write_files:",
		"  - path: /etc/boxery/proxy-upstream",
		`    content: ${upstream}`,
		...(provision ? [...layers, "  - path: /etc/boxery/provision", `    content: ${provision}`] : []),
		...files.flatMap(([f, content]) => [
			`  - path: /home/agent/${f}`, "    owner: agent:agent", '    permissions: "0600"', "    defer: true", "    encoding: b64",
			`    content: ${Buffer.from(content).toString("base64")}`,
		]),
		"runcmd:",
		// Backends without a cloud-init seed (Lima, exe) run boxery-provision themselves (README: backend_new).
		...(provision ? ['  - [bash, -c, "/usr/local/sbin/boxery-provision >/var/log/boxery-provision.log 2>&1"]'] : []),
		'  - [bash, -c, "systemctl restart boxery-llm.service"]',
		"  - [bash, -c, \"chown -R agent:agent /home/agent && sudo -u agent bash -lc 'git config --global user.name agent; git config --global user.email agent@boxery; git config --global init.defaultBranch main; mkdir -p ~/project && cd ~/project && git init -q'\"]",
		"",
	].join("\n");
}

/** Mint NAME's proxy token and write its user-data under the operation's private work directory.
 * Returns the file's path. The supervisor removes the directory when the operation ends.
 * @param {Runtime} rt @param {string} name @param {string} [provision] */
export async function writeSeed(rt, name, provision = "") {
	const work = path.join(rt.conf, "work"), op = path.join(work, /** @type {string} */ (rt.operationId)), dir = path.join(op, name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const d of [work, op, dir]) chmodSync(d, 0o700);
	const secret = randomBytes(24).toString("hex");
	rt.setToken(name, secret);
	const file = path.join(dir, "user-data");
	writeFileSync(file, cloudConfig({ name, keys: rt.guest.petKeys(), upstream: await rt.vms.guestProxyUpstream(), cred: `${name}:${secret}`, ollama: await ollamaModels(), provision, layers: provision ? await rt.vms.layerFiles() : [] }));
	return file;
}

/** Write proxy token SECRET into running VM NAME's guest: the token file and the agent configs.
 *  @param {Runtime} rt @param {string} name @param {string} secret */
export async function installToken(rt, name, secret) {
	const script = ["set -e", "umask 077", ...credentialFiles(`${name}:${secret}`, await ollamaModels()).map(([f, content]) =>
		`mkdir -p "$HOME/${path.dirname(f)}"; printf %s '${Buffer.from(content).toString("base64")}' | base64 -d >"$HOME/${f}.new"; mv "$HOME/${f}.new" "$HOME/${f}"`)];
	if (await rt.guest.run(await rt.vms.sshEndpoint(name), "bash -s", { input: `${script.join("\n")}\n` }) !== 0) throw new Error(`could not install a proxy token in ${name}`);
}

/** Give running VM NAME a new proxy token: put it in the guest, and only then make it NAME's one valid
 * token. lease: bind it to that pool lease, so it dies with the lease and the proxy only honours edge
 * routes set for the same lease. @param {Runtime} rt @param {string} name @param {string} [lease] */
export async function issueToken(rt, name, lease) {
	const secret = randomBytes(24).toString("hex");
	await installToken(rt, name, secret);
	rt.setToken(name, lease ? { secret, lease } : secret);
}
