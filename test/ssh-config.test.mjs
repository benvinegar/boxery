// core/ssh-config.mjs against the Bash controller: the ssh_config each renders for the same profile, and
// the quoting helpers word for word. Golden files (test/fixtures/ssh-config) were rendered by
// controller/profile.sh's write_ssh_config; a live check renders them again with this checkout's Bash.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as S from "../core/ssh-config.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIX = path.join(ROOT, "test/fixtures/ssh-config");
const cases = readdirSync(FIX).filter((f) => f.endsWith(".case")).map((f) => f.slice(0, -5)).sort();
const profileSh = path.join(ROOT, "controller/profile.sh");

/** A golden case as its .case file lists it (host, host bin, host profile, identity, pins, dir, leases, grants). @param {string} name */
function load(name) {
	const [host, hostBin, hostProfile, identity, pins, dir, leases, grants] = readFileSync(path.join(FIX, `${name}.case`), "utf8").split("\n");
	const agentVms = grants.split(/\s+/).filter(Boolean).filter((g) => g.split("=")[1].split("|")[0] === "ssh-agent").map((g) => g.split("=")[0]).sort();
	return {
		host, hostBin, hostProfile, identity, pins: pins === "1", dir: `@BASE@/${dir}`, home: "@HOME@",
		leases: leases.split(" ").filter(Boolean).map((l) => ({ name: l.split(":")[0], id: l.split(":")[1] })).sort((a, b) => a.id.localeCompare(b.id)),
		agentVms,
	};
}

test("renders the same ssh_config as the Bash controller (golden files)", () => {
	assert.ok(cases.length >= 8, "golden cases present");
	for (const c of cases) assert.equal(S.renderSshConfig(load(c)), readFileSync(path.join(FIX, `${c}.ssh_config`), "utf8"), c);
});

test("the golden files are still what this checkout's Bash renders", () => {
	const out = execFileSync("bash", [path.join(ROOT, "test/fixtures/ssh-config-golden.sh"), ROOT, "-"], { encoding: "utf8" });
	const section = (/** @type {string} */ title) => `${out.split(`=== ${title}\n`)[1]?.split("\n=== ")[0]?.replace(/\n$/, "")}\n`;
	for (const c of cases) assert.equal(section(c), readFileSync(path.join(FIX, `${c}.ssh_config`), "utf8"), `${c}: regenerate with: bash test/fixtures/ssh-config-golden.sh . test/fixtures/ssh-config`);
});

// Strings that exercise every escape: quotes, $, `, \, %, spaces, ~, globs, unicode.
const NASTY = ["", "plain", "a b", "it's", 'say "hi"', "$HOME", "`id`", "back\\slash", "100%", "%h%%", "~", "~/x", "~user", "*?[a]", "ünï", "'\"$`\\%"];

/** Run one profile.sh helper on each input in one bash, NUL-separated. @param {string} fn @param {string[]} inputs */
function bash(fn, inputs) {
	const out = execFileSync("bash", ["-c", `. "$1"; f=$2; shift 2; for a; do "$f" "$a"; printf '\\0'; done`, "x", profileSh, fn, ...inputs], { encoding: "utf8", env: { ...process.env, BOXERY_HOME: "/nonexistent" } });
	return out.split("\0").slice(0, -1);
}

test("quoting helpers match profile.sh word for word", () => {
	for (const [fn, js] of /** @type {[string, (s: string) => string][]} */ ([
		["literal", S.literal], ["remote_path", S.remotePath], ["shell_double", S.shellDouble], ["ssh_value", S.sshValue],
		["ssh_word", S.sshWord], ["ssh_include_value", S.sshIncludeValue], ["known_hosts_command", S.knownHostsCommand],
	])) assert.deepEqual(NASTY.map(js), bash(fn, NASTY), fn);
	assert.equal(S.literalArgs(NASTY), execFileSync("bash", ["-c", '. "$1"; shift; literal_args "$@"', "x", profileSh, ...NASTY], { encoding: "utf8", env: { ...process.env, BOXERY_HOME: "/nonexistent" } }), "literal_args");
});

test("literal and literalArgs survive a real shell", () => {
	const back = execFileSync("sh", ["-c", `for a in ${S.literalArgs(NASTY)}; do printf '%s\\0' "$a"; done`], { encoding: "utf8" }).split("\0").slice(0, -1);
	assert.deepEqual(back, NASTY);
	assert.equal(execFileSync("sh", ["-c", `HOME=/h; printf %s ${S.remotePath("~/a b")}`], { encoding: "utf8" }), "/h/a b");
	assert.equal(execFileSync("sh", ["-c", `printf %s ${S.remotePath("~user/x")}`], { encoding: "utf8" }), "~user/x");
});

test("checkTarget and remoteCommand", () => {
	const t = { host: "ben@hornet", hostBin: "~/bin/boxery host", hostProfile: "iso", identity: "" };
	S.checkTarget(t);
	assert.equal(S.remoteCommand(t, ["snap", "x; rm -rf /"]), `exec "$HOME"/'bin/boxery host' --profile iso 'snap' 'x; rm -rf /'`);
	assert.throws(() => S.checkTarget({ ...t, host: "-oProxyCommand=x" }), /invalid ssh destination/);
	assert.throws(() => S.checkTarget({ ...t, host: "a b" }), /invalid ssh destination/);
	assert.throws(() => S.checkTarget({ ...t, hostBin: "-x" }), /invalid host executable/);
	assert.throws(() => S.checkTarget({ ...t, hostBin: "a\nb" }), /line breaks/);
	assert.throws(() => S.checkTarget({ ...t, hostProfile: "Bad" }), /invalid host profile/);
	assert.equal(S.localHostBin("~/x/y", "/home/u"), "/home/u/x/y");
	assert.equal(S.localHostBin("/abs", "/home/u"), "/abs");
	assert.equal(S.localHostBin("~", homedir()), "~", "only ~/ expands, like local_host_bin");
});

test("parseConfig reads what setup writes and refuses anything that needs a shell", () => {
	const setup = execFileSync("bash", ["-c", `. "$1"; for v in HOST HOST_BIN IDENTITY HOST_PROFILE; do printf '%s=' "$v"; literal "$2"; printf '\\n'; shift; done`, "x", profileSh, "u@h", "~/it's bin", "/k/id %h", "p1"], { encoding: "utf8", env: { ...process.env, BOXERY_HOME: "/nonexistent" } });
	assert.deepEqual(S.parseConfig(`# comment\n${setup}GRANT_CONFIRM=off # note\nHOST=local\n\n`), { HOST: "local", HOST_BIN: "~/it's bin", IDENTITY: "/k/id %h", HOST_PROFILE: "p1", GRANT_CONFIRM: "off" });
	for (const bad of [
		"HOST=$X", "HOST=`id`", 'HOST="$X"', "HOST=~/x", "HOST='unterminated", "HOST=a b", "HOST=a;b", "HOST=a\\", "HOST=x\r",
		"echo hi", "f() { :; }", "if true; then :; fi", "export HOST=x", "export X=1", "PATH=/x", "HOME=/h", "SSH_AUTH_SOCK=/s", "UID=5", "IFS=x", "BASH_ENV=/x", "X=1",
	]) assert.equal(S.parseConfig(bad), null, bad);
});

test("a parsed config means what bash makes of it", () => {
	// Every config parseConfig accepts: bash, sourcing it like the CLI, must agree on each setting.
	for (const text of ["HOST=a\nHOST=b", "HOST='a b'\\\nHOST_BIN=x", "HOST=\"u@h\" # c\nIDENTITY=a\\ b", "HOST_BIN='~/x'", "HOST=a'b'\"c\"d", "GRANT_CONFIRM=off\nHOST_PROFILE=p"]) {
		const parsed = S.parseConfig(text);
		if (!parsed) continue;
		const vals = execFileSync("bash", ["-c", `set -eu; HOST= HOST_BIN=~/.local/bin/boxery-host HOST_PROFILE= IDENTITY= GRANT_CONFIRM=; eval "$1"; printf '%s\\0' "$HOST" "$HOST_BIN" "$HOST_PROFILE" "$IDENTITY" "$GRANT_CONFIRM"`, "x", text], { encoding: "utf8", env: { ...process.env, HOME: "/h" } }).split("\0");
		assert.deepEqual([parsed.HOST ?? "", parsed.HOST_BIN ?? "/h/.local/bin/boxery-host", parsed.HOST_PROFILE ?? "", parsed.IDENTITY ?? "", parsed.GRANT_CONFIRM ?? ""], vals.slice(0, 5), JSON.stringify(text));
	}
});
