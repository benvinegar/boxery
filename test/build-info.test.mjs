// Build records and staleness (host/build-info.mjs): the rules `ls`, `snaps` and `images` apply, and the
// layers hash the host computes against the one the guest writes (image/layers/lib.sh). The guest side
// runs under bash here, with stubs for what only a VM has.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ageDays, guestChecker, layersHash, parseBuildInfo } from "../host/build-info.mjs";
import { resources } from "../host/boxery-operations.mjs";
import { parsePatchArgs } from "../host/patch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAYERS = path.join(ROOT, "image", "layers");
const dir = mkdtempSync(path.join(tmpdir(), "boxery-build-info-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// The guest's shell functions, with stubs on PATH: sha256sum where the system has none (macOS),
// google-chrome for a desktop's browser version.
const bin = path.join(dir, "bin");
execFileSync("mkdir", ["-p", bin]);
const stub = (name, script) => { writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${script}\n`); chmodSync(path.join(bin, name), 0o755); };
stub("google-chrome", 'echo "Chromium 140.0.7339.16"');
try { execFileSync("sh", ["-c", "command -v sha256sum"], { stdio: "ignore" }); } catch { stub("sha256sum", 'exec shasum -a 256 "$@"'); }
const guest = (/** @type {string} */ fn, /** @type {string[]} */ args) => execFileSync("bash", ["-c", `. "${LAYERS}/lib.sh"; ${fn} "$@"`, "guest", ...args],
	{ encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

const NOW = Date.parse("2026-11-02T12:00:00Z");
const check = guestChecker({ root: ROOT, env: {} }, NOW);
const fresh = (/** @type {object} */ over = {}) => ({ built_at: "2026-10-30T08:00:00Z", layers: ["plumbing", "devtools"], layers_hash: layersHash(ROOT, ["plumbing", "devtools"]),
	kernel: "6.8.0-90-generic", chrome: null, playwright_core: null, reboot_required: false, checked_at: "2026-11-02T11:00:00Z", ...over });

test("the host's layers hash is the one the guest writes (lib.sh layers_hash), per set of layers", () => {
	const provision = path.join(LAYERS, "provision.sh");
	for (const layers of [["plumbing", "devtools"], ["plumbing", "devtools", "desktop"], ["plumbing", "devtools", "github-runner"]]) {
		assert.equal(guest("layers_hash", [LAYERS, provision, ...layers]).trim(), layersHash(ROOT, layers), layers.join(" "));
	}
	assert.notEqual(layersHash(ROOT, ["plumbing", "devtools"]), layersHash(ROOT, ["plumbing", "devtools", "desktop"]));
	assert.notEqual(layersHash(ROOT, ["plumbing", "devtools"]), layersHash(ROOT, ["plumbing", "devtools", "github-runner"]), "a runner VM's hash covers the runner layer");
	assert.equal(layersHash(ROOT, ["desktop", "plumbing", "devtools"]), layersHash(ROOT, ["plumbing", "devtools", "desktop"]), "in layer order, whatever the record's order");
});

test("build_info writes what the host parses; the desktop's browser only with the desktop layer", () => {
	const provision = path.join(LAYERS, "provision.sh");
	const headless = parseBuildInfo(guest("build_info", [LAYERS, provision, "plumbing", "devtools"]));
	assert.match(/** @type {string} */ (headless.built_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
	assert.deepEqual(headless.layers, ["plumbing", "devtools"]);
	assert.equal(headless.layers_hash, layersHash(ROOT, ["plumbing", "devtools"]));
	assert.ok(headless.kernel, "a kernel version (the newest installed, else the running one)");
	assert.equal(headless.chrome, null);
	assert.equal(check(headless).status, "current", "a VM just built from this host's layers is current");
	const desktop = parseBuildInfo(guest("build_info", [LAYERS, provision, "plumbing", "devtools", "desktop"]));
	assert.equal(desktop.chrome, "Chromium 140.0.7339.16");
	assert.equal(desktop.layers_hash, layersHash(ROOT, ["plumbing", "devtools", "desktop"]));
});

test("parseBuildInfo: key=value lines, the reboot flag, and guests without build-info", () => {
	const rec = parseBuildInfo("built_at=2026-10-01T00:00:00Z\nlayers=plumbing devtools\nkernel=6.8.0-1\nnoise\nreboot_required=1\n", new Date(NOW));
	assert.equal(rec.built_at, "2026-10-01T00:00:00Z");
	assert.deepEqual(rec.layers, ["plumbing", "devtools"]);
	assert.equal(rec.reboot_required, true);
	assert.equal(rec.checked_at, "2026-11-02T12:00:00Z");
	const none = parseBuildInfo("");
	assert.equal(none.built_at, null);
	assert.equal(none.reboot_required, false);
});

test("staleness: current, layers changed, too old, reboot required, unknown", () => {
	assert.deepEqual([check(fresh()).status, check(fresh()).reasons, check(fresh()).age_days], ["current", [], 3]);
	assert.deepEqual([check(fresh()).built_at, check(fresh()).checked_at], [Date.parse("2026-10-30T08:00:00Z") / 1000, Date.parse("2026-11-02T11:00:00Z") / 1000], "times in epoch seconds, like the other JSON");
	assert.deepEqual(check(fresh({ layers_hash: "0".repeat(64) })).reasons, ["layers changed"]);
	assert.deepEqual(check(fresh({ built_at: "2026-09-01T00:00:00Z" })).reasons, ["built 62 days ago"], "older than 30 days by default");
	assert.equal(guestChecker({ root: ROOT, env: { BOXERY_STALE_DAYS: "90" } }, NOW)(fresh({ built_at: "2026-09-01T00:00:00Z" })).status, "current", "BOXERY_STALE_DAYS");
	const all = check(fresh({ layers_hash: "x", built_at: "2026-01-01T00:00:00Z", reboot_required: true }));
	assert.deepEqual([all.status, all.reasons], ["outdated", ["layers changed", "built 305 days ago", "reboot required"]]);
	assert.deepEqual([check(null).status, check(null).reasons, check(null).checked_at], ["unknown", ["not checked"], null], "never read: unknown, not an error");
	const old = check(parseBuildInfo("reboot_required=1\n"));
	assert.deepEqual([old.status, old.reasons], ["unknown", ["no build record", "reboot required"]], "a guest from before build-info");
	const img = check(fresh({ reboot_required: true }), { image: true });
	assert.deepEqual([img.status, img.reboot_required], ["current", null], "an image boots fresh: its reboot flag doesn't count");
});

test("ageDays reads backend timestamps and ignores what it can't parse", () => {
	assert.equal(ageDays("2026-10-31T12:00:00Z", NOW), 2);
	assert.equal(ageDays("", NOW), null);
	assert.equal(ageDays("yesterday", NOW), null);
	assert.equal(ageDays("2027-01-01T00:00:00Z", NOW), 0, "clock skew is not a negative age");
});

test("patch arguments, and the lock a patch holds", () => {
	assert.deepEqual(parsePatchArgs(["a1"]), { name: "a1", all: false, wait: 0 });
	assert.deepEqual(parsePatchArgs(["--all", "--wait", "60"]), { name: "", all: true, wait: 60 });
	assert.deepEqual(parsePatchArgs(["--wait", "5", "p1"]), { name: "p1", all: false, wait: 5 });
	for (const bad of [[], ["a1", "--all"], ["a1", "b1"], ["--wait", "x", "a1"], ["--bogus"], ["A1"]]) assert.throws(() => parsePatchArgs(bad), bad.join(" "));
	assert.deepEqual(resources("patch", ["--wait", "5", "p1"]), ["p1"]);
	assert.deepEqual(resources("patch", ["p1", "--wait", "5"]), ["p1"]);
});
