// boxery-host upgrade: service-file parsing, profile discovery, version comparison, and the host-wide
// operation lock. The end-to-end flow (git origin, init, rollback) is test/shell/host-upgrade.sh.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discover, newer, parseArgs, parseService } from "../host/boxery-upgrade.mjs";
/** @import { ProfileServices, Service } from "../host/boxery-upgrade.mjs" */

let O, L;
try { L = await import("../host/boxery-leases.mjs"); O = await import("../host/boxery-operations.mjs"); }
catch (e) { if (!String(e.message).includes("sqlite")) throw e; }
const sqlite = L ? test : test.skip;

const unit = (root, conf, node = "/opt/node/bin/node") => `[Unit]
Description=boxery LLM proxy
[Service]
Environment=BOXERY_PROXY_PORT=8089
Environment=BOXERY_PROXY_BIND=127.0.0.1
${conf ? `Environment=BOXERY_CONF=${conf}\n` : ""}ExecStart=${node} ${root}/proxy/boxery-proxy.mjs
Restart=always
`;
const reaper = (root, conf) => `[Service]
Type=oneshot
Environment=BOXERY_CONF=${conf} BOXERY_BACKEND=lima PATH=/opt/node/bin:/home/u/.local/bin:/usr/bin
ExecStart=${root}/host/boxery-host reap
`;
const plist = (root, conf) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>dev.boxery-proxy</string>
  <key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>${root}/proxy/boxery-proxy.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>BOXERY_PROXY_PORT</key><string>8088</string><key>BOXERY_CONF</key><string>${conf}</string></dict>
</dict></plist>`;

test("parseService reads systemd proxy and reaper units", () => {
	assert.deepEqual(parseService(unit("/srv/boxery", "/home/u/.config/boxery-lima")),
		{ kind: "proxy", root: "/srv/boxery", conf: "/home/u/.config/boxery-lima", node: "/opt/node/bin/node", path: null });
	assert.deepEqual(parseService(reaper("/srv/boxery", "/c")),
		{ kind: "reaper", root: "/srv/boxery", conf: "/c", node: null, path: "/opt/node/bin:/home/u/.local/bin:/usr/bin" });
	assert.equal(/** @type {Service} */ (parseService(unit("/srv/boxery", null))).conf, null, "older units have no BOXERY_CONF: the default profile");
	assert.equal(parseService("[Service]\nExecStart=/usr/bin/socat VSOCK-LISTEN:8088,fork TCP:127.0.0.1:8088\n"), null, "the vsock bridge isn't a profile service");
	assert.equal(parseService("[Service]\nExecStart=/usr/bin/something-else\n"), null);
});

test("parseService reads launchd plists", () => {
	assert.deepEqual(parseService(plist("/opt/homebrew/lib/node_modules/boxery-vm", "/Users/u/.config/boxery")),
		{ kind: "proxy", root: "/opt/homebrew/lib/node_modules/boxery-vm", conf: "/Users/u/.config/boxery", node: "/opt/homebrew/bin/node", path: null });
});

test("discover groups this install's services by profile and reports other installs", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-upgrade-"));
	try {
		const mine = path.join(dir, "mine"), other = path.join(dir, "other");
		mkdirSync(mine); mkdirSync(other);
		const f = (name, text) => { writeFileSync(path.join(dir, name), text); return path.join(dir, name); };
		const files = [
			f("a.service", unit(mine, "/c/one")), f("b.service", reaper(mine, "/c/one")),
			f("c.service", unit(mine, "/c/two")),
			f("d.service", unit(other, "/c/three")),
			f("e.service", "[Service]\nExecStart=/usr/bin/socat x y\n"),
		];
		const { profiles, others } = discover(mine, files);
		assert.deepEqual([...profiles.keys()].sort(), ["/c/one", "/c/two"]);
		assert.equal(/** @type {{ reaper: Service }} */ (profiles.get("/c/one")).reaper.kind, "reaper");
		assert.equal(/** @type {ProfileServices} */ (profiles.get("/c/two")).reaper, undefined);
		assert.deepEqual(others.map((o) => o.root), [other]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("newer compares release versions numerically", () => {
	assert.equal(newer("0.10.0", "0.9.9"), true);
	assert.equal(newer("0.7.0", "0.7.0"), false);
	assert.equal(newer("0.7.0", "0.7.1"), false);
	assert.equal(newer("1.0.0", "0.99.0"), true);
});

test("parseArgs", () => {
	assert.deepEqual(parseArgs([]), { check: false, reinit: false, ref: null, wait: 600 });
	assert.deepEqual(parseArgs(["--check", "--ref", "v0.8.0", "--wait", "5", "--reinit"]), { check: true, reinit: true, ref: "v0.8.0", wait: 5 });
	assert.throws(() => parseArgs(["--wait", "soon"]), /number/);
	assert.throws(() => parseArgs(["--ref"]), /needs a value/);
	assert.throws(() => parseArgs(["--force"]), /unknown argument/);
});

sqlite("the host-wide lock waits for in-flight operations and blocks new ones", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-upgrade-lock-"));
	const db = L.open(path.join(dir, "leases.db"));
	try {
		// A live operation holding one VM (owned by this process, so it is not "abandoned").
		const start = O.identity(process.pid), boot = L.machineBootId();
		db.prepare("INSERT INTO operations(id, command, resources, env, owner, owner_start, boot, created_at) VALUES('op1','new','[\"a\"]','{}',?,?,?,1)").run(process.pid, start, boot);
		db.prepare("INSERT INTO operation_locks(resource, operation_id) VALUES('a','op1')").run();
		assert.equal(await O.holdExclusive(dir, Date.now() + 300), null, "times out while op1 runs");
		assert.equal(db.prepare("SELECT count(*) n FROM operations").get().n, 1, "a timed-out upgrade withdraws its lock");
		const pending = O.holdExclusive(dir, Date.now() + 5000);
		await new Promise((r) => setTimeout(r, 200));
		assert.ok(db.prepare("SELECT 1 FROM operation_locks WHERE resource='*'").get(), "the lock is published before draining");
		assert.equal(O.conflictsWith(["*"], ["b"]), true, "so new operations on any VM wait behind it");
		db.prepare("DELETE FROM operation_locks WHERE operation_id='op1'").run();
		db.prepare("DELETE FROM operations WHERE id='op1'").run();
		const held = await pending;
		assert.ok(held, "acquired once op1 finished");
		assert.equal(await O.holdExclusive(dir, Date.now() + 200), null, "a second upgrade waits for the first");
		held.release();
		assert.equal(db.prepare("SELECT count(*) n FROM operations").get().n, 0);
		assert.equal(db.prepare("SELECT count(*) n FROM operation_locks").get().n, 0);
	} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

sqlite("a dead upgrader's lock is reclaimed by the next operation", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-upgrade-dead-"));
	const db = L.open(path.join(dir, "leases.db"));
	try {
		// The owner is a process that has exited (a real PID: macOS ps rejects out-of-range ones), so its row is abandoned.
		const dead = spawnSync(process.execPath, ["-e", ""]).pid;
		db.prepare("INSERT INTO operations(id, command, resources, env, owner, owner_start, boot, created_at) VALUES('up','upgrade','[\"*\"]','{}',?,'x',?,1)").run(dead, L.machineBootId());
		db.prepare("INSERT INTO operation_locks(resource, operation_id) VALUES('*','up')").run();
		const held = await O.holdExclusive(dir, Date.now() + 2000);
		assert.ok(held, "reclaimed (no intents to replay)");
		held.release();
	} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

sqlite("the pre-upgrade copy leaves out the upgrade's own lock; restoring it keeps the lock held", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-upgrade-copy-"));
	const db = L.open(path.join(dir, "leases.db"));
	const locks = (d) => d.prepare("SELECT resource FROM operation_locks").all().map((r) => r.resource);
	try {
		L.add(db, "p1");
		const held = await O.holdExclusive(dir, Date.now() + 2000);
		const copy = path.join(dir, "copy.db");
		held.snapshot(copy);
		const c = L.open(copy);
		assert.deepEqual([locks(c), c.prepare("SELECT count(*) n FROM operations").get().n], [[], 0], "restored by hand, the copy is an idle host");
		c.close();
		db.exec(`CREATE TABLE extras (x); PRAGMA user_version = ${L.SCHEMA_VERSION + 1}`); // the new code migrates
		L.remove(db, "p1");
		held.restore(copy);
		assert.equal(L.schemaVersion(db), L.SCHEMA_VERSION);
		assert.equal(L.get(db, "p1").state, "FREE");
		assert.deepEqual(locks(db), ["*"], "still held until released");
		assert.equal(await O.holdExclusive(dir, Date.now() + 200), null, "so nothing else gets in");
		held.release();
		assert.deepEqual(locks(db), []);
	} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
