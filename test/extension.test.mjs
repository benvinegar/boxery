// pi extension (extension/index.ts) against a stub pi: its session state, approvals and leases, on
// one host and across several. test/frontends.test.mjs checks its tools against the shared table.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { registerHost } from "./fixtures/register-host.mjs";
import { canLoad, loadExtension as load } from "./helpers/pi-extension.mjs";

const HOME = mkdtempSync(path.join(tmpdir(), "boxery-ext-")); // no real controller config
const BETA = path.join(HOME, "profiles", "beta");
process.env.BOXERY_HOME = HOME;
registerHost(HOME);
registerHost(HOME, "beta", BETA);
// A stub controller: no grants yet; every call is recorded as "HOST: ARGS".
const CALLS = path.join(HOME, "calls");
process.env.BOXERY_BIN = path.join(HOME, "boxery");
writeFileSync(process.env.BOXERY_BIN, `#!/bin/sh\nh=-; while [ "$1" = --host ] || [ "$1" = --profile-dir ]; do [ "$1" = --host ] && h=$2; shift 2; done\necho "$h: $*" >> ${JSON.stringify(CALLS)}\ncase "$*" in *--json) echo '[]' ;; *) echo "==> granted" ;; esac\n`);
chmodSync(process.env.BOXERY_BIN, 0o755);
const lastCall = () => readFileSync(CALLS, "utf8").trim().split("\n").at(-1);
const text = (r) => r.content[0].text;

describe("pi extension", { skip: !canLoad && "needs Node >= 22.18 (TypeScript stripping + module.registerHooks)" }, () => {
	it("vm_manage keeps the current VM in pi session state", async () => {
		const { tools, entries } = await load();
		const r = await tools.get("vm_manage").execute("1", { action: "none" }, undefined, undefined, {});
		assert.deepEqual(r.content, [{ type: "text", text: "no current VM" }]);
		assert.deepEqual(entries.at(-1), { type: "boxery-current", data: { vm: null, host: "test", configDir: HOME } });
		await assert.rejects(tools.get("vm_click").execute("2", { x: 1, y: 1 }, undefined, undefined, {}), /no current VM/i);
	});

	it("vm_grant asks with pi's confirm dialog; without a UI it hands over the command", async () => {
		const { tools } = await load();
		const grant = tools.get("vm_grant");
		const asked = [];
		const ui = (answer) => ({ hasUI: true, ui: { confirm: async (title, message) => (asked.push({ title, message }), answer) } });
		const ok = await grant.execute("1", { vm: "demo", spec: "ssh-agent", reason: "git over ssh" }, undefined, undefined, ui(true));
		assert.match(text(ok), /^The user approved: demo now has ssh-agent/);
		assert.equal(lastCall(), "test: grant demo ssh-agent");
		assert.equal(asked[0].title, "boxery: grant VM access?");
		assert.match(asked[0].message, /^Give VM "demo" on host "test" access to:/);
		const no = await grant.execute("2", { vm: "demo", spec: "ssh-agent", reason: "x" }, undefined, undefined, ui(false));
		assert.match(text(no), /^The user declined/);
		await assert.rejects(grant.execute("3", { vm: "demo", spec: "ssh-agent", reason: "x" }, undefined, undefined, { hasUI: false, ui: {} }), /can't show the user an approval prompt[\s\S]*boxery --host test grant demo ssh-agent/);
	});

	it("vm_lease runs on the extension's lease keeper", async () => {
		const { tools } = await load();
		const lease = tools.get("vm_lease");
		assert.deepEqual((await lease.execute("1", { action: "list" }, undefined, undefined, {})).content, [{ type: "text", text: "this session holds no leases" }]);
		await assert.rejects(lease.execute("2", { action: "release", vm: "pool-1" }, undefined, undefined, {}), /holds no lease on pool-1/);
		await assert.rejects(lease.execute("3", { action: "renew" }, undefined, undefined, {}), /invalid VM name/);
	});

	it("routes each call to its host, and vm_manage host switches the session's host", async () => {
		const { tools, entries } = await load();
		const [manage, info, grant] = ["vm_manage", "vm_info", "vm_grant"].map((n) => tools.get(n));
		assert.match(text(await info.execute("1", { action: "hosts" }, undefined, undefined, {})), /^test \*\t/m, "starts on the default host");
		// An explicit host for one call leaves the session where it was.
		await grant.execute("2", { host: "beta", vm: "demo", spec: "ssh-agent", reason: "x" }, undefined, undefined, { hasUI: true, ui: { confirm: async () => true } });
		assert.equal(lastCall(), "beta: grant demo ssh-agent");
		assert.match(text(await info.execute("3", { action: "list" }, undefined, undefined, {})), /\(host: test\)$/);
		// Selecting a host clears the current VM and is recorded, so a resumed session comes back to it.
		await manage.execute("4", { action: "new", vm: "demo", use: true }, undefined, undefined, {});
		assert.equal(lastCall(), "test: new demo");
		assert.equal(text(await manage.execute("5", { action: "host", host: "beta" }, undefined, undefined, {})), "current host: beta; no current VM");
		assert.deepEqual(entries.at(-1).data, { vm: null, host: "beta", configDir: BETA });
		await assert.rejects(tools.get("vm_click").execute("6", { x: 1, y: 1 }, undefined, undefined, {}), /no current VM/i);
		assert.match(text(await info.execute("7", { action: "list" }, undefined, undefined, {})), /\(host: beta\)$/);
		assert.equal(lastCall(), "beta: ls --json");
		// A VM on the session's host; a call naming the other host doesn't inherit its name.
		await manage.execute("8", { action: "new", vm: "web", use: true }, undefined, undefined, {});
		assert.equal(lastCall(), "beta: new web");
		await assert.rejects(tools.get("vm_click").execute("9", { host: "test", x: 1, y: 1 }, undefined, undefined, {}), /no current VM/i);
		await assert.rejects(manage.execute("10", { action: "host", host: "nope" }, undefined, undefined, {}), /unknown host: nope/);
	});

	it("resumes on the host the session recorded; --vm-host overrides the default", async () => {
		const branch = (data) => ({ sessionManager: { getBranch: () => [{ type: "custom", customType: "boxery-current", data }] }, ui: {} });
		const resumed = await load();
		await resumed.handlers.get("session_start")({ reason: "resume" }, branch({ vm: "web", ephemeral: false, host: "beta", configDir: BETA }));
		assert.match(text(await resumed.tools.get("vm_info").execute("1", { action: "list" }, undefined, undefined, {})), /current: web \(host: beta\)$/);
		// A registration that now points elsewhere is not followed.
		const moved = await load();
		const warnings = [];
		await moved.handlers.get("session_start")({ reason: "resume" }, { ...branch({ vm: "web", host: "beta", configDir: "/elsewhere" }), ui: { notify: (m) => warnings.push(m) } });
		assert.match(warnings[0], /belongs to host "beta", which is no longer registered as it was/);
		assert.match(text(await moved.tools.get("vm_info").execute("2", { action: "list" }, undefined, undefined, {})), /current: \(none\) \(host: test\)$/);
		const flagged = await load({ "vm-host": "beta" });
		const section = {};
		await flagged.handlers.get("before_agent_start")({ systemPromptOptions: { sections: section } });
		assert.match(section.boxery, /^Current host: beta\./);
	});
});
