// Actual guest helper + core/MCP over isolated fake SSH; barriers, never timing races.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const HELPER = path.join(ROOT, "core/atomic-edit.py");
let dir, sequence = 0;
const children = new Set();
before(() => { dir = mkdtempSync(path.join(tmpdir(), "boxery-atomic-")); });
after(() => { for (const p of children) p.kill(); rmSync(dir, { recursive: true, force: true }); });
function file(content = "original", mode = 0o644) {
	const name = path.join(dir, `file-${++sequence}`);
	writeFileSync(name, content, { mode }); return name;
}
function launch(request, injection = "") {
	const code = `import sys\nscope={"__name__":"fixture"}\nexec(compile(open(sys.argv[1]).read(), sys.argv[1], "exec"),scope)\nscope["LOCK_DIRECTORY"]=sys.argv[3]\nexec(sys.argv[2],scope)\nsys.exit(scope["main"]())`;
	const p = spawn("python3", ["-B", "-c", code, HELPER, injection, path.join(dir, "locks")], { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
	children.add(p);
	let stdout = "", stderr = "", markers = "";
	const waiters = [];
	p.stdout.on("data", (d) => { stdout += d; });
	p.stderr.on("data", (d) => { stderr += d; });
	p.stdio[3].on("data", (d) => { markers += d; for (const [marker, resolve] of waiters) if (markers.includes(marker)) resolve(); });
	const result = new Promise((resolve) => p.on("close", (code) => { children.delete(p); resolve({ code, stdout, stderr }); }));
	p.stdin.end(JSON.stringify(request));
	return { p, result, ready: (marker = "ready") => markers.includes(marker) ? Promise.resolve() : new Promise((resolve) => waiters.push([marker, resolve])), release: () => p.stdio[4].end("go") };
}
async function helper(request, injection) { return launch(request, injection).result; }
async function snapshot(name, injection) {
	const r = await helper({ op: "snapshot", path: name }, injection);
	assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout);
}
function commit(name, snap, updated = "replacement") {
	return { op: "commit", path: name, snapshot: snap.snapshot, data: Buffer.from(updated).toString("base64") };
}
function intact(name, expected = "original") {
	assert.equal(readFileSync(name, "utf8"), expected);
	assert.deepEqual(readdirSync(path.dirname(name)).filter((n) => n.startsWith(".boxery-edit-")), []);
}
const stageBarrier = `
real_fsync = os.fsync
def barrier(fd):
    real_fsync(fd)
    os.write(3,b"ready")
    os.read(4,2)
os.fsync = barrier
`;

test("same-snapshot cooperating processes serialize; exactly one complete replacement", { timeout: 10000 }, async () => {
	const name = file(), a = await snapshot(name), b = await snapshot(name);
	const first = launch(commit(name, a, "first-complete"), stageBarrier);
	await first.ready();
	const second = launch(commit(name, b, "second-complete"), `
real_flock = fcntl.flock
def barrier(fd, flags):
    os.write(3,b"attempt")
    real_flock(fd, flags)
fcntl.flock = barrier
`);
	await second.ready("attempt");
	assert.equal(readFileSync(name, "utf8"), "original");
	first.release();
	assert.equal((await first.result).code, 0);
	const rejected = await second.result;
	assert.notEqual(rejected.code, 0); assert.match(rejected.stderr, /conflict/);
	intact(name, "first-complete");
});

test("external content change, same-byte replacement/ABA and deletion conflict", async () => {
	for (const kind of ["content", "replace", "aba", "delete"]) {
		const name = file(), snap = await snapshot(name);
		if (kind === "content") writeFileSync(name, "external");
		if (kind === "replace" || kind === "aba") {
			renameSync(file(kind === "aba" ? "intermediate" : "original"), name);
			if (kind === "aba") writeFileSync(name, "original");
		}
		if (kind === "delete") unlinkSync(name);
		const r = await helper(commit(name, snap));
		assert.notEqual(r.code, 0); assert.match(r.stderr, /conflict/);
		if (kind !== "delete") intact(name, kind === "content" ? "external" : "original");
		else assert.equal(existsSync(name), false);
	}
});

test("change during staging is revalidated, leaves external bytes and cleans temp", { timeout: 10000 }, async () => {
	const name = file(), snap = await snapshot(name);
	const pending = launch(commit(name, snap), stageBarrier);
	await pending.ready(); writeFileSync(name, "external"); pending.release();
	const r = await pending.result;
	assert.match(r.stderr, /conflict/); intact(name, "external");
});

test("partial staging write interruption never truncates the destination", { timeout: 10000 }, async () => {
	const name = file(), snap = await snapshot(name);
	const pending = launch(commit(name, snap), `
real_fdopen=os.fdopen
class Partial:
 def __init__(self,out): self.out=out
 def __enter__(self): return self
 def __exit__(self,*args): return self.out.__exit__(*args)
 def __getattr__(self,key): return getattr(self.out,key)
 def write(self,data):
  self.out.write(data[:3]); self.out.flush()
  os.write(3,b"ready"); os.read(4,2)
os.fdopen=lambda *a,**kw: Partial(real_fdopen(*a,**kw))
`);
	await pending.ready(); assert.equal(readFileSync(name, "utf8"), "original");
	pending.p.kill("SIGTERM"); assert.notEqual((await pending.result).code, 0); intact(name);
});

test("failed replace, flush and ownership preservation fail safely with cleanup", async () => {
	for (const injection of [
		`def fail(*a, **kw): raise OSError("replace denied")\nos.replace=fail`,
		`def fail(*a, **kw): raise OSError("disk full")\nos.fsync=fail`,
		// Force the ownership-preservation branch even when running as root.
		`real_fstat=os.fstat\nclass Changed:\n def __init__(self,s): self.__dict__.update((k,getattr(s,k)) for k in dir(s) if k.startswith("st_")); self.st_gid=-1\ndef fstat(fd):\n s=real_fstat(fd)\n return Changed(s) if stat.S_ISREG(s.st_mode) and s.st_size==11 else s\ndef fail(*a,**kw): raise PermissionError("chown denied")\nos.fstat=fstat\nos.fchown=fail`,
	]) {
		const name = file(), snap = await snapshot(name);
		const r = await helper(commit(name, snap), injection);
		assert.notEqual(r.code, 0, r.stdout); intact(name);
		// Failure must release the persistent lock, not poison later callers.
		assert.equal((await helper(commit(name, snap))).code, 0);
		intact(name, "replacement");
	}
});

test("staging-name collision never removes or overwrites an existing entry", async () => {
	const parent = path.join(dir, "collision"); mkdirSync(parent);
	const name = path.join(parent, "file"), occupied = path.join(parent, ".boxery-edit-fixed");
	writeFileSync(name, "original"); writeFileSync(occupied, "unrelated");
	const r = await helper(commit(name, await snapshot(name)), `secrets.token_hex=lambda n: 'fixed'`);
	assert.notEqual(r.code, 0); assert.equal(readFileSync(name, "utf8"), "original");
	assert.equal(readFileSync(occupied, "utf8"), "unrelated"); unlinkSync(occupied);
});

test("handled TERM/HUP/INT during staging preserve original and release lock/temp", { timeout: 10000 }, async () => {
	for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) {
		const name = file(), snap = await snapshot(name);
		const pending = launch(commit(name, snap), stageBarrier);
		await pending.ready(); pending.p.kill(sig);
		const r = await pending.result; assert.notEqual(r.code, 0); intact(name);
		assert.equal((await helper(commit(name, snap))).code, 0);
	}
});

test("executable/basic mode and uid/gid preserved; hardlinks fail closed", async () => {
	const name = file("original", 0o751), before = statSync(name);
	assert.equal((await helper(commit(name, await snapshot(name)))).code, 0);
	const after = statSync(name);
	assert.equal(after.mode & 0o7777, before.mode & 0o7777);
	assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid);
	linkSync(name, name + "-hardlink");
	const r = await helper({ op: "snapshot", path: name });
	assert.notEqual(r.code, 0); assert.match(r.stderr, /multiply-linked/);
	intact(name, "replacement");
});

test("readonly files and directories fail without changing bytes", { skip: process.getuid?.() === 0 }, async () => {
	const name = file(); chmodSync(name, 0o444);
	const denied = await helper({ op: "snapshot", path: name });
	assert.notEqual(denied.code, 0); intact(name); chmodSync(name, 0o644);
	const parent = path.join(dir, "readonly-parent"); mkdirSync(parent);
	const child = path.join(parent, "file"); writeFileSync(child, "original");
	const snap = await snapshot(child); chmodSync(parent, 0o555);
	try { assert.notEqual((await helper(commit(child, snap))).code, 0); intact(child); }
	finally { chmodSync(parent, 0o755); }
});

test("symlink chains preserved, aliases share lock, retargeted links conflict", { timeout: 10000 }, async () => {
	const name = file(), alias = name + "-alias", alias2 = name + "-alias2";
	symlinkSync(name, alias); symlinkSync(alias, alias2);
	const a = await snapshot(name), b = await snapshot(alias2);
	const first = launch(commit(name, a), stageBarrier); await first.ready();
	const second = launch(commit(alias2, b), `real=fcntl.flock\ndef lock(fd,flags):\n os.write(3,b"attempt"); real(fd,flags)\nfcntl.flock=lock`);
	await second.ready("attempt"); first.release();
	assert.equal((await first.result).code, 0); assert.notEqual((await second.result).code, 0);
	assert.equal(readFileSync(alias2, "utf8"), "replacement");
	assert.equal(statSync(alias2).ino, statSync(name).ino);
	const snap = await snapshot(alias2), other = file();
	unlinkSync(alias); symlinkSync(other, alias);
	const r = await helper(commit(alias2, snap)); assert.match(r.stderr, /conflict/);
	intact(other); intact(name, "replacement");
	// Changing an intermediate link to a different link with the SAME final target also conflicts.
	const snap2 = await snapshot(alias2), alias3 = other + "-alias"; symlinkSync(other, alias3);
	unlinkSync(alias); symlinkSync(alias3, alias);
	assert.match((await helper(commit(alias2, snap2))).stderr, /conflict/);
	assert.equal(execFileSync("python3", ["-c", "import os,sys; print(os.path.islink(sys.argv[1]) and os.path.islink(sys.argv[2]))", alias, alias2], { encoding: "utf8" }).trim(), "True");
});

test("replaced parent paths conflict; hostile names are data; FIFO/directory rejected promptly", { timeout: 10000 }, async () => {
	const parent = path.join(dir, "parent"); mkdirSync(parent);
	const name = path.join(parent, "file"); writeFileSync(name, "original");
	const snap = await snapshot(name);
	renameSync(parent, parent + "-old"); mkdirSync(parent); writeFileSync(name, "original");
	assert.match((await helper(commit(name, snap))).stderr, /conflict/); intact(name);
	const hostile = path.join(dir, "'\";$(touch NEVER)\n\\ -file"); writeFileSync(hostile, "original");
	assert.equal((await helper(commit(hostile, await snapshot(hostile)))).code, 0); intact(hostile, "replacement");
	assert.equal(existsSync(path.join(ROOT, "NEVER")), false);
	const fifo = path.join(dir, "fifo"); execFileSync("mkfifo", [fifo]);
	for (const p of [fifo, parent]) {
		const r = await helper({ op: "snapshot", path: p }); assert.notEqual(r.code, 0); assert.match(r.stderr, /regular file/);
	}
});

test("parent replacement during staging cleans through the opened directory, not the new path", { timeout: 10000 }, async () => {
	const parent = path.join(dir, "moving-parent"); mkdirSync(parent);
	const name = path.join(parent, "file"); writeFileSync(name, "original");
	const pending = launch(commit(name, await snapshot(name)), stageBarrier); await pending.ready();
	renameSync(parent, parent + "-old"); mkdirSync(parent); writeFileSync(name, "new-parent");
	pending.release(); assert.match((await pending.result).stderr, /conflict/);
	intact(name, "new-parent"); intact(path.join(parent + "-old", "file"));
});

test("observation verifies the read FD version and rejects oversized files before reading", async () => {
	const name = file();
	const r = await helper({ op: "snapshot", path: name }, `
real_read=os.read
def changed(fd,size):
 data=real_read(fd,size)
 with open(${JSON.stringify(name)},'wb') as f: f.write(b'external')
 return data
os.read=changed
`);
	assert.notEqual(r.code, 0); assert.match(r.stderr, /conflict/); intact(name, "external");
	execFileSync("python3", ["-c", "import os,sys; os.truncate(sys.argv[1],16*1024*1024+1)", name]);
	const big = await helper({ op: "snapshot", path: name }, `def fail(*a): raise AssertionError('must not read oversized file')\nos.read=fail`);
	assert.match(big.stderr, /exceeds 16 MiB/);
});

test("unsafe private lock fixtures are rejected, stable locks persist, descriptors released", async () => {
	const name = file(), snap = await snapshot(name);
	// Never touch the real per-user lock: every fixture overrides the module constant.
	const unsafe = path.join(dir, "unsafe-locks"); mkdirSync(unsafe, { mode: 0o700 });
	const lock = path.join(unsafe, "edit.lock"), injection = `LOCK_DIRECTORY=${JSON.stringify(unsafe)}`;
	for (const kind of ["symlink", "hardlink", "fifo", "permissions"]) {
		if (kind === "symlink") symlinkSync(name, lock);
		if (kind === "hardlink") linkSync(name, lock);
		if (kind === "fifo") execFileSync("mkfifo", [lock]);
		if (kind === "permissions") writeFileSync(lock, "", { mode: 0o644 });
		try { assert.notEqual((await helper(commit(name, snap), injection)).code, 0, kind); intact(name); }
		finally { unlinkSync(lock); }
	}
	chmodSync(unsafe, 0o755);
	try { assert.match((await helper(commit(name, snap), injection)).stderr, /unsafe edit lock directory/); }
	finally { chmodSync(unsafe, 0o700); }
	const stableLock = path.join(dir, "locks", "edit.lock"), identity = statSync(stableLock).ino;
	const r = await helper({ op: "snapshot", path: name }, `
def count():
 n=0
 for fd in range(256):
  try: os.fstat(fd); n+=1
  except OSError: pass
 return n
before=count()
for _ in range(40): run({"op":"snapshot","path":${JSON.stringify(name)}})
assert count()==before, (before,count())
`);
	assert.equal(r.code, 0, r.stderr);
	assert.equal(statSync(stableLock).ino, identity);
});

test("case aliases serialize immediately before replace and the second same-version commit conflicts", { timeout: 10000 }, async (t) => {
	const parent = path.join(dir, "case-alias"); mkdirSync(parent);
	const name = path.join(parent, "target"), alias = path.join(parent, "TARGET"); writeFileSync(name, "original");
	if (!existsSync(alias) || statSync(alias).ino !== statSync(name).ino) return t.skip("filesystem is case-sensitive");
	const a = await snapshot(name), b = await snapshot(alias);
	assert.deepEqual(a.snapshot.version, b.snapshot.version); assert.equal(a.snapshot.sha256, b.snapshot.sha256);
	const first = launch(commit(name, a, "first-complete"), `
real_replace=os.replace
def replace(*args,**kwargs):
 os.write(3,b"ready"); os.read(4,2)
 return real_replace(*args,**kwargs)
os.replace=replace
`);
	await first.ready();
	const second = launch(commit(alias, b, "second-complete"), `
real_flock=fcntl.flock
def lock(fd,flags):
 try:
  real_flock(fd,flags|fcntl.LOCK_NB)
 except BlockingIOError:
  os.write(3,b"blocked")
 else:
  raise AssertionError("case alias acquired an independent lock")
 real_flock(fd,flags)
fcntl.flock=lock
`);
	await Promise.race([second.ready("blocked"), second.result.then((r) => assert.fail(r.stderr || "second commit did not block"))]);
	assert.equal(readFileSync(name, "utf8"), "original"); first.release();
	assert.equal((await first.result).code, 0);
	const r = await second.result; assert.notEqual(r.code, 0); assert.match(r.stderr, /conflict/);
	intact(name, "first-complete"); assert.equal(readFileSync(alias, "utf8"), "first-complete");
});

test("unprivileged write/search-only (0300) parent supports snapshot and commit", async (t) => {
	const capable = execFileSync("python3", ["-c", "import os; print(hasattr(os,'O_PATH') or hasattr(os,'O_SEARCH'))"], { encoding: "utf8" }).trim() === "True";
	if (!capable) return t.skip("platform needs the documented O_RDONLY directory-read fallback");
	const parent = path.join(dir, "search-only"), locks = path.join(dir, "search-only-locks");
	mkdirSync(parent); mkdirSync(locks, { mode: 0o700 });
	const name = path.join(parent, "file"); writeFileSync(name, "original");
	let injection = `LOCK_DIRECTORY=${JSON.stringify(locks)}\nassert os.geteuid()!=0`;
	if (process.getuid?.() === 0) {
		// Exercise real permissions even in root-run Linux CI, not root's bypass.
		execFileSync("python3", ["-c", "import os,pwd,sys; u=pwd.getpwnam('nobody'); [os.chown(p,u.pw_uid,u.pw_gid) for p in sys.argv[1:]]", parent, name, locks]);
		chmodSync(dir, 0o711);
		injection = `import pwd\nu=pwd.getpwnam('nobody')\nos.setgroups([])\nos.setgid(u.pw_gid)\nos.setuid(u.pw_uid)\n${injection}`;
	}
	chmodSync(parent, 0o300);
	try {
		const snap = await snapshot(name, injection);
		const r = await helper(commit(name, snap), injection); assert.equal(r.code, 0, r.stderr);
		assert.equal(readFileSync(name, "utf8"), "replacement");
		assert.equal(statSync(parent).mode & 0o777, 0o300);
	} finally {
		chmodSync(parent, 0o700); chmodSync(dir, 0o700);
	}
	intact(name, "replacement");
});
