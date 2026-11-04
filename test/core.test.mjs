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
	assert.match(g, /this machine, not a VM/);
	assert.match(core.guidance(null), /vm_manage/);
});

test("vmsAreRemote: an ssh host or a cloud backend is remote; VMs on this machine aren't", () => {
	assert.equal(core.vmsAreRemote("ben@box", "libvirt"), true);
	assert.equal(core.vmsAreRemote("local", "exe"), true);
	assert.equal(core.vmsAreRemote("local", "boat"), true);
	assert.equal(core.vmsAreRemote("local", "lima"), false);
	assert.equal(core.vmsAreRemote("local", "cloud-hypervisor"), false);
	assert.equal(core.vmsAreRemote(null, "lima"), null);
	assert.equal(core.vmsAreRemote("local", null), null);
});

test("formatVms / formatGrants render the --json shapes", () => {
	const vms = [
		{ name: "a1", state: "running", ssh_addr: "10.0.0.2:22", disk_size: 40, disk_used: 1.04, lease: null, shape: "large", cpus: 8, mem: 16384, desktop: false, grants: [], guest: { status: "current", reasons: [] } },
		{ name: "pool-1", state: "running", ssh_addr: null, disk_size: null, disk_used: null, lease: { state: "leased", holder: "me@x", expires_at: 1 }, grants: [{ kind: "ssh-agent" }, { kind: "file", local: "/l/.env", remote: "/home/agent/project/.env" }] },
		{ name: "x1", state: "running", ssh_addr: "127.0.0.1:22401", disk_size: 20, disk_used: null, tunnel: "up", lease: null, shape: "custom", desktop: true, grants: [] },
	];
	const lines = core.formatVms(vms).split("\n");
	assert.match(lines[0], /^NAME +STATE +SSH +DISK +SHAPE +KIND +LEASE +GUEST +GRANTS$/);
	assert.match(lines[1], /^a1 +running +10\.0\.0\.2:22 +1\.0\/40GiB +large +headless +- +current +-$/, "DISK is used/size in GiB");
	assert.match(lines[2], /^pool-1 +running +- +- +- +desktop +leased +- +ssh-agent,file:\/home\/agent\/project\/\.env$/, "VMs without a recorded shape show -; without desktop: a desktop (older hosts); without guest: -");
	assert.equal(lines.length, 4, "no note when nothing is outdated");
	assert.match(lines[3], /^x1 +running +127\.0\.0\.1:22401 +20GiB +custom /, "only the size when usage is unknown");
	assert.equal(core.formatVms([]), "(no VMs)");
	const old = core.formatVms([{ name: "o1", state: "running", addr: "10.0.0.3", lease: { state: "FREE" }, grants: [] }]).split("\n");
	assert.match(old[1], /^o1 +running +10\.0\.0\.3 +- +- +desktop +free +-$/, "hosts from before ssh_addr, lowercase lease states and build records");
	const stale = core.formatVms([{ name: "s1", state: "running", guest: { status: "outdated", reasons: ["layers changed", "reboot required"] } }]).split("\n");
	assert.match(stale[1], /^s1 +running +.* outdated +-$/);
	assert.equal(stale[2], "outdated guest software: s1 (layers changed, reboot required). Tell the user; they can update it with: boxery patch NAME");
	assert.equal(core.formatSnaps("s1", [{ name: "one", created: "2026-10-01T10:00:00", size: "1MiB", age_days: 32, guest: { status: "outdated" } }, { name: "old", created: "x", age_days: null }]),
		"one\t2026-10-01T10:00:00\t1MiB\t32d\toutdated\nold\tx\t-\t-\t-");
	assert.equal(core.formatSnaps("s1", [{ name: "pre", created: "x", size: "1MiB" }]), "pre\tx\t1MiB", "hosts from before build records");
	const exe = [
		{ name: "e1", state: "running", ssh_addr: null, tunnel: "connecting", grants: [] },
		{ name: "e2", state: "paused", ssh_addr: null, tunnel: "down", grants: [] },
		{ name: "e3", state: "running", ssh_addr: "127.0.0.1:22401", tunnel: "up", grants: [] },
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
