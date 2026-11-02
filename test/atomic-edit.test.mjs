// One real guest operation under a cross-process advisory lock. No production hooks.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { applyEdits, q } from "../core/boxery-core.mjs";
import { guestFixture, lockHeld } from "./helpers/atomic-edit-fixture.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "boxery-atomic-")), env = guestFixture(dir);
const helper = readFileSync(new URL("../core/atomic-edit.mjs", import.meta.url), "utf8");
const source = `${helper}\nawait main(${applyEdits.toString()});`;
const children = new Set(); let sequence = 0;
after(() => { for (const p of children) { try { process.kill(-p.pid, "SIGTERM"); } catch {} } rmSync(dir, { recursive: true, force: true }); });
/** @param {string | Buffer} [content] @param {number} [mode] */
function file(content = "alpha beta", mode = 0o644) {
	const name = path.join(dir, `file-${++sequence}`); writeFileSync(name, content, { mode }); return name;
}
/** @param {string} name @param {{ oldText: string, newText?: string }[]} [edits] @param {string} [injection] @param {boolean} [blocked] */
function launch(name, edits = [{ oldText: "alpha", newText: "ALPHA" }], injection = "", blocked = false) {
	const lock = path.join(dir, "edit.lock");
	// Prove the second process encountered the held lock before releasing the first.
	const probe = blocked ? `perl -MFcntl=:flock -e ${q('open(my $f, ">>", $ARGV[0]) or die; die "unexpected free lock" if flock($f,LOCK_EX|LOCK_NB); print "ready"')} ${q(lock)} >&3; ` : "";
	const p = spawn("bash", ["-c", `set -e; ${probe}exec flock -w 60 ${q(lock)} ${q(process.execPath)} --input-type=module -e ${q(source)}`], {
		env: { ...env, EDIT_INJECT: injection }, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
	});
	children.add(p); let stdout = "", stderr = "", markers = "";
	let ready;
	const reached = new Promise((resolve) => { ready = resolve; });
	p.stdout.on("data", (d) => { stdout += d; }); p.stderr.on("data", (d) => { stderr += d; });
	/** @type {import("node:stream").Readable} */ (p.stdio[3]).on("data", (d) => { markers += d; if (markers.includes("ready")) ready(); });
	const result = new Promise((resolve) => p.on("close", (code) => { children.delete(p); resolve({ code, stdout, stderr }); }));
	p.stdin.end(JSON.stringify({ path: name, edits }));
	return { p, result, ready: () => Promise.race([reached, result.then((r) => assert.fail(`barrier not reached: ${r.stderr}`))]), release: () => /** @type {import("node:stream").Writable} */ (p.stdio[4]).end("go") };
}
const barrier = `const {Socket}=await import('node:net'); const open=fs.open; fs.open=async(...a)=>{const f=await open(...a); const sync=f.sync.bind(f); f.sync=async()=>{await sync(); await new Promise(resolve=>{const input=new Socket({fd:4,readable:true,writable:false}); const stop=()=>{input.destroy();resolve()}; input.once('data',stop); for(const s of ['SIGTERM','SIGHUP','SIGINT']) process.once(s,stop); writeSync(3,'ready');});}; return f;};`;
function intact(name, expected = "alpha beta") {
	assert.equal(readFileSync(name, "utf8"), expected);
	assert.deepEqual(readdirSync(path.dirname(name)).filter((n) => n.startsWith(".boxery-edit-")), []);
}
async function ok(p) { const r = await p.result; assert.equal(r.code, 0, r.stderr); }

test("exact edits, unicode/shell-hostile names, and UTF-8 behavior use the shared matcher", async () => {
	const name = path.join(dir, "'\";$(touch NEVER)\n\\-雪🦊"); writeFileSync(name, "café 🦊\r\nalpha beta");
	await ok(launch(name, [{ oldText: "café 🦊", newText: "雪" }, { oldText: "beta", newText: "BETA" }]));
	intact(name, "雪\r\nalpha BETA"); assert.equal(existsSync(path.join(dir, "NEVER")), false);
	for (const edits of [[{ oldText: "" }], [{ oldText: "absent" }], [{ oldText: "a" }], [{ oldText: "alpha" }, { oldText: "pha" }]]) {
		assert.notEqual((await launch(name, edits).result).code, 0); intact(name, "雪\r\nalpha BETA");
	}
	const invalid = file(Buffer.from([0xff, 0x61])); await ok(launch(invalid, [{ oldText: "a", newText: "b" }]));
	intact(invalid, "�b"); // same Buffer UTF-8 decoding as the existing edit engine
});

test("overlapping edits across processes: one applies; disjoint edits preserve both; aliases share lock", { timeout: 10000 }, async (t) => {
	for (const kind of ["same", "disjoint", "symlink", "case"]) {
		const name = file(); let alias = name;
		if (kind === "symlink") { alias += "-alias"; symlinkSync(name, alias); }
		if (kind === "case") { alias = name.toUpperCase(); if (!existsSync(alias)) { t.diagnostic("case alias unavailable on this filesystem"); continue; } }
		const first = launch(name, undefined, barrier); await first.ready();
		assert.ok(lockHeld(path.join(dir, "edit.lock")), "the Node child retains the flock descriptor");
		const second = launch(alias, [{ oldText: kind === "disjoint" ? "beta" : "alpha", newText: "SECOND" }], "", true);
		await second.ready();
		assert.equal(readFileSync(name, "utf8"), "alpha beta"); first.release(); await ok(first);
		const r = await second.result;
		if (kind === "disjoint") { assert.equal(r.code, 0, r.stderr); intact(name, "ALPHA SECOND"); }
		else { assert.notEqual(r.code, 0); assert.match(r.stderr, /not found/); intact(name, "ALPHA beta"); }
		if (kind === "symlink") assert.ok(lstatSync(alias).isSymbolicLink());
	}
});

test("external content/identity changes and retargeting observed during staging conflict", { timeout: 10000 }, async () => {
	for (const kind of ["bytes", "same-byte-replace", "symlink", "parent"]) {
		const parent = path.join(dir, `parent-${++sequence}`); mkdirSync(parent);
		const name = path.join(parent, "file"); writeFileSync(name, "alpha beta");
		const alias = name + "-alias"; symlinkSync(name, alias);
		const pending = launch(alias, undefined, barrier); await pending.ready();
		if (kind === "bytes") writeFileSync(name, "external");
		if (kind === "same-byte-replace") renameSync(file(), name);
		if (kind === "symlink") { unlinkSync(alias); symlinkSync(file("external"), alias); }
		if (kind === "parent") { renameSync(parent, parent + "-old"); mkdirSync(parent); writeFileSync(name, "external"); symlinkSync(name, alias); }
		pending.release(); const r = await pending.result;
		assert.notEqual(r.code, 0); assert.match(r.stderr, /conflict/);
		intact(name, ["bytes", "parent"].includes(kind) ? "external" : "alpha beta");
		// Path-based cleanup cannot find staging after a parent is renamed (documented limit).
		if (kind === "parent") rmSync(parent + "-old", { recursive: true });
	}
});

test("failed write/flush/rename preserve original and clean staging; subsequent edits work", async () => {
	for (const operation of ["writeFile", "sync", "rename", "owner"]) {
		const injection = operation === "rename" ? `fs.rename=async()=>{throw Error('rename denied')};` : operation === "owner" ?
			`const open=fs.open; fs.open=async(...a)=>{const f=await open(...a); if(a[1]==='wx'){const stat=f.stat.bind(f);f.stat=async(...args)=>{const s=await stat(...args);s.uid++;return s};f.chown=async()=>{throw Error('ownership denied')}} return f};` :
			`const open=fs.open; fs.open=async(...a)=>{const f=await open(...a); f.${operation}=async()=>{throw Error('disk full')}; return f;};`;
		const name = file(); const r = await launch(name, undefined, injection).result;
		assert.notEqual(r.code, 0); assert.match(r.stderr, /disk full|rename denied|ownership denied/); intact(name);
		await ok(launch(name)); intact(name, "ALPHA beta");
	}
});

test("handled TERM/HUP/INT midstage never truncate destination and clean up", { timeout: 10000 }, async () => {
	for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) {
		const name = file(), pending = launch(name, undefined, barrier); await pending.ready();
		process.kill(-/** @type {number} */ (pending.p.pid), sig); const r = await pending.result;
		assert.notEqual(r.code, 0); intact(name); await ok(launch(name));
	}
});

test("bounded observation rejects external growth during reading", async () => {
	const name = file();
	const r = await launch(name, undefined, `const open=fs.open; let changed=false; fs.open=async(...a)=>{const f=await open(...a), read=f.read.bind(f); f.read=async(...args)=>{const r=await read(...args); if(!changed){changed=true;await fs.truncate(${JSON.stringify(name)},16*1024*1024+1)} return r};return f};`).result;
	assert.notEqual(r.code, 0); assert.match(r.stderr, /exceeds 16 MiB/);
});

test("mode/uid/gid preserved; readonly, hardlinks, directories, FIFO and >16MiB rejected", { timeout: 10000 }, async () => {
	const name = file("alpha beta", 0o751), before = statSync(name); await ok(launch(name));
	const now = statSync(name); for (const key of ["mode", "uid", "gid"]) assert.equal(now[key], before[key]);
	linkSync(name, name + "-hard"); assert.match((await launch(name).result).stderr, /multiply-linked/);
	const fifo = path.join(dir, "fifo"); execFileSync("mkfifo", [fifo]);
	for (const target of [fifo, dir]) assert.match((await launch(target).result).stderr, /regular file/);
	const big = file(); truncateSync(big, 16 * 1024 * 1024 + 1); assert.match((await launch(big).result).stderr, /exceeds 16 MiB/);
	const bounded = file(); assert.match((await launch(bounded, [{ oldText: "alpha", newText: "x".repeat(16 * 1024 * 1024) }]).result).stderr, /result exceeds/); intact(bounded);
	if (process.getuid?.() !== 0) {
		const ro = file(); chmodSync(ro, 0o444); assert.notEqual((await launch(ro).result).code, 0); intact(ro);
	}
});
