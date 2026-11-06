// Corrupt registry metadata must never route to a host or be silently repaired.
// All paths, controller configs and executables are isolated temporary fixtures.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const CLI = path.resolve(import.meta.dirname, "../controller/boxery");
const CORE = new URL("../core/boxery-core.mjs", import.meta.url).href;
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

function fixture() {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-metadata-"));
	const home = path.join(dir, "registry");
	const profile = path.join(home, "profiles/alpha");
	const pointer = path.join(home, "host-registry/alpha");
	const selected = path.join(home, "default-host");
	const log = path.join(dir, "host-invocations");
	const host = path.join(dir, "fake-host");
	mkdirSync(profile, { recursive: true });
	mkdirSync(path.dirname(pointer));
	writeFileSync(host, `#!/bin/sh\nprintf 'invoked\\n' >> ${quote(log)}\nprintf 'demo running\\n'\n`);
	chmodSync(host, 0o755);
	for (const d of [home, profile]) {
		writeFileSync(path.join(d, "config"), `HOST=local\nHOST_BIN=${quote(host)}\n`);
		writeFileSync(path.join(d, "ssh_config"), "# fake\n");
	}
	writeFileSync(pointer, `${profile}\n`);
	const env = { ...process.env, HOME: path.join(dir, "home"), BOXERY_HOME: home };
	const run = (bin, args) => {
		const r = spawnSync(bin, args, { env, encoding: "utf8", timeout: 3000 });
		assert.ifError(r.error); // A blocked read (e.g. FIFO) is not a successful rejection.
		return r;
	};
	const cli = (args) => run(CLI, args);
	const core = (host) => run(process.execPath, ["--input-type=module", "-e", `import * as c from ${JSON.stringify(CORE)}; await c.withHost(c.resolveHost(${JSON.stringify(host)}), () => c.listVms());`]);
	return { dir, home, profile, pointer, selected, log, cli, core, run, close: () => rmSync(dir, { recursive: true, force: true }) };
}

function snapshot(file) {
	const stat = lstatSync(file);
	if (stat.isSymbolicLink()) return ["symlink", readlinkSync(file)];
	if (stat.isDirectory()) return ["directory", readdirSync(file).sort(), readFileSync(path.join(file, "keep"))];
	if (stat.isFIFO()) return ["FIFO", stat.mode];
	let bytes;
	try { bytes = readFileSync(file); } catch (e) { if (e.code !== "EACCES") throw e; bytes = "unreadable"; }
	return ["file", stat.mode, bytes];
}

function rejected(f, file, operations) {
	const before = snapshot(file);
	for (const [label, operation] of operations) {
		const result = operation();
		assert.notEqual(result.status, 0, `${label} accepted malformed metadata: ${result.stdout} ${result.stderr}`);
		assert.match(result.stderr, /host|profile|registry/i, `${label} should explain the failure`);
		assert.deepEqual(snapshot(file), before, `${label} modified unexpected metadata`);
		assert.equal(existsSync(f.log), false, `${label} invoked a host`);
	}
}

test("CLI/core reject non-regular, symlink and unreadable defaults without routing or repairing them", () => {
	const f = fixture();
	try {
		// A missing default selects no host: nothing is routed anywhere.
		const none = f.cli(["ls"]);
		assert.notEqual(none.status, 0);
		assert.match(none.stderr, /no host configured/);
		assert.match(f.core().stderr, /no boxery host configured/);
		assert.equal(existsSync(f.log), false);
		const target = path.join(f.dir, "symlink-target");
		writeFileSync(target, "alpha\n");
		/** @type {[string, () => void][]} */
		const cases = [
			["directory", () => { mkdirSync(f.selected); writeFileSync(path.join(f.selected, "keep"), "do not delete\n"); }],
			["FIFO", () => { const r = spawnSync("mkfifo", [f.selected]); assert.ifError(r.error); assert.equal(r.status, 0); }],
			["dangling symlink", () => symlinkSync(path.join(f.dir, "missing"), f.selected)],
			["symlink to regular file", () => symlinkSync(target, f.selected)],
		];
		// chmod cannot make a file unreadable to root; exercise actual access denial on normal users.
		if (process.getuid?.() !== 0) cases.push(["unreadable file", () => { writeFileSync(f.selected, "alpha\n"); chmodSync(f.selected, 0); }]);
		for (const [label, arrange] of cases) {
			arrange();
			rejected(f, f.selected, [
				[`${label}: CLI routing`, () => f.cli(["ls"])],
				[`${label}: core routing`, () => f.core()],
				[`${label}: host ls`, () => f.cli(["host", "ls"])],
				[`${label}: host rm`, () => f.cli(["host", "rm", "alpha"])],
				[`${label}: host use`, () => f.cli(["host", "use", "alpha"])],
			]);
			assert.equal(readFileSync(f.pointer, "utf8"), `${f.profile}\n`);
			assert.equal(readFileSync(target, "utf8"), "alpha\n");
			if (label === "unreadable file") { chmodSync(f.selected, 0o600); assert.equal(readFileSync(f.selected, "utf8"), "alpha\n"); }
			rmSync(f.selected, { recursive: true });
		}
	} finally { f.close(); }
});

test("CLI/core reject NUL bytes and noncanonical lines in default aliases and profile pointers", () => {
	const f = fixture();
	try {
		for (const bytes of [Buffer.from("alpha\0unknown\n"), Buffer.from("alpha"), Buffer.from("alpha\nunknown\n"), Buffer.from("alpha\n\n")]) {
			writeFileSync(f.selected, bytes);
			rejected(f, f.selected, [
				["default CLI", () => f.cli(["ls"])],
				["default core", () => f.core()],
				["default host ls", () => f.cli(["host", "ls"])],
				["default host rm", () => f.cli(["host", "rm", "alpha"])],
				["default host use", () => f.cli(["host", "use", "alpha"])],
			]);
		}
		rmSync(f.selected);
		for (const suffix of ["\0unknown\n", "", "\nunknown\n", "\n\n"]) {
			writeFileSync(f.pointer, Buffer.from(f.profile + suffix));
			rejected(f, f.pointer, [
				["pointer CLI", () => f.cli(["--host", "alpha", "ls"])],
				["pointer core", () => f.core("alpha")],
				["pointer host ls", () => f.cli(["host", "ls"])],
				["pointer host use", () => f.cli(["host", "use", "alpha"])],
			]);
		}
	} finally { f.close(); }
});

test("host add never replaces a dangling registration or managed-profile link", () => {
	const f = fixture();
	try {
		rmSync(f.pointer);
		symlinkSync(path.join(f.dir, "missing-pointer"), f.pointer);
		rejected(f, f.pointer, [
			["import over dangling registration", () => f.cli(["host", "add", "alpha", "--config-dir", f.profile])],
			["provision over dangling registration", () => f.cli(["host", "add", "alpha", "local"])],
		]);
		const danglingProfile = path.join(f.home, "profiles/future");
		symlinkSync(path.join(f.dir, "missing-profile"), danglingProfile);
		rejected(f, danglingProfile, [
			["provision over dangling profile", () => f.cli(["host", "add", "future", "local"])],
		]);
		assert.equal(existsSync(path.join(f.home, "host-registry/future")), false);
	} finally { f.close(); }
});

test("core reads metadata through one no-follow descriptor across pathname replacement races", () => {
	const f = fixture();
	try {
		const beta = path.join(f.home, "profiles/beta");
		mkdirSync(beta);
		for (const file of ["config", "ssh_config"]) writeFileSync(path.join(beta, file), readFileSync(path.join(f.profile, file)));
		writeFileSync(path.join(f.home, "host-registry/beta"), `${beta}\n`);
		const target = path.join(f.dir, "beta-default");
		writeFileSync(target, "beta\n");
		for (const phase of ["after-lstat", "before-open-symlink", "before-open-fifo"]) {
			rmSync(f.selected, { force: true });
			writeFileSync(f.selected, "alpha\n");
			const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
const selected = ${JSON.stringify(f.selected)};
const target = ${JSON.stringify(target)};
const phase = ${JSON.stringify(phase)};
let armed = true;
const replace = () => {
 armed = false;
 fs.unlinkSync(selected);
 if (phase === 'before-open-fifo') {
  const made = spawnSync('mkfifo', [selected]);
  assert.ifError(made.error); assert.equal(made.status, 0);
 } else fs.symlinkSync(target, selected);
};
const lstat = fs.lstatSync;
fs.lstatSync = function(file, ...args) {
 const stat = lstat.call(this, file, ...args);
 if (phase === 'after-lstat' && file === selected && armed) replace();
 return stat;
};
const open = fs.openSync;
fs.openSync = function(file, ...args) {
 if (phase !== 'after-lstat' && file === selected && armed) replace();
 return open.call(this, file, ...args);
};
syncBuiltinESMExports();
const core = await import(${JSON.stringify(CORE)});
if (phase === 'after-lstat') {
 // The old stat-then-read implementation followed beta's symlink here. The descriptor
 // implementation has no separate pathname stat, so it safely retains alpha instead.
 assert.equal(core.resolveHost().name, 'alpha');
} else {
 assert.throws(() => core.resolveHost(), /invalid registry file/);
 assert.equal(armed, false, 'replacement hook was exercised');
}
`;
			const result = f.run(process.execPath, ["--input-type=module", "-e", script]);
			assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
			assert.equal(existsSync(f.log), false, "metadata resolution must not invoke a host");
		}
	} finally { f.close(); }
});
