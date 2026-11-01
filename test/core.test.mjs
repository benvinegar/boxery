// Unit tests for core/boxery-core.mjs pure helpers. Run: node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import * as core from "../core/boxery-core.mjs";

test("vmPath maps relative, ~ and absolute paths into the VM", () => {
	assert.equal(core.vmPath("src/a.ts"), "/home/agent/project/src/a.ts");
	assert.equal(core.vmPath("."), "/home/agent/project");
	assert.equal(core.vmPath(undefined), "/home/agent/project");
	assert.equal(core.vmPath("  "), "/home/agent/project");
	assert.equal(core.vmPath("~"), "/home/agent");
	assert.equal(core.vmPath("~/x/y"), "/home/agent/x/y");
	assert.equal(core.vmPath("/etc/hosts"), "/etc/hosts");
	assert.equal(core.vmPath("/a/b/../c"), "/a/c");
	assert.equal(core.vmPath("../outside"), "/home/agent/outside");
});

test("parseLoc understands local:, NAME: and bare paths", () => {
	assert.deepEqual(core.parseLoc("local:./x", "demo"), { vm: null, path: "./x" });
	assert.deepEqual(core.parseLoc("web:src", "demo"), { vm: "web", path: "/home/agent/project/src" });
	assert.deepEqual(core.parseLoc("notes.md", "demo"), { vm: "demo", path: "/home/agent/project/notes.md" });
	assert.throws(() => core.parseLoc("notes.md", undefined), /no VM prefix/);
	// Invalid VM-name prefixes are treated as part of a bare path, not as a VM.
	assert.deepEqual(core.parseLoc("C:/x", "demo"), { vm: "demo", path: "/home/agent/project/C:/x" });
});

test("assertName enforces the VM name grammar", () => {
	for (const ok of ["a", "demo", "web-2", "a".repeat(31)]) assert.equal(core.assertName(ok), ok);
	for (const bad of ["", "Demo", "1x", "a b", "a;b", "../x", "a".repeat(32), "x.boxery", undefined, null])
		assert.throws(() => core.assertName(bad), /invalid VM name/);
});

test("q quotes safely for bash", async () => {
	const { execFileSync } = await import("node:child_process");
	for (const s of ["plain", "it's", "a b", "$(rm -rf /)", "`x`", "\\n", "'\"'", "", "ünïcødé"]) {
		const out = execFileSync("bash", ["-c", `printf %s ${core.q(s)}`]).toString();
		assert.equal(out, s);
	}
});

test("applyEdits: exact single-match replacement", () => {
	assert.equal(core.applyEdits("a b c", [{ oldText: "b", newText: "B" }]), "a B c");
	assert.equal(
		core.applyEdits("one two three", [
			{ oldText: "three", newText: "3" },
			{ oldText: "one", newText: "1" },
		]),
		"1 two 3",
	);
	assert.equal(core.applyEdits("x", [{ oldText: "x", newText: "" }]), "");
	assert.equal(core.applyEdits("$&", [{ oldText: "$&", newText: "$1" }]), "$1"); // no regex replacement semantics
});

test("applyEdits: rejects missing, ambiguous, empty and overlapping edits", () => {
	assert.throws(() => core.applyEdits("abc", [{ oldText: "z", newText: "" }]), /not found/);
	assert.throws(() => core.applyEdits("aa", [{ oldText: "a", newText: "" }]), /more than once/);
	assert.throws(() => core.applyEdits("abc", [{ oldText: "", newText: "x" }]), /empty/);
	assert.throws(
		() =>
			core.applyEdits("abcdef", [
				{ oldText: "abcd", newText: "" },
				{ oldText: "cdef", newText: "" },
			]),
		/overlap/,
	);
});

test("truncHead keeps the beginning within line and byte limits", () => {
	const t = core.truncHead("a\nb\nc\nd", 2);
	assert.deepEqual([t.text, t.truncated, t.shownLines, t.totalLines], ["a\nb", true, 2, 4]);
	assert.equal(core.truncHead("x".repeat(10), 100, 5).truncated, true);
	assert.equal(core.truncHead("short").truncated, false);
});

test("truncTail keeps the end (command output)", () => {
	const t = core.truncTail("1\n2\n3\n4", 2);
	assert.deepEqual([t.text, t.truncated], ["3\n4", true]);
	assert.equal(core.truncTail("ok").text, "ok");
});

test("guidance mentions the current VM and the local/VM split", () => {
	const g = core.guidance("demo");
	assert.match(g, /"demo"/);
	assert.match(g, /vm_bash/);
	assert.match(g, /LOCAL machine/);
	assert.match(core.guidance(null), /vm_manage/);
});

test("formatVms / formatGrants render the --json shapes", () => {
	const vms = [
		{ name: "a1", state: "running", addr: "10.0.0.2", disk: "1GiB", lease: null, shape: "large", cpus: 8, mem: 16384, desktop: false, grants: [] },
		{ name: "pool-1", state: "running", addr: null, disk: null, lease: { state: "LEASED", holder: "me@x", expires_at: 1 }, grants: [{ kind: "ssh-agent" }, { kind: "file", local: "/l/.env", remote: "/home/agent/project/.env" }] },
	];
	const lines = core.formatVms(vms).split("\n");
	assert.match(lines[0], /^NAME +STATE +ADDR +SHAPE +KIND +LEASE +GRANTS$/);
	assert.match(lines[1], /^a1 +running +10\.0\.0\.2 +large +headless +- +-$/);
	assert.match(lines[2], /^pool-1 +running +- +- +desktop +LEASED +ssh-agent,file:\/home\/agent\/project\/\.env$/, "VMs without a recorded shape show -; without desktop: a desktop (older hosts)");
	assert.equal(core.formatVms([]), "(no VMs)");
	const exe = [
		{ name: "e1", state: "running", addr: null, tunnel: "connecting", grants: [] },
		{ name: "e2", state: "paused", addr: null, tunnel: "down", grants: [] },
		{ name: "e3", state: "running", addr: "127.0.0.1:22401", tunnel: "up", grants: [] },
	];
	const el = core.formatVms(exe).split("\n");
	assert.match(el[1], /^e1 +running +tunnel connecting /, "a running exe.dev VM without its tunnel says so");
	assert.match(el[2], /^e2 +paused +- /, "a stopped VM's tunnel is down by design");
	assert.match(el[3], /^e3 +running +127\.0\.0\.1:22401 /);
	assert.equal(core.formatGrants("a1", []), "no grants for a1");
	assert.match(core.formatGrants("a1", [{ kind: "env", var: "T", cmd: "op read x" }]), /env:T +\(from: op read x\)/);
});

test("formatShapes / assertShape", () => {
	const lines = core.formatShapes({ default: "standard", shapes: { small: { cpus: 2, mem: 4096, disk: 20 }, standard: { cpus: 4, mem: 8192, disk: 40 } } }).split("\n");
	assert.match(lines[0], /^SHAPE +CPUS +MEM +DISK$/);
	assert.match(lines[1], /^small +2 +4 GiB +20 GiB$/);
	assert.match(lines[2], /^standard \(default\) +4 +8 GiB +40 GiB$/);
	assert.equal(core.assertShape("gpu-ish"), "gpu-ish");
	for (const bad of ["", "Large", "x;id", "-a", "a".repeat(32), 4]) assert.throws(() => core.assertShape(bad), /invalid shape/);
});
