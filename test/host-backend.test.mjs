// host/backend.sh + backend.mjs (the only way Node reaches a hypervisor backend), guest.mjs and
// config.mjs, against the fake backend and a stub ssh. No SQLite: runs on every supported Node.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BackendError, createBackend } from "../host/backend.mjs";
import { HOST_ENV, loadConfig } from "../host/config.mjs";
import { createGuest } from "../host/guest.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
let dir, env;
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "boxery-backend-"));
	mkdirSync(path.join(dir, "vms")); mkdirSync(path.join(dir, "conf")); mkdirSync(path.join(dir, "bin"));
	env = { ...process.env, BOXERY_BACKEND: "fake", BOXERY_FAKE_DIR: path.join(dir, "vms"), BOXERY_CONF: path.join(dir, "conf"), PATH: `${path.join(dir, "bin")}:${process.env.PATH}` };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeVm(name, { state = "running", port = 22000, size = "2 2048 10" } = {}) {
	const d = path.join(dir, "vms", name);
	mkdirSync(d, { recursive: true });
	writeFileSync(path.join(d, "state"), state); writeFileSync(path.join(d, "port"), String(port)); writeFileSync(path.join(d, "size"), size);
}
function stub(name, script) {
	writeFileSync(path.join(dir, "bin", name), `#!/usr/bin/env bash\n${script}\n`);
	chmodSync(path.join(dir, "bin", name), 0o755);
}

test("backend.sh and config.mjs read the same host.env keys", () => {
	const sh = readFileSync(path.join(ROOT, "host/backend.sh"), "utf8");
	const keys = sh.match(/case \$k in ([A-Z_ |]+)\)/)[1].split("|").map((k) => k.trim());
	assert.deepEqual(keys, HOST_ENV);
});

test("loadConfig: host.env fills unset or empty settings; explicit values win; other keys are ignored", () => {
	writeFileSync(path.join(dir, "conf", "host.env"), "BOXERY_BACKEND=lima\nBOXERY_PROXY_PORT=9000\nBOXERY_CH_DNS=a=b\nPATH=/evil\nBOXERY_POOL=p\n");
	const c = loadConfig({ BOXERY_CONF: path.join(dir, "conf"), BOXERY_PROXY_PORT: "7000", BOXERY_POOL: "", PATH: "/usr/bin" });
	assert.equal(c.backend, "lima");
	assert.equal(c.proxyPort, "7000");
	assert.equal(c.env.BOXERY_POOL, "p");
	assert.equal(c.env.BOXERY_CH_DNS, "a=b");
	assert.equal(c.env.PATH, "/usr/bin");
	assert.equal(c.proxyUnit, "boxery-proxy");
	assert.equal(c.reaperUnit, "boxery-reaper");
	assert.equal(loadConfig({ BOXERY_CONF: path.join(dir, "none") }).backend, "libvirt");
});

test("only contract functions run, and arguments are never evaluated", async () => {
	const b = createBackend(env);
	for (const fn of ["boxery_seed", "backend_list;id", "fake_disk_copy", "", "__functions;id"]) {
		await assert.rejects(b.call(fn, [], { quiet: true }), BackendError, fn);
	}
	const marker = path.join(dir, "pwned");
	assert.equal(await b.exists(`$(touch ${marker})`), false);
	assert.equal(await b.exists(`x; touch ${marker}`), false);
	assert.equal(existsSync(marker), false);
	await assert.rejects(createBackend({ ...env, BOXERY_BACKEND: "nope" }).call("backend_list", [], { quiet: true }), BackendError);
});

test("metadata is parsed: list, images, endpoints, size, optional functions", async () => {
	const b = createBackend(env);
	assert.deepEqual(await b.list(), []);
	fakeVm("a1"); fakeVm("b2", { state: "shut off", port: 22001, size: "4 8192 40" });
	assert.deepEqual(await b.list(), [
		{ name: "a1", state: "running", addr: "127.0.0.1:22000", disk: "1GiB" },
		{ name: "b2", state: "shut off", addr: "127.0.0.1:22001", disk: "1GiB" },
	]);
	assert.equal(await b.exists("a1"), true);
	assert.equal(await b.exists("zz"), false);
	assert.deepEqual(await b.sshEndpoint("a1"), { host: "127.0.0.1", port: "22000" });
	await assert.rejects(b.sshEndpoint("b2", { quiet: true }), (e) => e instanceof BackendError && e.exitCode === 1 && !e.reported);
	assert.deepEqual(await b.size("b2"), [4, 8192, 40]);
	await b.call("backend_capture", ["a1", "a1@one"]);
	const [img] = await b.images();
	assert.equal(img.image, "a1@one"); assert.equal(img.size, "1MiB");
	assert.equal(await b.imageExists("a1@one"), true);
	assert.equal(await b.imageExists("a1@on"), false);
	assert.equal(await b.has("backend_resize"), true);
	assert.equal(await b.has("backend_legacy_revert"), false);
	assert.equal(await b.guestProxyUpstream(), "TCP:fake-gateway:8088");
});

test("a failing backend call keeps its exit status and says whether it reported the error", async () => {
	const b = createBackend({ ...env, BOXERY_FAKE_FAIL_CAPTURE: "1" });
	fakeVm("a1");
	await assert.rejects(b.call("backend_capture", ["a1", "a1@x"], { quiet: true }), (e) => e.exitCode === 1 && e.message === "backend_capture failed");
});

test("guest: ssh argv, stdin for keys, wait retries, host key creation", async () => {
	const log = path.join(dir, "ssh.log");
	stub("ssh", `printf '%s\\n' "$*" >>"${log}"; [ -n "\${SSH_FAIL:-}" ] && exit 255; case "$*" in *authorized_keys*) cat >"${dir}/keys" ;; esac; exit 0`);
	stub("ssh-keygen", `while [ $# -gt 1 ]; do shift; done; echo "ssh-ed25519 AAAAnew boxery-host" >"$1.pub"; touch "$1"`);
	const conf = path.join(dir, "conf");
	const guest = createGuest({ conf, env });
	assert.equal(guest.hostPubkey(), "ssh-ed25519 AAAAnew boxery-host");
	writeFileSync(path.join(conf, "authorized_keys"), "ssh-ed25519 BBBB laptop\n\nssh-ed25519 AAAAnew boxery-host\n");
	assert.deepEqual(guest.petKeys(), ["ssh-ed25519 AAAAnew boxery-host", "ssh-ed25519 BBBB laptop"]);
	const ep = { host: "10.0.0.5", port: "2222" };
	await guest.setKeys(ep, guest.petKeys());
	assert.equal(readFileSync(path.join(dir, "keys"), "utf8"), "ssh-ed25519 AAAAnew boxery-host\nssh-ed25519 BBBB laptop\n");
	const line = readFileSync(log, "utf8").trim().split("\n").at(-1);
	assert.match(line, /-o IdentityFile=.*mgmt_ed25519 .* -p 2222 agent@10\.0\.0\.5 umask 077;/);
	assert.equal(await guest.run(ep, "echo hi"), 0);
	const failing = createGuest({ conf, env: { ...env, SSH_FAIL: "1" } });
	assert.equal(await failing.run(ep, "true"), 255);
	await assert.rejects(failing.waitSsh(ep, 1), /timed out waiting for ssh on 10\.0\.0\.5:2222/);
	await assert.rejects(failing.setKeys(ep, ["k"]), /could not set ssh keys/);
});
