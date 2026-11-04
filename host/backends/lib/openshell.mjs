// OpenShell CLI adapter. No SDK dependency, credentials in argv, shell evaluation, or gateway fallback.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote as q } from "../../util.mjs";
import { OPENSHELL_NAMESPACE_LABEL, openShellNamespace, openShellProviders } from "../../openshell-config.mjs";

const env = { ...process.env };
const gateway = env.BOXERY_OPENSHELL_GATEWAY;
const workspace = env.BOXERY_OPENSHELL_WORKSPACE || "default";
const prefix = env.BOXERY_OPENSHELL_PREFIX;
const owner = openShellNamespace(prefix || "");
const namePattern = /^[a-z][a-z0-9-]{0,30}$/;
function required(value, name) { if (!value || /[\r\n\0]/.test(value)) throw new Error(`set ${name}`); return value; }
function validateConfig() {
	required(gateway, "BOXERY_OPENSHELL_GATEWAY (a registered gateway name)");
	if (!/^[a-zA-Z0-9_-]+$/.test(gateway)) throw new Error("use a registered gateway name, not an endpoint URL");
	if (!namePattern.test(workspace)) throw new Error("invalid OpenShell workspace");
	if (!prefix || !/^[a-z][a-z0-9-]{0,15}-$/.test(prefix)) throw new Error("set BOXERY_OPENSHELL_PREFIX to a unique prefix ending in '-' (max 17 characters)");
}
// Do not let inherited OpenShell variables select a different gateway or weaken TLS verification.
for (const key of ["OPENSHELL_GATEWAY", "OPENSHELL_GATEWAY_ENDPOINT", "OPENSHELL_GATEWAY_INSECURE", "OPENSHELL_WORKSPACE", "OPENSHELL_SANDBOX_POLICY"]) delete env[key];
const common = ["--gateway", gateway, "--workspace", workspace];
function cli(args, { capture = false } = {}) {
	const r = spawnSync("openshell", [...common, ...args], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", capture ? "pipe" : 2, 2] });
	if (r.error) throw r.error;
	if (r.status !== 0) throw new Error(`OpenShell ${args[0]} ${args[1] || ""} failed`);
	return r.stdout || "";
}
function platformName(name) {
	if (!namePattern.test(name || "")) throw new Error("invalid sandbox name");
	const full = prefix + name;
	if (full.length > 19) throw new Error(`OpenShell names are limited to 19 characters including prefix '${prefix}'; shorten the VM name or prefix`);
	return full;
}
function inventory() {
	const all = [], seen = new Set(); let token = "";
	do {
		const page = JSON.parse(cli(["sandbox", "list", "--output", "json", "--selector", `${OPENSHELL_NAMESPACE_LABEL}=${owner}`, "--page-token", token], { capture: true }));
		if (!Array.isArray(page.sandboxes) || typeof page.next_page_token !== "string") throw new Error("unexpected OpenShell inventory response");
		all.push(...page.sandboxes);
		token = page.next_page_token;
		if (token && seen.has(token)) throw new Error("repeated OpenShell inventory page token");
		seen.add(token);
	} while (token);
	// Verify ownership locally as well: never trust a name prefix or server-side selector alone.
	return all.filter((s) => s.labels?.[OPENSHELL_NAMESPACE_LABEL] === owner && typeof s.name === "string" && s.name.startsWith(prefix) && namePattern.test(s.name.slice(prefix.length)));
}
function find(name) { const n = platformName(name); return inventory().find((s) => s.name === n); }
function proxy(name) {
	return spawn("openshell", ["--workspace", workspace, "ssh-proxy", "--gateway-name", gateway, "--name", platformName(name)], { env, stdio: "inherit" });
}
const [command, name, ...args] = process.argv.slice(2);
try {
	validateConfig();
	switch (command) {
	case "check":
		required(env.BOXERY_OPENSHELL_IMAGE, "BOXERY_OPENSHELL_IMAGE");
		const policyFile = required(env.BOXERY_OPENSHELL_POLICY, "BOXERY_OPENSHELL_POLICY");
		if (!path.isAbsolute(policyFile) || !statSync(policyFile).isFile()) throw new Error("policy must be an absolute file path");
		inventory(); break;
	case "list":
		for (const s of inventory()) {
			const n = s.name.slice(prefix.length);
			const state = s.phase === "Ready" ? "running" : s.phase === "Stopped" ? "shut off" : String(s.phase || "unknown").toLowerCase();
			if (!/^[a-z -]+$/.test(state)) throw new Error("invalid OpenShell phase");
			console.log(`${n}\t${state}\t${state === "running" ? `${n}.openshell:22` : ""}\t\t`);
		} break;
	case "exists": process.exitCode = find(name) ? 0 : 1; break;
	case "endpoint":
		if (find(name)?.phase !== "Ready") throw new Error(`${name} is not ready`);
		console.log(`${name}.openshell 22`); break;
	case "new": {
		const [cpus, mem, , , source] = args;
		if (source !== "stock") throw new Error("OpenShell only supports new --headless without --from");
		const image = required(env.BOXERY_OPENSHELL_IMAGE, "BOXERY_OPENSHELL_IMAGE");
		const policy = required(env.BOXERY_OPENSHELL_POLICY, "BOXERY_OPENSHELL_POLICY");
		const providers = openShellProviders(env.BOXERY_OPENSHELL_PROVIDERS);
		if (!providers.every((p) => namePattern.test(p))) throw new Error("invalid OpenShell provider name");
		cli(["sandbox", "create", "--name", platformName(name), "--from", image, "--policy", policy,
			"--cpu", cpus, "--memory", `${mem}Mi`, "--no-auto-providers", "--detach", "--label", `${OPENSHELL_NAMESPACE_LABEL}=${owner}`, ...providers.flatMap((p) => ["--provider", p]), "--", "sleep", "infinity"]);
		break;
	}
	case "start": case "stop":
		if (!find(name)) throw new Error(`no such sandbox: ${name}`);
		cli(["sandbox", command, platformName(name)]); break;
	case "rm": case "cleanup":
		if (find(name)) cli(["sandbox", "delete", platformName(name)]);
		else if (command === "rm") throw new Error(`no such sandbox: ${name}`);
		break;
	case "connect":
		if (!find(name)) throw new Error(`no owned sandbox: ${name}`);
		proxy(name).on("error", (e) => { console.error(e.message); process.exitCode = 1; })
			.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
		break;
	case "host-key": {
		if (!find(name)) throw new Error(`no owned sandbox: ${name}`);
		// Bootstrap ONLY over the authenticated, workspace-scoped gateway relay. No network TOFU.
		// The gateway authenticates the sandbox identity; SSH pins that identity for later tool calls.
		const dir = mkdtempSync(path.join(tmpdir(), "boxery-openshell-key-"));
		try {
			const file = path.join(dir, "known_hosts");
			const proxyCommand = [process.execPath, fileURLToPath(import.meta.url), "connect", name].map(q).join(" ");
			const r = spawnSync("ssh", ["-F", "/dev/null", "-o", `ProxyCommand=${proxyCommand}`, "-o", "HostKeyAlgorithms=ssh-ed25519",
				"-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${file}`, "-o", "GlobalKnownHostsFile=/dev/null",
				"-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ConnectTimeout=15", "sandbox@openshell", "true"],
			{ env, stdio: ["ignore", "ignore", 2], timeout: 30000 });
			if (r.error || r.status !== 0) throw new Error("could not read host key through authenticated OpenShell gateway");
			const line = readFileSync(file, "utf8").split("\n").find((l) => l.includes(" ssh-ed25519 "));
			if (!line) throw new Error("OpenShell did not present an ed25519 host key");
			console.log(line.split(/\s+/).slice(1, 3).join(" "));
		} finally { rmSync(dir, { recursive: true, force: true }); }
		break;
	}
	default: throw new Error(`unknown OpenShell adapter operation: ${command}`);
	}
} catch (e) { console.error(`boxery-openshell: ${e.message}`); process.exitCode = 2; }
