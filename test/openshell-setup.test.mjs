import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseSetupArgs, setupOpenShell } from "../controller/setup-openshell.mjs";
import { HOST_ENV } from "../host/config.mjs";

let dir, env, calls, logs, gateways, authenticated, driver, providers, failBuild, dockerSocket;
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "boxery-openshell-setup-"));
	env = { HOME: dir, BOXERY_HOME: path.join(dir, "registry"), PATH: process.env.PATH };
	calls = []; logs = []; gateways = [{ name: "local", endpoint: "https://127.0.0.1:17670", is_remote: false }];
	authenticated = true; driver = "docker"; providers = []; failBuild = false; dockerSocket = "unix:///var/run/docker.sock";
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const conf = () => path.join(dir, ".config/boxery-restricted");
const args = (...extra) => ["local", "--backend", "openshell", "--yes", ...extra];
async function run(command, a, options) {
	calls.push({ command, args: a, env: options.env });
	if (command === "openshell") {
		if (a.includes("--version")) return "openshell 0.1.7";
		if (a.includes("gateway") && a.includes("list")) return JSON.stringify(gateways);
		if (a.includes("gateway") && a.includes("add")) { gateways = [{ name: "openshell", endpoint: "https://127.0.0.1:17670" }]; return ""; }
		if (a.includes("status")) return JSON.stringify({ status: "connected", authentication: { status: authenticated ? "authenticated" : "failed" } });
		if (a.includes("gateway") && a.includes("info")) return JSON.stringify({ compute_drivers: [{ name: driver }] });
		if (a.includes("provider") && a.includes("list")) return JSON.stringify({ providers: providers.map((name) => ({ name })), next_page_token: "" });
	}
	if (command === "docker") {
		if (a[0] === "context" && a[1] === "show") return "default\n";
		if (a[0] === "context" && a[1] === "inspect") return JSON.stringify([{ Endpoints: { docker: { Host: dockerSocket } } }]);
		if (a[0] === "build" && failBuild) throw new Error("injected build failure");
		return "";
	}
	if (command.endsWith("/host/boxery-host")) {
		assert.deepEqual(a.slice(2), ["init", "--backend", "openshell"]);
		const c = path.join(dir, `.config/boxery-${a[1]}`); mkdirSync(c, { recursive: true });
		writeFileSync(path.join(c, "host.env"), HOST_ENV.filter((k) => options.env[k]).map((k) => `${k}=${options.env[k]}`).join("\n") + "\n");
		return "";
	}
	if (command.endsWith("/controller/boxery")) {
		assert.equal(a.includes("--backend"), false, "registration must not recursively invoke guided setup");
		const name = a[a.indexOf("--name") + 1], profile = a[a.indexOf("--profile") + 1];
		const d = path.join(env.BOXERY_HOME, "profiles", name); mkdirSync(d, { recursive: true });
		writeFileSync(path.join(d, "config"), `HOST='local'\nHOST_PROFILE='${profile}'\n`);
		mkdirSync(path.join(env.BOXERY_HOME, "host-registry"), { recursive: true });
		writeFileSync(path.join(env.BOXERY_HOME, "host-registry", name), `${d}\n`);
		return "";
	}
	throw new Error(`unexpected command ${command} ${a.join(" ")}`);
}
const setup = (a = args(), dependencies = {}) => setupOpenShell(a, { env, run, log: (s) => logs.push(s), interactive: false, ...dependencies });

test("guided setup discovers one authenticated gateway, builds the image and installs offline defaults without keys", async () => {
	const result = await setup(); assert.ok(result);
	assert.equal(result.gateway, "local"); assert.equal(result.host, "restricted");
	assert.match(result.prefix, /^bx-[0-9a-f]{6}-$/);
	assert.deepEqual(result.providers, []);
	assert.match(readFileSync(result.policy, "utf8"), /network_policies: \{\}/);
	assert.equal(existsSync(path.join(dir, ".ssh")), false);
	assert.equal(calls.filter((c) => c.command === "docker" && c.args[0] === "build").length, 1);
	assert.ok(calls.some((c) => c.command.endsWith("boxery-host") && c.env.BOXERY_OPENSHELL_IMAGE === result.image));
	assert.match(logs.join("\n"), /no credentials imported/);
	assert.equal(calls.some((c) => c.args.includes("gateway") && c.args.includes("add")), false, "do not mutate existing OpenShell registration");
});

test("repeat setup preserves namespace, edited policy and provider selection", async () => {
	providers = ["work-api"];
	const first = await setup(args("--provider", "work-api")); assert.ok(first);
	writeFileSync(first.policy, "# owner-edited policy\nversion: 1\n");
	const second = await setup(); assert.ok(second);
	assert.equal(second.prefix, first.prefix); assert.equal(second.image, first.image);
	assert.deepEqual(second.providers, ["work-api"]);
	assert.equal(readFileSync(second.policy, "utf8"), "# owner-edited policy\nversion: 1\n");
	await assert.rejects(setup(args("--prefix", "different-")), /refusing to change/);
	await assert.rejects(setup(args("--workspace", "other")), /refusing to change/);
});

test("multiple gateways require a choice, never silently use the active gateway", async () => {
	gateways.push({ name: "other", endpoint: "https://remote.example", active: true });
	await assert.rejects(setup(), /multiple.*--gateway/);
	const result = await setup(args("--gateway", "other", "--image", "registry.example/boxery:test"));
	assert.equal(result?.gateway, "other"); assert.equal(calls.some((c) => c.command === "docker"), false);
});

test("missing gateway gives installation/registration guidance, registration requires explicit consent", async () => {
	gateways = [];
	await assert.rejects(setup(), /no OpenShell gateway registered/);
	assert.equal(calls.some((c) => c.args.includes("add")), false);
	const result = await setup(args("--register-local"));
	assert.equal(result?.gateway, "openshell");
	assert.ok(calls.some((c) => c.args.includes("add") && c.args.includes("https://127.0.0.1:17670")));
});

test("missing binary and failed authentication cannot be bypassed", async () => {
	await assert.rejects(setup(args(), { run: async () => { throw new Error("ENOENT"); } }), /Install OpenShell/);
	authenticated = false;
	await assert.rejects(setup(), /not connected\/authenticated/);
	assert.equal(calls.some((c) => c.command === "docker"), false);
	gateways[0].endpoint = "http://127.0.0.1:17670";
	await assert.rejects(setup(), /HTTPS/);
});

test("building into an ambiguous/remote engine is refused, explicit images need no Docker", async () => {
	driver = "vm";
	await assert.rejects(setup(), /local Docker gateway/);
	driver = "docker"; dockerSocket = "ssh://another-host";
	await assert.rejects(setup(), /reachable local Docker/);
	const result = await setup(args("--image", "custom:ready")); assert.equal(result?.image, "custom:ready");
});

test("noninteractive setup requires --yes; cancellation leaves settings and registry untouched", async () => {
	await assert.rejects(setup(["local", "--backend", "openshell"]), /confirmation/);
	await assert.rejects(setup(["local", "--backend", "openshell"], { interactive: true, ask: async () => "no" }), /cancelled/);
	assert.equal(existsSync(conf()), false);
	assert.equal(calls.some((c) => c.command === "docker" && c.args[0] === "build"), false);
});

test("failed image build cannot publish a host registration or host settings", async () => {
	failBuild = true;
	await assert.rejects(setup(), /build failure/);
	assert.equal(existsSync(conf()), false);
	assert.equal(calls.some((c) => c.command.endsWith("/controller/boxery")), false);
});

test("explicit policy/providers are validated and never replaced or auto-imported", async () => {
	const policy = path.join(dir, "custom.yaml"); writeFileSync(policy, "owner policy\n");
	await assert.rejects(setup(args("--provider", "missing")), /not configured/);
	providers = ["work-api"];
	const result = await setup(args("--policy", policy, "--provider", "work-api"));
	assert.equal(result?.policy, policy); assert.equal(readFileSync(policy, "utf8"), "owner policy\n");
	assert.equal(calls.some((c) => c.args.includes("--from-existing") || c.args.includes("--auto-providers")), false);
});

test("refuses conflicting profiles, unsafe flags and policy symlinks", async () => {
	mkdirSync(conf(), { recursive: true }); writeFileSync(path.join(conf(), "host.env"), "BOXERY_BACKEND=libvirt\n");
	await assert.rejects(setup(), /already uses libvirt/); assert.equal(calls.length, 0);
	rmSync(conf(), { recursive: true });
	const target = path.join(dir, "policy.yaml"), link = path.join(dir, "linked.yaml");
	writeFileSync(target, "policy\n"); symlinkSync(target, link);
	await assert.rejects(setup(args("--policy", link)), /non-symlink/);
	for (const extra of [["--gateway-insecure"], ["--prefix", "bad prefix"], ["--provider", "x;touch bad"], ["--name", "../escape"]]) {
		await assert.rejects(setup(args(...extra)));
	}
	assert.throws(() => parseSetupArgs(["someone@host", "--backend", "openshell"]), /supports only/);
});
