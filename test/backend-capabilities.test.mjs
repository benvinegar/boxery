import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BACKENDS, backendMetadata, capabilityStatus, matchesPlatform, metadataTable, normalizePlatform, platformStatus } from "../core/backend-metadata.mjs";
import { assessBackend, checkBackend, checkOperation } from "../host/capabilities.mjs";

const config = (os, arch, runtime) => ({ host: { os, arch }, runtime });

test("every public backend has a complete, consistent declaration", () => {
	const files = readdirSync(new URL("../host/backends/", import.meta.url)).filter((f) => f.endsWith(".sh") && f !== "fake.sh").map((f) => f.slice(0, -3)).sort();
	assert.deepEqual(Object.keys(BACKENDS).sort(), files);
	for (const [id, m] of Object.entries(BACKENDS)) {
		assert.equal(m.id, id);
		assert.ok(["stable", "experimental"].includes(m.stability));
		assert.ok(m.supported.length);
		assert.equal(new Set(m.requirements.map((r) => r.id)).size, m.requirements.length);
		for (const t of m.tested) assert.equal(platformStatus(m, t).supported, true, `${id}: tested configuration must be supported`);
		for (const feature of ["desktop", "headless", "diskSnapshots", "fork", "restore", "resize", "pools", "leases", "guestSudo", "grants"]) {
			const c = m.capabilities[feature];
			assert.ok(c, `${id}: ${feature}`);
			assert.ok(["supported", "conditional", "unsupported"].includes(c.status));
			assert.equal(c.status === "conditional", c.requires.length > 0);
			for (const req of c.requires) assert.ok(m.requirements.some((r) => r.id === req));
		}
	}
	assert.throws(() => backendMetadata("__proto__"), /No metadata/);
});

test("platform matching normalizes uname aliases but never guesses unknown architectures", () => {
	assert.deepEqual(normalizePlatform({ os: "Darwin", arch: "aarch64" }), { os: "darwin", arch: "arm64" });
	assert.ok(matchesPlatform({ os: "linux", arch: "x64" }, { os: "Linux", arch: "x86_64" }));
	assert.ok(matchesPlatform({ os: "darwin", arch: "*" }, { os: "darwin", arch: "arm64" }));
	assert.equal(matchesPlatform({ os: "linux", arch: "x64" }, { os: "linux", arch: "riscv64" }), false);
});

test("supported and tested are distinct, including runtime combinations", () => {
	assert.deepEqual(platformStatus(BACKENDS["cloud-hypervisor"], config("linux", "x64", "kvm")), { supported: true, tested: false });
	assert.deepEqual(platformStatus(BACKENDS["cloud-hypervisor"], config("linux", "aarch64", "kvm")), { supported: true, tested: true });
	assert.deepEqual(platformStatus(BACKENDS.lima, config("darwin", "arm64", "vz")), { supported: true, tested: true });
	assert.deepEqual(platformStatus(BACKENDS.lima, config("darwin", "arm64", "qemu")), { supported: true, tested: false });
	assert.equal(platformStatus(BACKENDS.lima, config("linux", "x64", "vz")).supported, false);
	assert.equal(platformStatus(BACKENDS.libvirt, config("linux", "arm64", "kvm")).supported, false, "adapter downloads amd64, regardless of upstream libvirt support");
	assert.equal(platformStatus(BACKENDS.libvirt, config("darwin", "arm64", "kvm")).supported, false);
});

test("OpenShell upstream support is not Boxery validation or unrestricted guest capabilities", () => {
	assert.deepEqual(platformStatus(BACKENDS.openshell, config("darwin", "arm64", "docker")), { supported: true, tested: false });
	assert.deepEqual(platformStatus(BACKENDS.openshell, config("linux", "x64", "docker")), { supported: true, tested: true });
	assert.deepEqual(platformStatus(BACKENDS.openshell, config("linux", "x64", "gateway")), { supported: true, tested: false }, "unknown gateway driver must not imply Docker validation");
	for (const feature of ["desktop", "diskSnapshots", "fork", "restore", "resize", "pools", "leases", "guestSudo", "grants"]) {
		assert.equal(capabilityStatus(BACKENDS.openshell.capabilities[feature]).availability, "unavailable");
	}
	assert.equal(capabilityStatus(BACKENDS.openshell.capabilities.headless).availability, "available");
	const report = assessBackend("openshell", { env: { PATH: "", BOXERY_NODE: process.execPath } });
	assert.equal(report.requirements.find((r) => r.id === "node")?.status, "met", "pinned host Node needs no PATH entry");
});

test("paid snapshot access is conditional, never inferred from an API key", () => {
	const c = BACKENDS.boat.capabilities.diskSnapshots, req = c.requires[0];
	assert.equal(capabilityStatus(c).availability, "unknown");
	assert.deepEqual(capabilityStatus(c).unknown, [req]);
	assert.equal(capabilityStatus(c, { [req]: true }).availability, "available");
	assert.equal(capabilityStatus(c, { [req]: false }).availability, "unavailable");
	assert.equal(capabilityStatus(BACKENDS.boat.capabilities.headless).availability, "unavailable");
	assert.equal(capabilityStatus(BACKENDS.exe.capabilities.headless).availability, "available");
	const report = assessBackend("boat", { env: { BOAT_API_KEY: "not-an-entitlement" }, configuration: config("darwin", "arm64", "boat.dev"), probeRequirement: () => true });
	// Injected tool probes above are only test facts; real manual probes always return unknown.
	const real = assessBackend("boat", { env: { PATH: "", BOAT_API_KEY: "not-an-entitlement" }, configuration: report.configuration });
	assert.equal(real.capabilities.diskSnapshots.availability, "unknown");
	assert.equal(real.requirements.find((r) => r.id === "launchctl")?.status, "missing");
	assert.equal(real.requirements.find((r) => r.id === "systemctl")?.status, "not-applicable");
});

test("the controller does not constrain a remote host or the provider compute", () => {
	const linuxHost = assessBackend("libvirt", { configuration: config("linux", "x64", "kvm"), probeRequirement: () => true });
	assert.equal(linuxHost.platform.supported, true); // controller platform is deliberately not an input
	const macHost = assessBackend("exe", { configuration: config("darwin", "arm64", "exe.dev"), probeRequirement: () => true });
	assert.equal(macHost.platform.supported, true);
	assert.equal(macHost.backend.runtime.location, "remote");
});

test("preflight refuses unsupported platforms before probing and explains missing requirements", () => {
	assert.throws(() => checkBackend("libvirt", { configuration: config("darwin", "arm64", "kvm"), probeRequirement: () => { throw new Error("must not probe"); } }), /remote host is fine; the controller OS does not constrain it/);
	assert.throws(() => checkBackend("libvirt", { configuration: config("linux", "x64", "kvm"), probeRequirement: () => false }), /virsh: Install virsh.*[\s\S]*\/dev\/kvm/);
	assert.doesNotThrow(() => checkBackend("lima", { configuration: config("darwin", "x64", "qemu"), probeRequirement: () => true }), "untested is a warning, not unsupported");
	assert.throws(() => checkOperation("boat", "new", ["ci", "--headless"]), /no headless creation/);
	assert.doesNotThrow(() => checkOperation("boat", "snap", ["vm"]), "unknown entitlements remain provider-verified");
});

test("documentation table cannot drift from declarations", () => {
	const doc = readFileSync(new URL("../docs/backends.md", import.meta.url), "utf8");
	assert.equal(doc.split("<!-- backend-metadata:start -->\n")[1].split("\n<!-- backend-metadata:end -->")[0], metadataTable());
});

test("host CLI discovery is read-only and unsupported operations fail before side effects", () => {
	const home = mkdtempSync(path.join(tmpdir(), "boxery-capabilities-"));
	try {
		const env = { ...process.env, HOME: home, BOXERY_CONF: path.join(home, "conf"), BOXERY_BACKEND: "boat" };
		const cli = (...args) => spawnSync(process.execPath, [path.resolve("host/boxery-host.mjs"), ...args], { env, encoding: "utf8" });
		const catalog = cli("backends", "--json");
		assert.equal(catalog.status, 0, catalog.stderr);
		assert.deepEqual(JSON.parse(catalog.stdout).backends, Object.values(BACKENDS));
		const report = cli("capabilities", "--json");
		assert.equal(report.status, 0, report.stderr);
		const data = JSON.parse(report.stdout);
		assert.equal(data.backend.id, "boat");
		assert.equal(data.capabilities.diskSnapshots.availability, "unknown");
		assert.equal(data.capabilities.headless.availability, "unavailable");
		const denied = cli("new", "ci", "--headless");
		assert.equal(denied.status, 1);
		assert.match(denied.stderr, /boat: headless is unavailable/);
		assert.equal(existsSync(env.BOXERY_CONF), false, "no config, journal, locks, keys or services written");
		const setup = spawnSync(process.execPath, [path.resolve("host/boxery-host.mjs"), "init", "--backend", "libvirt"], {
			env: { ...env, PATH: "" }, encoding: "utf8",
		});
		assert.equal(setup.status, 1);
		assert.match(setup.stderr, /requirements not met|does not support boxery-host/);
		assert.equal(existsSync(env.BOXERY_CONF), false, "failed setup preflight must not create a profile");
	} finally { rmSync(home, { recursive: true, force: true }); }
});
