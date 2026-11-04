import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { spawnSync } from "node:child_process";
import { profileFromDirectory, withHost } from "../core/boxery-core.mjs";
import { addGrants, applyGrants } from "../core/grant-operations.mjs";
import { createBackend } from "../host/backend.mjs";
import { createGuest } from "../host/guest.mjs";
import { createVm, start } from "../host/vms.mjs";
import { poolAdd, edgeSet } from "../host/pool.mjs";
import { loadConfig, SETTINGS } from "../host/config.mjs";
import { OPENSHELL_NAMESPACE_LABEL, OPENSHELL_NO_PROVIDERS, openShellNamespace } from "../host/openshell-config.mjs";

let dir, env, backend;
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "boxery-openshell-"));
	mkdirSync(path.join(dir, "bin")); mkdirSync(path.join(dir, "conf"));
	writeFileSync(path.join(dir, "policy.yaml"), "version: 1\nnetwork_policies: {}\n");
	writeFileSync(path.join(dir, "state.json"), JSON.stringify([{ name: "bx-demo", phase: "Ready", labels: { [OPENSHELL_NAMESPACE_LABEL]: openShellNamespace("bx-") } }, { name: "unrelated", phase: "Ready" }]));
	env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, BOXERY_BACKEND: "openshell", BOXERY_CONF: `${dir}/conf`,
		BOXERY_OPENSHELL_GATEWAY: "local", BOXERY_OPENSHELL_WORKSPACE: "default", BOXERY_OPENSHELL_PREFIX: "bx-",
		BOXERY_OPENSHELL_IMAGE: "boxery:test", BOXERY_OPENSHELL_POLICY: `${dir}/policy.yaml`, OS_TEST_DIR: dir };
	const file = path.join(dir, "bin", "openshell");
	writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const d = process.env.OS_TEST_DIR, a = process.argv.slice(2);
fs.appendFileSync(d + '/calls', JSON.stringify({ a, endpoint: process.env.OPENSHELL_GATEWAY_ENDPOINT, insecure: process.env.OPENSHELL_GATEWAY_INSECURE }) + '\\n');
if (process.env.OS_FAIL) process.exit(9);
const state = JSON.parse(fs.readFileSync(d + '/state.json'));
const i = a.indexOf('sandbox'), op = a[i + 1];
if (op === 'list') {
 if (process.env.OS_BAD_JSON) { console.log('{}'); process.exit(); }
 const token = a[a.indexOf('--page-token') + 1];
 console.log(JSON.stringify({ sandboxes: token ? state.slice(1) : state.slice(0, 1), next_page_token: token ? '' : 'page2' }));
} else if (op === 'create') {
 const name = a[a.indexOf('--name') + 1];
 if (state.some(s => s.name === name)) process.exit(1);
 const labels = {};
 for (let j = 0; j < a.length; j++) if (a[j] === '--label') { const [k, v] = a[j + 1].split('='); labels[k] = v; }
 state.push({ name, phase: 'Ready', labels }); fs.writeFileSync(d + '/state.json', JSON.stringify(state));
} else if (['stop', 'start', 'delete'].includes(op)) {
 const n = a[i + 2], s = state.find(s => s.name === n);
 if (!s) process.exit(1);
 if (op === 'delete') state.splice(state.indexOf(s), 1); else s.phase = op === 'stop' ? 'Stopped' : 'Ready';
 fs.writeFileSync(d + '/state.json', JSON.stringify(state));
} else if (a.includes('ssh-proxy')) { process.stdout.write('relay'); }
else process.exit(1);
`);
	chmodSync(file, 0o755);
	backend = createBackend(env);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const calls = () => readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("OpenShell paginates, scopes inventory, and reports unknown capacity", async () => {
	const rows = await backend.list();
	assert.equal(rows.length, 1); assert.equal(rows[0].name, "demo"); assert.equal(rows[0].state, "running");
	assert.equal(rows[0].diskBytes, null);
	assert.deepEqual(await backend.sshEndpoint("demo"), { host: "demo.openshell", port: "22", name: "demo" });
	assert.equal(await backend.exists("missing"), false);
	assert.ok(calls().every(({ a }) => a.slice(0, 4).join(" ") === "--gateway local --workspace default"));
});

test("overlapping prefixes and unlabeled sandboxes never share ownership, including cleanup and SSH", async () => {
	const state = [
		{ name: "bx-demo", phase: "Ready", labels: { [OPENSHELL_NAMESPACE_LABEL]: openShellNamespace("bx-") } },
		{ name: "bx-team-demo", phase: "Ready", labels: { [OPENSHELL_NAMESPACE_LABEL]: openShellNamespace("bx-team-") } },
		{ name: "bx-legacy", phase: "Ready" },
		{ name: "bx-team-legacy", phase: "Ready" },
	];
	writeFileSync(`${dir}/state.json`, JSON.stringify(state));
	const team = createBackend({ ...env, BOXERY_OPENSHELL_PREFIX: "bx-team-" });
	// The CLI double deliberately ignores --selector: client-side ownership checks must still hold.
	assert.deepEqual((await backend.list()).map((v) => v.name), ["demo"]);
	assert.deepEqual((await team.list()).map((v) => v.name), ["demo"]);
	assert.equal(await backend.exists("team-demo"), false);
	assert.equal(await backend.exists("legacy"), false);
	for (const fn of ["backend_start", "backend_stop", "backend_rm", "backend_connect", "backend_platform_host_key"]) {
		await assert.rejects(backend.call(fn, ["team-demo"], { quiet: true }));
	}
	await assert.rejects(backend.call("backend_new", ["team-demo", 1, 1024, 10, "", "stock"], { quiet: true }), "name collision must not authorize cleanup");
	await backend.call("backend_cleanup_new", ["team-demo"], { quiet: true });
	await backend.call("backend_cleanup_new", ["legacy"], { quiet: true });
	assert.deepEqual(JSON.parse(readFileSync(`${dir}/state.json`, "utf8")), state);
	assert.ok(!calls().some(({ a }) => a.includes("delete") || a.includes("ssh-proxy")));
	await team.call("backend_rm", ["demo"], { quiet: true });
	assert.deepEqual(JSON.parse(readFileSync(`${dir}/state.json`, "utf8")).map((s) => s.name), ["bx-demo", "bx-legacy", "bx-team-legacy"]);
});

test("explicit empty providers survive saved configuration fallback and reach sandbox creation", async () => {
	writeFileSync(`${dir}/conf/host.env`, "BOXERY_OPENSHELL_PROVIDERS=old-provider\n");
	const config = loadConfig({ ...env, BOXERY_OPENSHELL_PROVIDERS: OPENSHELL_NO_PROVIDERS });
	assert.equal(config.env.BOXERY_OPENSHELL_PROVIDERS, OPENSHELL_NO_PROVIDERS);
	const b = createBackend(config.env);
	await b.call("backend_new", ["offline", 1, 1024, 10, "", "stock"], { quiet: true });
	const c = calls().find(({ a }) => a.includes("create"));
	assert.ok(!c.a.includes("--provider"), "backend.sh must not reload the old provider list");
	assert.ok(c.a.includes("--no-auto-providers"));
});

test("OpenShell inventory errors cannot masquerade as absence or an empty host", async () => {
	for (const extra of [{ OS_FAIL: "1" }, { OS_BAD_JSON: "1" }]) {
		const b = createBackend({ ...env, ...extra });
		await assert.rejects(b.list({ quiet: true }));
		await assert.rejects(b.exists("demo"));
	}
});

test("OpenShell creates explicitly scoped headless workloads without credential auto-import", async () => {
	const b = createBackend({ ...env, BOXERY_OPENSHELL_PROVIDERS: "github", OPENSHELL_GATEWAY_ENDPOINT: "https://evil", OPENSHELL_GATEWAY_INSECURE: "true" });
	await b.call("backend_new", ["second", 2, 2048, 40, "", "stock"], { quiet: true });
	const c = calls().find(({ a }) => a.includes("create"));
	assert.equal(c.endpoint, undefined); assert.equal(c.insecure, undefined);
	assert.ok(c.a.includes("--no-auto-providers")); assert.ok(c.a.includes("--detach")); assert.ok(c.a.includes("github"));
	assert.ok(c.a.includes(`${OPENSHELL_NAMESPACE_LABEL}=${openShellNamespace("bx-")}`));
	assert.ok(c.a.includes("2048Mi")); assert.ok(c.a.includes("bx-second")); assert.ok(!c.a.includes("--disk"));
	await b.call("backend_stop", ["second"], { quiet: true });
	assert.equal((await b.list()).find((r) => r.name === "second")?.state, "shut off");
	await b.call("backend_start", ["second"], { quiet: true });
	await b.call("backend_rm", ["second"], { quiet: true });
	await b.call("backend_cleanup_new", ["second"], { quiet: true });
	assert.equal(await b.exists("demo"), true);
	assert.equal(JSON.parse(readFileSync(`${dir}/state.json`, "utf8")).some((s) => s.name === "unrelated"), true);
});

test("OpenShell refuses unsupported operations and invalid names", async () => {
	assert.equal(await backend.has("backend_resize"), false);
	assert.equal(await backend.has("backend_connect"), true);
	assert.deepEqual(await backend.images(), []);
	await assert.rejects(backend.call("backend_capture", ["demo", "demo@x"], { quiet: true }));
	await assert.rejects(backend.call("backend_new", ["x", 1, 1024, 10, "", "demo@x"], { quiet: true }));
	await assert.rejects(backend.call("backend_connect", ["x;touch bad"], { quiet: true }));
	await assert.rejects(backend.exists("this-name-is-too-long"), (/** @type {any} */ e) => e.exitCode === 2, "OpenShell's prefix+name limit fails before creation");
	await assert.rejects(poolAdd(/** @type {any} */ ({ backend: "openshell" }), ["demo"]), /not fenced/);
	await assert.rejects(edgeSet(/** @type {any} */ ({ backend: "openshell" }), ["demo"]), /OpenShell providers/);
});

test("restricted create and start skip root provisioning, proxy tokens and guest key fencing", async () => {
	/** @type {any} */
	const rt = { backend: "openshell", conf: `${dir}/conf`, vms: backend,
		shapes: () => ({ default: "small", shapes: { small: { cpus: 1, mem: 1024, disk: 10 } } }),
		intent: () => "intent", done: () => {}, waitSsh: async () => {}, guest: { run: async () => 0 } };
	const args = { name: "newbox", shape: "", cpus: "", mem: "", disk: "", from: "", headless: true };
	await assert.rejects(createVm(rt, { ...args, headless: false }), /only new --headless/);
	await assert.rejects(createVm(rt, { ...args, disk: "20" }), /omit --disk/);
	await assert.rejects(createVm(rt, { ...args, layers: ["github-runner"] }), /--layers is not supported/);
	assert.equal(await createVm(rt, args), "newbox newbox.openshell:22");
	assert.equal(existsSync(`${dir}/conf/tokens.json`), false);
	assert.equal(existsSync(`${dir}/conf/vm-shapes/newbox`), false);
	await start(rt, ["newbox"]);
});

test("host guest transport uses gateway ProxyCommand with strict pinned host keys", async () => {
	const file = `${dir}/bin/ssh`;
	writeFileSync(file, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.OS_TEST_DIR + "/ssh-argv", JSON.stringify(process.argv.slice(2)));\n'); chmodSync(file, 0o755);
	const guest = createGuest({ conf: `${dir}/conf`, env });
	assert.equal(await guest.run({ host: "demo.openshell", port: "22", name: "demo" }, "true"), 0);
	const a = JSON.parse(readFileSync(`${dir}/ssh-argv`, "utf8"));
	assert.ok(a.some((v) => v.startsWith("ProxyCommand=") && v.includes("backend_connect") && v.includes("demo")));
	assert.ok(a.includes("StrictHostKeyChecking=yes")); assert.ok(a.includes("ForwardAgent=no"));
});

test("host key bootstrap is confined to the authenticated relay and removes temporary trust state", async () => {
	const file = `${dir}/bin/ssh`;
	writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs'), a = process.argv.slice(2);
const f = a.find(v => v.startsWith('UserKnownHostsFile=')).slice('UserKnownHostsFile='.length);
fs.writeFileSync(process.env.OS_TEST_DIR + '/key-argv', JSON.stringify({ a, f }));
if (process.env.OS_SSH_FAIL) process.exit(255);
fs.writeFileSync(f, 'openshell ssh-ed25519 AAAAtest\\n');
`); chmodSync(file, 0o755);
	assert.equal((await backend.call("backend_platform_host_key", ["demo"], { capture: true, quiet: true })).trim(), "ssh-ed25519 AAAAtest");
	let recorded = JSON.parse(readFileSync(`${dir}/key-argv`, "utf8"));
	assert.ok(recorded.a.includes("/dev/null")); // -F: no user SSH config may override the relay
	assert.ok(recorded.a.some((v) => v.startsWith("ProxyCommand=") && v.includes("openshell.mjs") && v.includes("connect")));
	assert.equal(existsSync(recorded.f), false);
	await assert.rejects(createBackend({ ...env, OS_SSH_FAIL: "1" }).call("backend_platform_host_key", ["demo"], { quiet: true }));
	recorded = JSON.parse(readFileSync(`${dir}/key-argv`, "utf8"));
	assert.equal(existsSync(path.dirname(recorded.f)), false);
});

test("shared grant operations and CLI preparation refuse OpenShell before approval or writes", async () => {
	const profile = `${dir}/controller-profile`;
	mkdirSync(profile);
	writeFileSync(`${profile}/config`, "HOST='local'\n");
	writeFileSync(`${profile}/ssh_config`, "");
	writeFileSync(`${profile}/backend`, "openshell\n");
	await withHost(profileFromDirectory("restricted", profile), async () => {
		await assert.rejects(addGrants("demo", [{ kind: "llm", spec: "llm:openai", provider: "openai" }]), /OpenShell providers\/policy/);
		await assert.rejects(applyGrants("demo"), /OpenShell providers/);
	});
	const prepared = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../controller/grants.mjs"), "restricted", profile, "prepare", "demo", "llm:openai"], { env, encoding: "utf8" });
	assert.equal(prepared.status, 1);
	assert.match(prepared.stderr, /OpenShell providers\/policy/);
	assert.equal(existsSync(`${profile}/grants`), false);
});

test("OpenShell configuration is persisted and journaled", () => {
	const keys = Object.keys(env).filter((k) => k.startsWith("BOXERY_OPENSHELL_"));
	writeFileSync(`${dir}/conf/host.env`, keys.map((k) => `${k}=${env[k]}`).join("\n"));
	const config = loadConfig({ BOXERY_CONF: `${dir}/conf` });
	for (const k of keys) { assert.equal(config.env[k], env[k]); assert.ok(SETTINGS.includes(k)); }
});
