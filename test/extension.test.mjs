// pi extension (extension/index.ts) against a stub pi: its session state, approvals and leases, on
// one host and across several. test/frontends.test.mjs checks its tools against the shared table.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { registerHost } from "./fixtures/register-host.mjs";
import { hostTransport, hostCalls } from "./fixtures/host-transport.mjs";
import { canLoad, loadExtension as load } from "./helpers/pi-extension.mjs";

const HOME = mkdtempSync(path.join(tmpdir(), "boxery-ext-")); // no real controller config
const BETA = path.join(HOME, "profiles", "beta");
process.env.BOXERY_HOME = HOME;
registerHost(HOME);
registerHost(HOME, "beta", BETA);
hostTransport(HOME, [HOME, BETA]);
mkdirSync(path.join(HOME, "bin"));
writeFileSync(path.join(HOME, "bin/ssh"), '#!/bin/sh\ncat >/dev/null\n');
chmodSync(path.join(HOME, "bin/ssh"), 0o755);
process.env.PATH = `${HOME}/bin:${process.env.PATH}`;
// Controller operations run in-process against the stub host; the CLI must never be spawned.
process.env.BOXERY_BIN = path.join(HOME, "boxery");
writeFileSync(process.env.BOXERY_BIN, "#!/bin/sh\necho \"spawned the controller CLI: $*\" >&2\nexit 99\n");
chmodSync(process.env.BOXERY_BIN, 0o755);
// The stub host's calls, as "HOST: ARGS" (feature probes left out).
const hostName = (/** @type {string} */ dir) => (dir === BETA ? "beta" : dir === HOME ? "test" : dir);
const calls = () => hostCalls(HOME).map((l) => { const i = l.indexOf(": "); return `${hostName(l.slice(0, i))}: ${l.slice(i + 2)}`; }).filter((l) => !l.endsWith(": help"));
const resetCalls = () => rmSync(path.join(HOME, "host.calls"), { force: true });
const lastCall = () => calls().at(-1);
const text = (r) => r.content[0].text;

describe("pi extension", { skip: !canLoad && "needs Node >= 22.18 (TypeScript stripping + module.registerHooks)" }, () => {
	beforeEach(() => {
		for (const dir of [HOME, BETA]) for (const vm of ["demo", "pool-1"]) rmSync(path.join(dir, `grants/${vm}`), { force: true });
		resetCalls();
		writeFileSync(path.join(HOME, "bin/ssh"), '#!/bin/sh\ncat >/dev/null\n');
	});
	const stored = (dir = HOME) => readFileSync(path.join(dir, "grants/demo"), "utf8");
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
		assert.match(stored(), /^ssh-agent\t/m);
		assert.doesNotMatch(calls().join("\n"), /: grant /);
		rmSync(path.join(HOME, "grants/demo"));
		assert.equal(asked[0].title, "boxery: grant VM access?");
		assert.match(asked[0].message, /^Give VM "demo" on host "test" access to:/);
		const no = await grant.execute("2", { vm: "demo", spec: "ssh-agent", reason: "x" }, undefined, undefined, ui(false));
		assert.match(text(no), /^The user declined/);
		await assert.rejects(grant.execute("3", { vm: "demo", spec: "ssh-agent", reason: "x" }, undefined, undefined, { hasUI: false, ui: {} }), /can't show the user an approval prompt[\s\S]*boxery --host test grant demo ssh-agent/);
	});

	it("llm: grants: vm_grant, /vm grant and /vm revoke use shared operations", async () => {
		const { tools, commands, handlers } = await load();
		const asked = [];
		const ui = { hasUI: true, ui: { confirm: async (_t, message) => (asked.push(message), true) } };
		const r = await tools.get("vm_grant").execute("1", { vm: "demo", spec: "llm:chatgpt", reason: "pi got a 403 from the proxy" }, undefined, undefined, ui);
		assert.match(text(r), /^The user approved: demo now has llm:chatgpt/);
		assert.match(stored(), /^llm\tchatgpt\t/m);
		assert.match(asked[0], /llm:chatgpt: the VM host's chatgpt credential/);
		await assert.rejects(tools.get("vm_grant").execute("2", { vm: "demo", spec: "llm:gemini", reason: "x" }, undefined, undefined, ui), /unknown LLM provider/);

		const notes = [];
		const ctx = { hasUI: true, ui: { ...ui.ui, notify: (m, lvl) => notes.push([m, lvl]) } };
		// The current VM as a resumed session restores it (no ssh needed).
		const saved = { type: "custom", customType: "boxery-current", data: { vm: "demo", ephemeral: false, host: "test", configDir: HOME } };
		await handlers.get("session_start")({ reason: "resume" }, { ...ctx, sessionManager: { getBranch: () => [saved] } });
		await commands.get("vm").handler("grant llm:anthropic llm:ollama", ctx);
		assert.match(stored(), /^llm\tanthropic\t/m);
		assert.match(stored(), /^llm\tollama\t/m);
		assert.equal(asked.length, 3);
		await commands.get("vm").handler("revoke llm:anthropic", ctx);
		assert.doesNotMatch(stored(), /anthropic/);
		await commands.get("vm").handler("grant", ctx);
		assert.match(notes.at(-1)[0], /usage: \/vm grant llm:PROVIDER/);
	});

	it("--vm-grant requires pi's dialog, including in print mode", async () => {
		for (const answer of [false, true]) {
			const ext = await load({ vm: "demo", "vm-grant": "ssh-agent" });
			let prompts = 0;
			await ext.handlers.get("session_start")({ reason: "startup" }, { hasUI: true, ui: { confirm: async () => { prompts++; return answer; }, notify: () => {} } });
			assert.equal(prompts, 1);
			if (answer) assert.match(stored(), /^ssh-agent\t/m);
			else assert.throws(() => stored(), /ENOENT/);
		}
		rmSync(path.join(HOME, "grants/demo"));
		const ext = await load({ vm: "demo", "vm-grant": "ssh-agent" });
		const notes = [];
		await ext.handlers.get("session_start")({ reason: "startup" }, { hasUI: false, ui: { notify: (m) => notes.push(m) } });
		assert.match(notes.join("\n"), /Grants need a person/);
		assert.throws(() => stored(), /ENOENT/);
	});

	it("new/pool grant preflight rejects print mode or invalid specs before allocating resources", async () => {
		for (const vm of ["new", "pool"]) for (const invalid of [false, true]) {
			resetCalls();
			const notes = [];
			const ext = await load({ vm, "vm-grant": invalid ? "env:1INVALID" : "ssh-agent" });
			await ext.handlers.get("session_start")({ reason: "startup" }, { hasUI: invalid, ui: { confirm: async () => { throw new Error("must not prompt"); }, notify: (m) => notes.push(m) } });
			await ext.handlers.get("session_shutdown")({});
			assert.match(notes.join("\n"), invalid ? /unknown grant/ : /Grants need a person/);
			assert.equal(calls().join("\n"), "", "no create/acquire (or cleanup) is needed");
			assert.equal(ext.entries.length, 0);
		}
	});

	it("throwaway grant approval precedes creation, and ownership survives shutdown", async () => {
		for (const answer of [false, true]) {
			resetCalls();
			const ext = await load({ vm: "new", "vm-grant": "ssh-agent" });
			await ext.handlers.get("session_start")({ reason: "startup" }, { hasUI: true, ui: {
				confirm: async () => { assert.equal(calls().join("\n"), ""); return answer; }, notify: () => {},
			} });
			await ext.handlers.get("session_shutdown")({});
			const seen = calls().join("\n");
			if (answer) {
				const name = seen.match(/test: new (pi-[a-f0-9]+)/)?.[1];
				assert.ok(name, seen); assert.ok(seen.includes(`test: rm ${name}`), seen);
			} else { assert.equal(seen, ""); assert.equal(ext.entries.length, 0); }
		}
	});

	it("a failed throwaway readiness check cleans up the just-created VM", async () => {
		writeFileSync(path.join(HOME, "bin/ssh"), '#!/bin/sh\nexit 255\n');
		const ext = await load({ vm: "new", "vm-grant": "ssh-agent" });
		await ext.handlers.get("session_start")({ reason: "startup" }, { hasUI: true, ui: { confirm: async () => true, notify: () => {} } });
		await ext.handlers.get("session_shutdown")({});
		const seen = calls().join("\n"), name = seen.match(/test: new (pi-[a-f0-9]+)/)?.[1];
		assert.ok(name, seen); assert.ok(seen.includes(`test: rm ${name}`), seen);
	});

	it("pool decline or a failed dialog immediately releases the lease instead of stranding it", async () => {
		for (const error of [false, true]) {
			resetCalls();
			const ext = await load({ vm: "pool", "vm-grant": "ssh-agent" });
			await ext.handlers.get("session_start")({ reason: "startup" }, { hasUI: true, ui: {
				confirm: async (_title, message) => { assert.match(message, /VM \"pool-1\"/); if (error) throw new Error("dialog failed"); return false; }, notify: () => {},
			} });
			// Leases go to the host in-process (core/leases.mjs); the stub host logs "PROFILE: ARGS".
			const calls = hostCalls(HOME).join("\n");
			assert.match(calls, new RegExp(`^${HOME}: acquire `, "m"));
			assert.match(calls, new RegExp(`^${HOME}: release l-0123456789abcdef0123456789abcdef$`, "m"));
			assert.equal(ext.entries.length, 0);
			await ext.handlers.get("session_shutdown")({});
			assert.equal(hostCalls(HOME).join("\n"), calls, "no lease remains until shutdown");
		}
	});

	it("an approved pool grant is applied to the acquired VM and its lease is released on shutdown", async () => {
		const ext = await load({ vm: "pool", "vm-grant": "ssh-agent" });
		await ext.handlers.get("session_start")({ reason: "startup" }, { hasUI: true, ui: {
			confirm: async (_title, message) => { assert.match(message, /VM \"pool-1\"/); return true; }, notify: () => {},
		} });
		assert.match(readFileSync(path.join(HOME, "grants/pool-1"), "utf8"), /^ssh-agent\t/);
		assert.equal(ext.entries.at(-1).data.vm, "pool-1");
		await ext.handlers.get("session_shutdown")({});
		assert.match(hostCalls(HOME).at(-1) ?? "", /: release l-0123456789abcdef0123456789abcdef$/);
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
		assert.match(stored(BETA), /^ssh-agent\t/m);
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
