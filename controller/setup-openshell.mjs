// Guided local onboarding. OpenShell owns gateway installation, TLS, policy and credentials.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { HOST_ENV } from "../host/config.mjs";
import { backendMetadata, platformStatus } from "../core/backend-metadata.mjs";
import { OPENSHELL_NO_PROVIDERS, openShellProviders } from "../host/openshell-config.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const INSTALL = "Install OpenShell and start its gateway using https://github.com/NVIDIA/OpenShell#quickstart";
const HELP = `boxery setup local --backend openshell [options]
  --name NAME          Boxery host name (default: restricted)
  --gateway NAME       Existing OpenShell gateway (auto-select only when exactly one exists)
  --register-local     Register the package-managed https://127.0.0.1:17670 gateway
  --workspace NAME     OpenShell workspace (default: default)
  --image OCI          Use an existing image instead of building the bundled Docker image
  --policy PATH        Use your policy (default: saved, offline starter policy)
  --provider NAME      Explicit existing provider to attach to new sandboxes; repeatable
  --no-providers       Clear saved provider attachments for future sandboxes
  --prefix PREFIX      Sandbox namespace (default: generated once and saved)
  --profile NAME       Host-side Boxery profile (default: host name)
  --host-bin PATH      Local boxery-host executable (default: this installation)
  --yes                Approve the displayed plan without an interactive prompt
No credentials are imported and no network access is granted by default.
OpenShell installation and gateway services remain managed by OpenShell, not Boxery.`;

/** @typedef {"name" | "gateway" | "workspace" | "image" | "policy" | "prefix" | "profile" | "hostBin"} ValueOption */
/** @typedef {Partial<Record<ValueOption, string>> & { name: string, providers: string[], noProviders: boolean, yes: boolean, registerLocal: boolean, help: boolean }} SetupOptions */
/** @param {string[]} argv @returns {SetupOptions} */
export function parseSetupArgs(argv) {
	/** @type {SetupOptions} */
	const options = { name: "restricted", providers: [], noProviders: false, yes: false, registerLocal: false, help: false };
	/** @type {Record<string, ValueOption>} */
	const values = { "--name": "name", "--gateway": "gateway", "--workspace": "workspace", "--image": "image", "--policy": "policy", "--prefix": "prefix", "--profile": "profile", "--host-bin": "hostBin" };
	let destination = "", backend = "";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--yes") options.yes = true;
		else if (a === "--no-providers") options.noProviders = true;
		else if (a === "--register-local") options.registerLocal = true;
		else if (["--help", "-h"].includes(a)) options.help = true;
		else if (a === "--backend" || a === "--provider" || Object.hasOwn(values, a)) {
			const v = argv[++i];
			if (!v || v.startsWith("-") || /[\r\n\0]/.test(v)) throw new Error(`${a} needs a value`);
			if (a === "--backend") backend = v;
			else if (a === "--provider") options.providers.push(v);
			else options[values[a]] = v;
		} else if (a.startsWith("-")) throw new Error(`unknown OpenShell setup flag: ${a}`);
		else if (!destination) destination = a;
		else throw new Error(`unexpected setup argument: ${a}`);
	}
	if (options.help) return options;
	if (destination !== "local" || backend !== "openshell") throw new Error("guided OpenShell setup supports only: boxery setup local --backend openshell (use manual host setup for remote Boxery hosts)");
	for (const k of /** @type {const} */ (["name", "profile"])) if (options[k] && !NAME.test(options[k])) throw new Error(`invalid ${k}: ${options[k]}`);
	if (options.noProviders && options.providers.length) throw new Error("--no-providers conflicts with --provider");
	if (!options.providers.every((p) => NAME.test(p))) throw new Error("invalid provider name");
	return options;
}

/** @param {string} command @param {string[]} args @param {{env: NodeJS.ProcessEnv, capture?: boolean}} options @returns {Promise<string>} */
export function execute(command, args, { env, capture = false }) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: ["ignore", capture ? "pipe" : 2, 2] });
		/** @type {Buffer[]} */
		const chunks = []; let bytes = 0;
		child.stdout?.on("data", (d) => { bytes += d.length; if (bytes > 4 * 1024 * 1024) child.kill(); else chunks.push(d); });
		child.on("error", reject);
		child.on("close", (code) => code === 0 && bytes <= 4 * 1024 * 1024 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error(`${command} ${args[0] || ""} failed (see diagnostics above)`)));
	});
}

/** @param {string} conf @returns {Record<string, string>} */
function savedSettings(conf) {
	const file = path.join(conf, "host.env");
	if (!existsSync(file)) return {};
	if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error(`refusing nonregular settings file: ${file}`);
	return Object.fromEntries(readFileSync(file, "utf8").split("\n").map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }).filter(([k]) => HOST_ENV.includes(k)));
}

/** Injectable subprocess/prompt boundary for offline onboarding tests.
 * @param {string[]} argv
 * @param {{env?: NodeJS.ProcessEnv, run?: typeof execute, ask?: (message: string) => Promise<string>, interactive?: boolean, log?: (text: string) => void}} [dependencies]
 */
export async function setupOpenShell(argv, { env = process.env, run = execute, ask, interactive = Boolean(process.stdin.isTTY), log = (text) => console.error(text) } = {}) {
	const o = parseSetupArgs(argv);
	if (o.help) { log(HELP); return; }
	const metadata = backendMetadata("openshell");
	const platform = platformStatus(metadata, { host: { os: process.platform, arch: process.arch }, runtime: "gateway" });
	if (!platform.supported) throw new Error(`OpenShell adapter does not support boxery-host on ${process.platform}/${process.arch}; use a supported host (see boxery-host backends --json)`);
	if (!platform.tested) log("OpenShell is experimental; this host/gateway driver combination is not recorded as Boxery-tested. Recorded validation: " + metadata.tested.map((t) => `${t.host.os}/${t.host.arch} with ${t.runtime}`).join(", "));
	const home = path.resolve(env.HOME || homedir());
	const profile = o.profile || o.name;
	const conf = path.join(home, ".config", `boxery-${profile}`);
	if (env.BOXERY_CONF && path.resolve(env.BOXERY_CONF) !== conf) throw new Error("unset BOXERY_CONF before guided setup; --name/--profile selects its isolated host configuration");
	const saved = savedSettings(conf);
	if (saved.BOXERY_BACKEND && saved.BOXERY_BACKEND !== "openshell") throw new Error(`profile ${profile} already uses ${saved.BOXERY_BACKEND}; choose another --name/--profile`);
	const registry = path.resolve(env.BOXERY_HOME || path.join(home, ".boxery"));
	const pointer = path.join(registry, "host-registry", o.name);
	if (existsSync(pointer) || (() => { try { return lstatSync(pointer).isSymbolicLink(); } catch { return false; } })()) {
		if (!lstatSync(pointer).isFile() || lstatSync(pointer).isSymbolicLink()) throw new Error("invalid existing host registration");
		const dir = readFileSync(pointer, "utf8");
		if (!/^\/[^\r\n\0]+\n$/.test(dir)) throw new Error("invalid existing host registration");
		const config = readFileSync(path.join(dir.slice(0, -1), "config"), "utf8");
		if (!/^HOST='local'$/m.test(config) || !new RegExp(`^HOST_PROFILE='${profile}'$`, "m").test(config) || !saved.BOXERY_BACKEND) throw new Error(`host ${o.name} already targets a different host/profile; choose another --name`);
	}
	const hostBin = path.resolve(o.hostBin ? o.hostBin.replace(/^~(?=\/)/, home) : path.join(ROOT, "host/boxery-host"));
	accessSync(hostBin, constants.X_OK);
	const cliEnv = { ...env };
	for (const k of ["OPENSHELL_GATEWAY", "OPENSHELL_GATEWAY_ENDPOINT", "OPENSHELL_GATEWAY_INSECURE", "OPENSHELL_WORKSPACE", "OPENSHELL_SANDBOX_POLICY"]) delete cliEnv[k];
	try { await run("openshell", ["--version"], { env: cliEnv, capture: true }); }
	catch { throw new Error(`${INSTALL}\nThen rerun this command. Boxery does not install gateway binaries or generate gateway TLS.`); }
	const json = async (/** @type {string[]} */ args) => JSON.parse(await run("openshell", args, { env: cliEnv, capture: true }));
	const confirm = async (/** @type {string} */ message) => {
		if (o.yes) return true;
		if (!interactive || !ask) throw new Error("setup needs confirmation; rerun with --yes to approve the displayed plan noninteractively");
		return /^(y|yes)$/i.test((await ask(`${message} [y/N] `)).trim());
	};
	let gateways = await json(["gateway", "list", "--output", "json"]);
	if (!Array.isArray(gateways)) throw new Error("unexpected OpenShell gateway list response");
	if (!gateways.length) {
		log(`${INSTALL}\nFor a package-managed local gateway, registration uses its existing TLS bundle; Boxery never disables TLS verification.`);
		if (o.registerLocal || (!o.yes && interactive && await confirm("Register the package-managed local gateway at https://127.0.0.1:17670?"))) {
			await run("openshell", ["gateway", "add", "https://127.0.0.1:17670", "--local", "--name", "openshell"], { env: cliEnv });
			gateways = await json(["gateway", "list", "--output", "json"]);
			if (!Array.isArray(gateways)) throw new Error("unexpected OpenShell gateway list response");
		} else throw new Error("no OpenShell gateway registered; after installing/starting OpenShell, rerun with --register-local (or register your gateway with openshell gateway add)");
	}
	let gateway = o.gateway || saved.BOXERY_OPENSHELL_GATEWAY || env.BOXERY_OPENSHELL_GATEWAY;
	if (!gateway && gateways.length === 1) gateway = gateways[0].name;
	if (!gateway && interactive && ask) { log("Available gateways: " + gateways.map((g) => g.name).join(", ")); gateway = (await ask("Gateway name: ")).trim(); }
	if (!gateway) throw new Error("multiple OpenShell gateways found; choose explicitly with --gateway NAME");
	if (!/^[A-Za-z0-9_-]+$/.test(gateway)) throw new Error("invalid gateway name");
	const selected = gateways.find((g) => g.name === gateway);
	if (!selected) throw new Error(`gateway '${gateway}' is not registered; use openshell gateway add first`);
	const endpoint = new URL(selected.endpoint);
	if (endpoint.protocol !== "https:") throw new Error("guided setup requires an authenticated HTTPS gateway; configure OpenShell TLS instead of bypassing verification");
	const workspace = o.workspace || saved.BOXERY_OPENSHELL_WORKSPACE || env.BOXERY_OPENSHELL_WORKSPACE || "default";
	if (!/^[a-z][a-z0-9-]{0,18}$/.test(workspace)) throw new Error("invalid workspace (maximum 19 characters)");
	const prefix = o.prefix || saved.BOXERY_OPENSHELL_PREFIX || env.BOXERY_OPENSHELL_PREFIX || `bx-${randomBytes(3).toString("hex")}-`;
	if (!/^[a-z][a-z0-9-]{0,15}-$/.test(prefix)) throw new Error("prefix must end in '-' and have at most 17 lowercase characters");
	for (const [k, value] of [["GATEWAY", gateway], ["WORKSPACE", workspace], ["PREFIX", prefix]]) {
		if (saved[`BOXERY_OPENSHELL_${k}`] && saved[`BOXERY_OPENSHELL_${k}`] !== value) throw new Error(`refusing to change an initialized profile's ${k.toLowerCase()}; use another --name/--profile`);
	}
	const common = ["--gateway", gateway, "--workspace", workspace];
	const status = await json([...common, "status", "--output", "json"]);
	if (status.status !== "connected" || status.authentication?.status !== "authenticated") throw new Error(`gateway '${gateway}' is not connected/authenticated; use openshell status and openshell gateway login (or start the package-managed gateway service)`);
	const dockerfile = path.join(ROOT, "image/openshell/Dockerfile");
	const digest = createHash("sha256").update(readFileSync(dockerfile)).digest("hex").slice(0, 12);
	const defaultImage = `boxery-openshell:${digest}`;
	const image = o.image || saved.BOXERY_OPENSHELL_IMAGE || env.BOXERY_OPENSHELL_IMAGE || defaultImage;
	if (!image || image.startsWith("-") || /[\r\n\0]/.test(image)) throw new Error("invalid image reference");
	// Saved references are already-selected images, including ones supplied explicitly on remote gateways.
	const build = !o.image && !saved.BOXERY_OPENSHELL_IMAGE && image === defaultImage;
	if (build) {
		const info = await json([...common, "gateway", "info", "--output", "json"]);
		if (selected.is_remote || !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) || info.compute_drivers?.length !== 1 || info.compute_drivers[0].name !== "docker") throw new Error("automatic image builds require a local Docker gateway; build/push the compatible image in the gateway's engine and pass --image OCI");
		try {
			await run("docker", ["info"], { env, capture: true });
			const context = await run("docker", ["context", "show"], { env, capture: true });
			const contexts = JSON.parse(await run("docker", ["context", "inspect", context.trim()], { env, capture: true }));
			const socket = env.DOCKER_CONTEXT ? contexts[0]?.Endpoints?.docker?.Host : env.DOCKER_HOST || contexts[0]?.Endpoints?.docker?.Host;
			if (!socket?.startsWith("unix://")) throw new Error("Docker engine is remote");
		} catch { throw new Error("automatic image builds need a reachable local Docker engine/context; select that engine or pass --image OCI"); }
	}
	const customPolicy = o.policy || saved.BOXERY_OPENSHELL_POLICY || env.BOXERY_OPENSHELL_POLICY;
	const policy = customPolicy ? path.resolve(customPolicy) : path.join(conf, "openshell-policy.yaml");
	if (/[\r\n\0]/.test(policy)) throw new Error("invalid policy path");
	const policyExists = existsSync(policy);
	if ((customPolicy || policyExists) && (!policyExists || !lstatSync(policy).isFile() || lstatSync(policy).isSymbolicLink())) throw new Error("policy must be a regular, non-symlink file");
	const providers = o.noProviders ? [] : o.providers.length ? [...new Set(o.providers)] : openShellProviders(saved.BOXERY_OPENSHELL_PROVIDERS || env.BOXERY_OPENSHELL_PROVIDERS);
	if (!providers.every((p) => NAME.test(p))) throw new Error("invalid provider name");
	if (providers.length) {
		const available = new Set(); let token = ""; const seen = new Set();
		do {
			const page = await json([...common, "provider", "list", "--output", "json", "--page-token", token]);
			if (!Array.isArray(page.providers) || typeof page.next_page_token !== "string") throw new Error("unexpected OpenShell provider list response");
			for (const p of page.providers) available.add(p.name);
			token = page.next_page_token;
			if (token && seen.has(token)) throw new Error("repeated provider page token");
			seen.add(token);
		} while (token);
		for (const p of providers) if (!available.has(p)) throw new Error(`provider '${p}' is not configured in workspace '${workspace}'; create it explicitly in OpenShell first`);
	}
	log(`OpenShell setup plan:\n  Boxery host: ${o.name} (local profile ${profile})\n  Gateway: ${gateway}; workspace: ${workspace}; prefix: ${prefix}\n  Image: ${image}${build ? " (build bundled Dockerfile)" : " (use existing)"}\n  Policy: ${policy}${customPolicy || policyExists ? " (preserve existing)" : " (offline starter; no outbound access)"}\n  Providers: ${providers.join(", ") || "none; no credentials imported"}\n  No sudo, desktop, snapshots or pools. Providers can add network access; review their effective policy.`);
	if (!await confirm("Build/configure this Boxery host?")) throw new Error("setup cancelled; host was not configured");
	if (build) await run("docker", ["build", "-t", image, "-f", dockerfile, path.join(ROOT, "image/openshell")], { env });
	mkdirSync(conf, { recursive: true, mode: 0o700 });
	if (!customPolicy) { try { copyFileSync(path.join(ROOT, "image/openshell/policy.yaml"), policy, constants.COPYFILE_EXCL); chmodSync(policy, 0o600); } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e; } }
	if (!lstatSync(policy).isFile() || lstatSync(policy).isSymbolicLink()) throw new Error("saved policy is not a regular file; refusing to follow it");
	const initEnv = { ...env, BOXERY_HOME: registry, BOXERY_BACKEND: "openshell", BOXERY_OPENSHELL_GATEWAY: gateway, BOXERY_OPENSHELL_WORKSPACE: workspace,
		BOXERY_OPENSHELL_PREFIX: prefix, BOXERY_OPENSHELL_IMAGE: image, BOXERY_OPENSHELL_POLICY: policy, BOXERY_OPENSHELL_PROVIDERS: providers.length ? providers.join(",") : OPENSHELL_NO_PROVIDERS };
	await run(hostBin, ["--profile", profile, "init", "--backend", "openshell"], { env: initEnv });
	// Use the ordinary controller registration, with no --backend: the host is already initialized.
	await run(path.join(ROOT, "controller/boxery"), ["setup", "local", "--name", o.name, "--profile", profile, "--host-bin", hostBin], { env: initEnv });
	log(`Ready: boxery --host ${o.name} new demo --headless\nPolicy: ${policy}\nManage credentials/network with: openshell --gateway ${gateway} --workspace ${workspace} …${existsSync(path.join(ROOT, "test/openshell-smoke.mjs")) ? `\nRepeatable live check: node ${path.join(ROOT, "test/openshell-smoke.mjs")} ${o.name}` : ""}`);
	return { gateway, workspace, prefix, image, policy, profile, host: o.name, providers };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const prompt = { interface: /** @type {import("node:readline/promises").Interface | undefined} */ (undefined) };
	try {
		await setupOpenShell(process.argv.slice(2), { ask: async (message) => { prompt.interface ??= createInterface({ input: process.stdin, output: process.stderr }); return prompt.interface.question(message); } });
	} catch (e) { console.error(`boxery: ${/** @type {Error} */ (e).message}`); process.exitCode = 1; }
	finally { prompt.interface?.close(); }
}
