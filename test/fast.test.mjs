import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, SETTINGS } from "../host/config.mjs";
import { writeSeed } from "../host/seed.mjs";
import { parseNewArgs } from "../host/vms.mjs";
import { resources } from "../host/boxery-operations.mjs";

test("CH fast-path defaults are opt-in and pinned for crash recovery", () => {
	const c = loadConfig({ BOXERY_CONF: path.join(tmpdir(), "boxery-no-such-conf"), BOXERY_BACKEND: "cloud-hypervisor" });
	assert.equal(c.env.BOXERY_CH_FAST, "0");
	assert.equal(c.env.BOXERY_CH_NET_MODE, "tap");
	assert.equal(c.env.BOXERY_CH_RESTORE_MODE, "copy");
	for (const key of ["BOXERY_CH_FAST", "BOXERY_CH_TEMPLATES", "BOXERY_CH_NET_MODE", "BOXERY_CH_PORT_BASE", "BOXERY_CH_RESTORE_MODE"]) {
		assert.ok(SETTINGS.includes(key), `${key} must be journaled`);
		assert.ok(c.env[key], `${key} must have a concrete default`);
	}
	assert.equal(loadConfig({ BOXERY_CONF: c.conf, BOXERY_BACKEND: "libvirt" }).env.BOXERY_CH_FAST, undefined);
});

test("restore identity sidecar contains only structured, bounded credential paths", async (t) => {
	const conf = mkdtempSync(path.join(tmpdir(), "boxery-fast-seed-"));
	t.after(() => rmSync(conf, { recursive: true, force: true }));
	t.mock.method(globalThis, "fetch", async () => { throw new Error("no local Ollama"); });
	let secret;
	const keys = ["ssh-ed25519 AAAAfixture management"];
	const file = await writeSeed({ conf, operationId: "test", setToken: (_name, value) => { secret = value; },
		guest: { petKeys: () => keys }, vms: { guestProxyUpstream: async () => "VSOCK-CONNECT:2:8189" } }, "test-vm", "", "headless");
	const identity = JSON.parse(readFileSync(`${file}.json`, "utf8"));
	assert.deepEqual(Object.keys(identity), ["version", "name", "kind", "keys", "upstream", "files"]);
	assert.equal(identity.version, 1);
	assert.equal(identity.name, "test-vm");
	assert.equal(identity.kind, "headless");
	assert.deepEqual(identity.keys, keys);
	assert.equal(identity.upstream, "VSOCK-CONNECT:2:8189");
	assert.deepEqual(identity.files.map(([name]) => name).sort(), [".boxery/token", ".config/opencode/opencode.json", ".pi/agent/models.json", ".pi/agent/settings.json"]);
	assert.equal(identity.files.find(([name]) => name === ".boxery/token")[1], `test-vm:${secret}`);
	assert.equal(statSync(`${file}.json`).mode & 0o777, 0o600);
	assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
	assert.match(readFileSync(file, "utf8"), /^#cloud-config/);
});

test("explicit cold boot parses without changing lifecycle lock resources", () => {
	assert.equal(parseNewArgs(["test", "--cold", "--headless"]).cold, true);
	assert.equal(parseNewArgs(["test"]).cold, false);
	assert.deepEqual(resources("new", ["test", "--cold", "--from", "source@image"]), ["source", "test"]);
});

const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
test("fast runtime/guest protocol boundaries (Python, no hypervisor privileges)", { skip: python.error?.code === "ENOENT" }, () => {
	const result = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "test/fast", "-p", "test_*.py", "-v"], {
		cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000,
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
