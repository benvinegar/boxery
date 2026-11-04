// core/profile.mjs: reading a profile's config (parsed, or sourced when it needs a shell), boxery-host
// commands on local and remote hosts, ssh_config publication. A stub ssh joins argv into one string
// and runs it with sh -c, as real ssh does on the far side.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { registerHost } from "./fixtures/register-host.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "boxery-profile-"));
const home = path.join(dir, "home"), bin = path.join(dir, "bin"), calls = path.join(dir, "calls");
registerHost(home);
mkdirSync(bin);
// ssh: -O exit (closeMaster) is recorded; otherwise skip options, take the destination and run the rest remotely.
writeFileSync(path.join(bin, "ssh"), `#!/usr/bin/env bash
for a; do [ "$a" != -O ] || { echo "close $*" >> ${JSON.stringify(calls)}; exit 0; }; done
while [ $# -gt 0 ]; do case $1 in -o|-F|-p) shift 2 ;; --) shift; break ;; -*) shift ;; *) break ;; esac; done
echo "ssh-dest $1" >> ${JSON.stringify(calls)}; shift
exec sh -c "$*"
`);
chmodSync(path.join(bin, "ssh"), 0o755);
// boxery-host: records argv (one per line), echoes stdin back, exits with $EXIT.
const hostbin = path.join(dir, "host bin's");
writeFileSync(hostbin, `#!/bin/sh\nfor a; do printf 'arg[%s]\\n' "$a"; done >> ${JSON.stringify(calls)}\n[ -z "$STUB_ENV" ] || echo "env $STUB_ENV" >> ${JSON.stringify(calls)}\n[ "$1" != --profile ] || shift 2\ncase "$1" in help) echo '  known-hosts NAME' ;; fail) echo 'it broke' >&2; exit 3 ;; sleepy) exec sleep 10 ;; *) cat ;; esac\n`);
chmodSync(hostbin, 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.BOXERY_HOME = home;
const core = await import("../core/boxery-core.mjs");
const P = await import("../core/profile.mjs");
const host = core.resolveHost("test");
const q = (/** @type {string} */ s) => `'${s.replaceAll("'", "'\\''")}'`;
const log = () => readFileSync(calls, "utf8").trim().split("\n");

beforeEach(() => { rmSync(calls, { force: true }); rmSync(path.join(home, "host-pins-keys"), { force: true }); });

test("profileConfig parses what setup writes, and sources anything else as the CLI does", async () => {
	writeFileSync(path.join(home, "config"), `HOST='u@h'\nHOST_BIN=${q("~/it's bin")}\nIDENTITY=/k\n`);
	const c = await P.profileConfig(host);
	assert.deepEqual([c.host, c.hostBin, c.hostProfile, c.identity, c.env], ["u@h", "~/it's bin", "", "/k", process.env]);
	// A computed config is sourced (set -eu, with the CLI's own variables), and its exports reach host commands.
	writeFileSync(path.join(home, "config"), `P=iso\nHOST_PROFILE=$P\nHOST=$(printf local)\nIDENTITY="$CONF_DIR/id"\nexport STUB_ENV="v w"\nPATH="/cfg:$PATH"\n`);
	const d = await P.profileConfig(host);
	assert.deepEqual([d.host, d.hostBin, d.hostProfile, d.identity, d.env.STUB_ENV, d.env.PATH], ["local", "~/.local/bin/boxery-host", "iso", path.join(home, "id"), "v w", `/cfg:${process.env.PATH}`]);
	assert.equal(d.env.P, undefined, "unexported variables stay in the shell");
	for (const bad of ["return 1", "IDENTITY=$NOPE", "false\nHOST=local", "HOST=local\nexit 0"]) {
		writeFileSync(path.join(home, "config"), `${bad}\n`);
		await assert.rejects(P.profileConfig(host), /could not load .*config/, bad);
	}
	// A config may change IFS: loading doesn't depend on it.
	writeFileSync(path.join(home, "config"), "IFS=,\nHOST=local\nexport STUB_ENV=a,b\n");
	const e = await P.profileConfig(host);
	assert.deepEqual([e.host, e.env.STUB_ENV], ["local", "a,b"]);
});

test("hostRun: HOST=local runs boxery-host directly, with --profile, stdin and the config's exports", async () => {
	writeFileSync(path.join(home, "config"), `HOST=local\nHOST_BIN=${q(hostbin)}\nHOST_PROFILE=iso\nexport STUB_ENV=yes\n`); // (sourced: it exports)
	assert.equal(await P.hostRun(["edge-set", "a b"], { input: "stdin-data", host }), "stdin-data");
	assert.deepEqual(log(), ["arg[--profile]", "arg[iso]", "arg[edge-set]", "arg[a b]", "env yes"]);
	await assert.rejects(P.hostRun(["fail"], { host }), (e) => {
		const err = /** @type {any} */ (e);
		return err.message === "it broke" && err.exitCode === 3 && err.fromHost === true && err.reported === false;
	});
	// A command that can't start, and an abort, are told apart from a host failure.
	writeFileSync(path.join(home, "config"), `HOST=local\nHOST_BIN=${q(path.join(dir, "absent"))}\n`);
	const t0 = Date.now();
	await assert.rejects(P.hostRun(["ls"], { host, timeout: 60_000 }), (e) => /** @type {any} */ (e).fromHost === true && /** @type {any} */ (e).exitCode === 127);
	assert.ok(Date.now() - t0 < 5_000, "a command that can't start doesn't wait out the timeout");
	writeFileSync(path.join(home, "config"), `HOST=local\nHOST_BIN=${q(hostbin)}\n`);
	const abort = new AbortController();
	const slow = P.hostRun(["sleepy"], { host, signal: abort.signal, input: "" });
	abort.abort();
	await assert.rejects(slow, (e) => /** @type {Error} */ (e).name === "AbortError" && !(/** @type {any} */ (e).fromHost));
	await assert.rejects(P.hostRun(["sleepy"], { host, timeout: 100 }), (e) => /** @type {any} */ (e).fromHost === true && /signal SIGTERM/.test(/** @type {Error} */ (e).message));
});

test("hostRun: a remote host gets exactly these words, whatever they contain", async () => {
	// The "remote" HOST_BIN is reached through $HOME, like ~/... on a real host.
	mkdirSync(path.join(dir, "rhome"), { recursive: true });
	writeFileSync(path.join(dir, "rhome", "boxery host"), readFileSync(hostbin)); chmodSync(path.join(dir, "rhome", "boxery host"), 0o755);
	writeFileSync(path.join(home, "config"), `HOST='ben@hornet'\nHOST_BIN='~/boxery host'\n`);
	const nasty = ["x; touch pwned #", "$(id)", "it's", "a\nb", "*"];
	const prev = process.env.HOME;
	process.env.HOME = path.join(dir, "rhome"); // the stub ssh runs "remotely" with this HOME
	try { await P.hostRun(["snap", ...nasty], { host }); } finally { process.env.HOME = prev; }
	assert.deepEqual(log().slice(0, 1), ["ssh-dest ben@hornet"]);
	assert.equal(readFileSync(calls, "utf8").split("\n").slice(1).join("\n").trim(), ["snap", ...nasty].map((a) => `arg[${a}]`).join("\n"));
});

test("hostRun refuses an unconfigured or unsafe target before running anything", async () => {
	writeFileSync(path.join(home, "config"), "# nothing\n");
	await assert.rejects(P.hostRun(["ls"], { host }), /host test is not configured; run: boxery setup/);
	writeFileSync(path.join(home, "config"), "HOST='-oProxyCommand=touch x'\n");
	await assert.rejects(P.hostRun(["ls"], { host }), /invalid ssh destination/);
	writeFileSync(path.join(home, "config"), `HOST=local\nHOST_BIN=${q(hostbin)}\nHOST_PROFILE=Bad\n`);
	await assert.rejects(P.hostRun(["ls"], { host }), /invalid host profile/);
	assert.throws(() => readFileSync(calls), /ENOENT/, "nothing ran");
});

test("writeSshConfig asks once whether the host pins keys, then remembers it; closeMaster never fails", async () => {
	writeFileSync(path.join(home, "config"), `HOST=local\nHOST_BIN=${q(hostbin)}\n`);
	await P.writeSshConfig({ host });
	assert.match(readFileSync(path.join(home, "ssh_config"), "utf8"), /^ {2}StrictHostKeyChecking yes$/m);
	assert.deepEqual(log(), ["arg[help]"]);
	rmSync(calls);
	await P.writeSshConfig({ host });
	assert.throws(() => readFileSync(calls), /ENOENT/, "no second probe");
	await P.closeMaster("demo", { host });
	assert.match(log()[0], /^close -F .* -O exit demo\.boxery$/);
});
