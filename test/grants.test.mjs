// Real CLI + controlling-terminal tests; all profiles, stores and transports are temporary.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { registerHost } from "./fixtures/register-host.mjs";
import { grantTransport } from "./fixtures/grant-transport.mjs";
const root = mkdtempSync(path.join(tmpdir(), "boxery-grant-test-"));
const profile = path.join(root, "profile"), bin = path.join(root, "bin");
mkdirSync(bin);
const registryRoot = path.join(root, "registry");
process.env.BOXERY_HOME = registryRoot;
registerHost(process.env.BOXERY_HOME, "local", profile);
grantTransport(root, [profile]);
const config = readFileSync(path.join(profile, "config"), "utf8");
const hostScript = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/host.calls'\ncase "$1" in edge-set) cat >/dev/null ;; ls) if [ "\${2:-}" = --json ]; then cat '${root}/inventory.json'; else cat '${root}/inventory.txt'; fi ;; esac\nexit 0\n`;
writeFileSync(path.join(root, "grant-host"), hostScript);
writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nfor a; do [ "$a" != -O ] || exit 0; done\ncat > '${root}/apply.script'\n`);
chmodSync(path.join(bin, "ssh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
// Any accidental CLI spawn from grantRequest must fail, including read/list/apply calls.
process.env.BOXERY_BIN = path.join(bin, "forbidden-cli");
writeFileSync(process.env.BOXERY_BIN, `#!/bin/sh\necho spawned > '${root}/spawned'\nexit 99\n`);
chmodSync(process.env.BOXERY_BIN, 0o755);
const core = await import("../core/boxery-core.mjs");
const grants = await import("../core/grants.mjs");
const cli = path.resolve(import.meta.dirname, "../controller/boxery");
const store = path.join(profile, "grants/demo");
/** @param {string[]} args @param {string} [input] @param {NodeJS.ProcessEnv} [extra] */
function headless(args, input = "", extra = {}) {
	return new Promise((resolve, reject) => {
		const p = spawn(cli, args, { env: { ...process.env, ...extra }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		let output = "", stdout = "", stderr = "";
		p.stdout.on("data", (d) => { stdout += d; output += d; }); p.stderr.on("data", (d) => { stderr += d; output += d; });
		p.on("error", reject); p.on("close", (code) => resolve({ code, output, stdout, stderr }));
		p.stdin.on("error", () => {}); p.stdin.end(input);
	});
}
/** @param {string[]} args @param {string} answer */
function terminal(args, answer) {
	return JSON.parse(execFileSync("python3", [path.join(import.meta.dirname, "fixtures/grant-pty.py"), answer, cli, ...args], { env: process.env, encoding: "utf8", timeout: 20_000 }));
}
beforeEach(() => {
	rmSync(store, { force: true });
	writeFileSync(path.join(profile, "config"), config);
	writeFileSync(path.join(profile, "ssh_config"), "# fixture\n");
	writeFileSync(path.join(root, "grant-host"), hostScript);
	writeFileSync(path.join(registryRoot, "host-registry/local"), `${profile}\n`);
	writeFileSync(path.join(root, "inventory.json"), '[\n{"name":"demo"}\n]\n');
	writeFileSync(path.join(root, "inventory.txt"), 'NAME STATE\ndemo running\n');
	rmSync(path.join(root, "spawned"), { force: true });
	rmSync(path.join(root, "host.calls"), { force: true });
});
after(() => rmSync(root, { recursive: true, force: true }));

test("CLI without a controlling TTY refuses, including y on stdin and inherited opt-outs", async () => {
	for (const input of ["", "y\n", "yes\nyes\n"]) {
		const r = await headless(["grant", "demo", "ssh-agent"], input, { GRANT_CONFIRM: "off", BOXERY_ASSUME_YES: "1" });
		assert.notEqual(r.code, 0);
		assert.match(r.output, /grants need a person[\s\S]*vm_grant[\s\S]*boxery --host local grant demo ssh-agent/);
		assert.equal(existsSync(store), false);
	}
});

test("agent-forward on, creation grants and fork --grants also refuse without a person", async () => {
	writeFileSync(path.join(profile, "grants/source"), "ssh-agent\t\t\n");
	for (const args of [["agent-forward", "demo", "on"], ["new", "demo", "--grant", "ssh-agent"], ["new", "demo", "--agent-forward"], ["fork", "source", "demo", "--grants"]]) {
		const r = await headless(args, "y\n");
		assert.notEqual(r.code, 0, args.join(" "));
		assert.match(r.output, /grants need a person/);
		assert.equal(existsSync(store), false);
		assert.equal(existsSync(path.join(root, "host.calls")), false, "no VM is created before approval");
	}
});

test("real PTY: No and empty answer decline; Yes applies; CLI and vm_grant share exact prompt text", async () => {
	for (const answer of ["n", ""]) {
		const no = terminal(["grant", "demo", "ssh-agent"], answer);
		assert.notEqual(no.code, 0); assert.equal(existsSync(store), false);
	}
	const yes = terminal(["grant", "demo", "ssh-agent"], "y");
	assert.equal(yes.code, 0, yes.output);
	assert.match(readFileSync(store, "utf8"), /^ssh-agent\t/m);
	rmSync(store);
	let prompt = "";
	await core.grantRequest("demo", { spec: "ssh-agent" }, { approve: async (text) => { prompt = text; return "decline"; } });
	assert.equal(yes.output.slice(0, yes.output.indexOf("\n\nAllow access?")), prompt);
	assert.equal(existsSync(store), false);
});

test("real PTY: creation and fork grants ask before lifecycle effects", () => {
	writeFileSync(path.join(profile, "grants/source"), "ssh-agent\t\t\n");
	for (const args of [["new", "demo", "--grant", "ssh-agent"], ["new", "demo", "--agent-forward"], ["fork", "source", "demo", "--grants"]]) {
		const no = terminal(args, "n");
		assert.notEqual(no.code, 0);
		assert.equal(existsSync(path.join(root, "host.calls")), false);
		assert.equal(existsSync(store), false);
		const yes = terminal(args, "yes");
		assert.equal(yes.code, 0, yes.output);
		assert.match(readFileSync(store, "utf8"), /^ssh-agent\t/m);
		assert.match(readFileSync(path.join(root, "host.calls"), "utf8"), /^(new demo|fork source demo)/);
		rmSync(store); rmSync(path.join(root, "host.calls"));
	}
});

test("invalid spec in a batch is rejected before any grant or prompt", async () => {
	const r = await headless(["grant", "demo", "ssh-agent", "env:1BAD"]);
	assert.notEqual(r.code, 0);
	assert.doesNotMatch(r.output, /grants need a person/);
	assert.equal(existsSync(store), false);
});

test("vm_grant approval applies in-process; decline changes nothing; no CLI spawn even for listing", async () => {
	process.env.GRANT_TEST_VALUE = "secret value";
	const a = { spec: "env:GRANT_TEST_VALUE", reason: "test" };
	const no = await core.grantRequest("demo", a, { approve: async () => "decline" });
	assert.match(no.text, /declined/); assert.equal(existsSync(store), false);
	const yes = await core.grantRequest("demo", a, { approve: async () => "accept" });
	assert.match(yes.text, /The user approved/);
	assert.match(readFileSync(store, "utf8"), /^env\tGRANT_TEST_VALUE\t/m);
	assert.match(readFileSync(path.join(root, "apply.script"), "utf8"), /put_env 'GRANT_TEST_VALUE' /);
	assert.equal(existsSync(path.join(root, "spawned")), false);
	const before = readFileSync(store, "utf8");
	await core.grantRequest("demo", { spec: "ssh-agent" }, { approve: async () => "decline" });
	assert.equal(readFileSync(store, "utf8"), before);
});

test("both paths enforce deny directories, aliases and BOXERY_* variables, even with config opt-out", async () => {
	writeFileSync(path.join(profile, "secret"), "private");
	const link = path.join(root, "alias"); symlinkSync(path.join(profile, "secret"), link);
	writeFileSync(path.join(profile, "config"), config + "GRANT_CONFIRM=off\n");
	for (const spec of [`file:${profile}/secret`, `file:${link}`, "env:BOXERY_MCP_TOKEN"]) {
		const r = await headless(["grant", "demo", spec]);
		assert.notEqual(r.code, 0); assert.doesNotMatch(r.output, /grants need a person/);
		await assert.rejects(core.grantRequest("demo", { spec }, { approve: async () => { throw new Error("must not prompt"); } }), /can't be (granted|requested)/);
	}
	assert.equal(existsSync(store), false);
});

test("a requested symlink stays pinned to the approved real path", async () => {
	const first = path.join(root, "first.env"), second = path.join(root, "second.env"), alias = path.join(root, "dev-link");
	writeFileSync(first, "FIRST"); writeFileSync(second, "SECOND"); symlinkSync(first, alias);
	await core.grantRequest("demo", { spec: `file:${alias}` }, { approve: async () => { rmSync(alias); symlinkSync(second, alias); return "accept"; } });
	assert.match(readFileSync(store, "utf8"), new RegExp(`file\\t${first}\\tproject/dev-link`));
	assert.ok(readFileSync(path.join(root, "apply.script"), "utf8").includes(Buffer.from("FIRST").toString("base64")));
});

test("file-only automation opt-out; list/apply/revoke need no confirmation", async () => {
	writeFileSync(path.join(profile, "config"), config + "GRANT_CONFIRM=off\n");
	assert.equal((await headless(["grant", "demo", "ssh-agent"])).code, 0);
	writeFileSync(path.join(profile, "config"), config);
	for (const args of [["grants", "demo"], ["grants", "demo", "--json"], ["grants", "demo", "apply"], ["agent-forward", "demo", "off"], ["revoke", "demo", "all"]]) {
		const r = await headless(args);
		assert.equal(r.code, 0, r.output); assert.doesNotMatch(r.output, /Allow access|grants need a person/);
	}
});

test("pinned --profile-dir keeps listing and reapplying after the registry changes or is removed", async () => {
	const registry = path.join(registryRoot, "host-registry/local");
	const other = path.join(root, "moved-profile");
	mkdirSync(other, { recursive: true });
	grantTransport(root, [other]);
	writeFileSync(path.join(other, "ssh_config"), "# other profile\n");
	writeFileSync(path.join(root, "grant-host"), hostScript);
	writeFileSync(path.join(other, "grants/demo"), "env\tOTHER_PROFILE\t\n");
	writeFileSync(store, "env\tPINNED_PROFILE\t\n");
	process.env.PINNED_PROFILE = "original-profile";
	for (const moved of [true, false]) {
		if (moved) writeFileSync(registry, `${other}\n`); else rmSync(registry);
		const prefix = ["--host", "local", "--profile-dir", profile];
		const listed = await headless([...prefix, "ls", "--json"]);
		assert.equal(listed.code, 0, listed.output);
		assert.equal(JSON.parse(listed.stdout)[0].grants[0].var, "PINNED_PROFILE");
		const denied = await headless([...prefix, "grant", "demo", `file:${profile}/config`]);
		assert.notEqual(denied.code, 0);
		assert.match(denied.output, /can't be granted/);
		const applied = await headless([...prefix, "grants", "demo", "apply"]);
		assert.equal(applied.code, 0, applied.output);
		assert.ok(readFileSync(path.join(root, "apply.script"), "utf8").includes(Buffer.from("original-profile").toString("base64")));
	}
});

test("ls --json fails without emitting malformed JSON if grant lookup fails", async () => {
	writeFileSync(store, "unknown-kind\t\t\n");
	const r = await headless(["ls", "--json"]);
	assert.notEqual(r.code, 0);
	assert.equal(r.stdout, "");
	assert.match(r.stderr, /unknown stored grant kind/);
	const noNode = path.join(root, "no-node"); mkdirSync(noNode);
	writeFileSync(path.join(noNode, "node"), '#!/bin/sh\nexit 17\n'); chmodSync(path.join(noNode, "node"), 0o755);
	const missing = await headless(["ls", "--json"], "", { PATH: `${noNode}:${process.env.PATH}` });
	assert.equal(missing.code, 17); assert.equal(missing.stdout, "");
});

test("text ls preserves non-VM informational lines without trying to read their grants", async () => {
	writeFileSync(path.join(root, "inventory.txt"), 'NAME STATE\n(no VMs)\nNOTICE: older host\n');
	const r = await headless(["ls"]);
	assert.equal(r.code, 0, r.output);
	assert.match(r.stdout, /\(no VMs\)/);
	assert.doesNotMatch(r.stderr, /invalid VM name/);
});

test("revoke warns when nothing matched instead of claiming access was removed", async () => {
	writeFileSync(store, "env\tKEPT\t\n");
	const typo = await headless(["revoke", "demo", "env:TYPO"]);
	assert.equal(typo.code, 0, typo.output);
	assert.match(typo.output, /no grant env:TYPO/);
	assert.doesNotMatch(typo.output, /revoked env:TYPO/);
	assert.equal(readFileSync(store, "utf8"), "env\tKEPT\t\n");
	const out = await grants.revokeGrants("demo", ["env:KEPT", "env:KEPT"]);
	assert.match(out, /revoked env:KEPT[\s\S]*no grant env:KEPT/);
	assert.equal(existsSync(store), false);
});

test("an incomplete registry entry does not block apply or hide its directory from symlink checks", async () => {
	const broken = path.join(root, "incomplete-profile"), registry = path.join(registryRoot, "host-registry/broken");
	mkdirSync(broken); writeFileSync(path.join(broken, "secret"), "DO-NOT-PUSH");
	writeFileSync(registry, `${broken}\n`);
	const alias = path.join(root, "legacy-link"); symlinkSync(path.join(broken, "secret"), alias);
	process.env.RECONCILE_VALUE = "existing";
	writeFileSync(store, `env\tRECONCILE_VALUE\t\nhttp\tapi.example.com\tbearer;;printf token\nfile\t${alias}\tproject/secret\n`);
	try {
		assert.throws(() => core.registeredHosts(), /incomplete profile/);
		const out = await grants.applyGrants("demo");
		assert.match(out, /now leads through a symlink[\s\S]*skipped/);
		const script = readFileSync(path.join(root, "apply.script"), "utf8");
		assert.match(script, /put_env 'RECONCILE_VALUE'/);
		assert.match(script, /put_edge 'api.example.com'/);
		assert.ok(!script.includes(Buffer.from("DO-NOT-PUSH").toString("base64")));
		assert.match(readFileSync(path.join(root, "host.calls"), "utf8"), /edge-set demo/);
	} finally { rmSync(registry); }
});

test("post-commit config and close failures explicitly report saved but not fully applied", async () => {
	for (const fn of ["write_ssh_config", "drop_master"]) {
		writeFileSync(path.join(profile, "config"), `${config}\n${fn}() { echo '${fn} failed' >&2; return 1; }\n`);
		const out = await grants.addGrants("demo", [core.parseGrantRequest({ spec: "ssh-agent" })]);
		assert.match(out, /are saved, but the change is not fully applied/);
		assert.ok(out.includes(`${fn} failed`));
		assert.match(readFileSync(store, "utf8"), /^ssh-agent\t/);
	}
});

test("cancellation after commit finishes SSH configuration and application", async () => {
	const ready = path.join(root, "config-ready"), release = path.join(root, "config-release");
	writeFileSync(path.join(profile, "config"), `${config}\nwrite_ssh_config() { : > '${ready}'; while [ ! -f '${release}' ]; do sleep 0.01; done; printf 'ForwardAgent yes\\n' > "$SSH_CONF"; }\n`);
	const abort = new AbortController();
	const pending = grants.addGrants("demo", [core.parseGrantRequest({ spec: "ssh-agent" })], { signal: abort.signal });
	try {
		for (let i = 0; !existsSync(ready) && i < 500; i++) await core.sleep(10);
		assert.equal(existsSync(ready), true);
		assert.equal(existsSync(store), true);
		abort.abort(); writeFileSync(release, "");
		assert.doesNotMatch(await pending, /not fully applied/);
		assert.match(readFileSync(path.join(profile, "ssh_config"), "utf8"), /ForwardAgent yes/);
	} finally { writeFileSync(release, ""); await pending; }
});

test("cancellation while waiting for the store lock makes no change", async () => {
	const lock = path.join(profile, "grants/.demo.lock"); writeFileSync(lock, "");
	const abort = new AbortController();
	const pending = grants.addGrants("demo", [core.parseGrantRequest({ spec: "ssh-agent" })], { signal: abort.signal });
	abort.abort(); rmSync(lock);
	await assert.rejects(pending, /aborted/);
	assert.equal(existsSync(store), false);
});

test("approved CLI env commands retain original stdin and visible stderr", async () => {
	const cmd = 'printf helper-prompt >&2; IFS= read -r token; printf %s "$token"';
	const pty = terminal(["grant", "demo", "env:FROM_PTY", "--cmd", cmd], "y\npty-value");
	assert.equal(pty.code, 0, pty.output); assert.match(pty.output, /helper-prompt/);
	assert.ok(readFileSync(path.join(root, "apply.script"), "utf8").includes(Buffer.from("pty-value").toString("base64")));
	writeFileSync(path.join(profile, "config"), config + "GRANT_CONFIRM=off\n");
	const r = await headless(["grant", "demo", "env:FROM_STDIN", "--cmd", cmd], "pipe-value\n");
	assert.equal(r.code, 0, r.output); assert.match(r.stderr, /helper-prompt/);
	assert.ok(readFileSync(path.join(root, "apply.script"), "utf8").includes(Buffer.from("pipe-value").toString("base64")));
	// Only keep one stdin-consuming grant for the reapply check.
	writeFileSync(store, `env\tFROM_STDIN\t${cmd}\n`);
	const reapplied = await headless(["grants", "demo", "apply"], "refreshed\n");
	assert.equal(reapplied.code, 0, reapplied.output);
	assert.ok(readFileSync(path.join(root, "apply.script"), "utf8").includes(Buffer.from("refreshed").toString("base64")));
	const failed = await headless(["grant", "demo", "env:FAILED_HELPER", "--cmd", 'echo credential-helper-failed >&2; exit 1']);
	assert.match(failed.stderr, /credential-helper-failed/);
});

test("multi-destination forks require every approval and revalidate source grants", () => {
	writeFileSync(path.join(profile, "grants/source"), "ssh-agent\t\t\n");
	const no = terminal(["fork", "source", "one", "two", "--grants"], "y\nn");
	assert.notEqual(no.code, 0); assert.equal(existsSync(path.join(root, "host.calls")), false);
	assert.equal(existsSync(path.join(profile, "grants/one")), false);
	const yes = terminal(["fork", "source", "one", "two", "--grants"], "y\ny");
	assert.equal(yes.code, 0, yes.output);
	assert.equal(yes.output.split("Allow access? [y/N]").length - 1, 2);
	for (const vm of ["one", "two"]) assert.match(readFileSync(path.join(profile, `grants/${vm}`), "utf8"), /^ssh-agent\t/);
	rmSync(path.join(root, "host.calls"));
	writeFileSync(path.join(profile, "grants/source"), `file\t${root}/missing.env\tproject/.env\n`);
	const invalid = terminal(["fork", "source", "three", "--grants"], "y");
	assert.notEqual(invalid.code, 0); assert.match(invalid.output, /no such local file/);
	assert.equal(existsSync(path.join(root, "host.calls")), false);
});

test("all grant kinds use the same prompt formatter and validation on both front-ends", () => {
	const file = path.join(root, "dev.env"); writeFileSync(file, "A=1");
	for (const spec of ["ssh-agent", "github", "env:EXAMPLE", `file:${file}=.config/dev.env`, "llm:chatgpt"]) {
		const agent = core.parseGrantRequest({ spec });
		const user = grants.parseGrantSpec({ spec }, { cli: true });
		assert.equal(grants.grantPrompt("demo", "local", user), grants.grantPrompt("demo", "local", agent));
	}
});
