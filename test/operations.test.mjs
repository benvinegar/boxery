// Real host dispatcher + SQLite + fake backend; kill actual supervisors at deterministic barriers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
let L, O;
try { L = await import("../host/boxery-leases.mjs"); O = await import("../host/boxery-operations.mjs"); }
catch (e) { if (!String(e.message).includes("sqlite")) throw e; }
const it = L ? test : test.skip;
const HOST = path.resolve(import.meta.dirname, "../host/boxery-host");
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIleasekeyoneleasekeyone holder";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let dir, conf, vms, env, db, children;
async function until(fn) {
	for (let i = 0; i < 400; i++) { if (fn()) return; await pause(25); }
	throw new Error("timed out waiting for lifecycle barrier");
}
function run(args, extra = {}, input) {
	const child = spawn(HOST, args, { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
	children.push(child);
	let stdout = "", stderr = "";
	child.stdout.on("data", (d) => { stdout += d; });
	child.stderr.on("data", (d) => { stderr += d; });
	child.stdin.on("error", () => {});
	child.stdin.end(input);
	child.result = new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
	return child;
}
async function ok(args, extra, input) {
	const r = await run(args, extra, input).result;
	assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}
const barrier = (name, point) => path.join(vms, ".barriers", `${name}.${point}`);
const release = (name, point) => writeFileSync(`${barrier(name, point)}.release`, "go");
const token = (name) => JSON.parse(readFileSync(path.join(conf, "tokens.json")))[name];
const locks = () => db.prepare("SELECT * FROM operation_locks").all();
function operationAt(name, point) {
	const id = readFileSync(barrier(name, point), "utf8").trim();
	return db.prepare("SELECT * FROM operations WHERE id=?").get(id);
}
function cleanJournal() {
	assert.deepEqual(locks(), []);
	assert.equal(db.prepare("SELECT count(*) AS n FROM operations").get().n, 0);
	assert.equal(db.prepare("SELECT count(*) AS n FROM operation_intents").get().n, 0);
}

beforeEach(() => {
	if (!L) return;
	dir = mkdtempSync(path.join(tmpdir(), "boxery-operations-"));
	conf = path.join(dir, "conf"); vms = path.join(dir, "vms"); children = [];
	mkdirSync(conf); mkdirSync(vms); mkdirSync(path.join(dir, "bin"));
	writeFileSync(path.join(vms, ".base"), "");
	writeFileSync(path.join(conf, "mgmt_ed25519"), "");
	writeFileSync(path.join(conf, "mgmt_ed25519.pub"), KEY.replace("holder", "management"));
	writeFileSync(path.join(conf, "authorized_keys"), "");
	writeFileSync(path.join(dir, "bin", "ssh"), `#!/usr/bin/env bash
port=""; while [ $# -gt 0 ]; do case $1 in -p) port=$2; shift 2 ;; -o|-F|-i) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
case "$*" in *cloud-init*|*6080*) exit 0 ;; esac
for d in "$BOXERY_FAKE_DIR"/*/; do
  if [ "$(cat "$d/port" 2>/dev/null)" = "$port" ]; then
    if [ -n "\${BOXERY_TEST_KEY_PAUSE:-}" ]; then
      case "$*" in *authorized_keys.boxery*)
        mkdir -p "$BOXERY_FAKE_DIR/.barriers"
        b="$BOXERY_FAKE_DIR/.barriers/$(basename "$d").key"
        printf '%s\\n' "$BOXERY_OPERATION_ID" >"$b"
        while [ ! -e "$b.release" ]; do sleep 0.02; done ;;
      esac
    fi
    mkdir -p "$d/home"; cd "$d/home" && HOME="$d/home" exec bash -c "\${*:-true}"
  fi
done
exit 255
`, { mode: 0o755 });
	env = { ...process.env, BOXERY_CONF: conf, BOXERY_FAKE_DIR: vms, BOXERY_BACKEND: "fake", BOXERY_BOOT_ID: "test-boot", BOXERY_SSH_WAIT_TRIES: "1", PATH: `${path.join(dir, "bin")}:${process.env.PATH}` };
	db = L.open(path.join(conf, "leases.db"));
});
afterEach(async () => {
	if (!L) return;
	for (const child of children) if (child.exitCode == null) child.kill("SIGKILL");
	for (const op of db.prepare("SELECT * FROM operations").all()) {
		if (op.child && O.identity(op.child) === op.child_start) {
			try { process.kill(-op.child, "SIGKILL"); } catch {}
		}
	}
	await Promise.all(children.map((c) => c.result));
	db.close(); rmSync(dir, { recursive: true, force: true });
});

it("duplicate creates serialize preflight and cannot rotate or delete the winning identity", async () => {
	const first = run(["new", "same"], { BOXERY_FAKE_PAUSE: "new" });
	await until(() => existsSync(barrier("same", "new")));
	const original = token("same");
	const second = run(["new", "same"]);
	await pause(200);
	assert.equal(second.exitCode, null);
	assert.equal(token("same"), original);
	await ok(["new", "unrelated"]); // no long-lived global lock while the first VM boots
	release("same", "new");
	assert.equal((await first.result).code, 0);
	assert.equal((await second.result).code, 1);
	assert.equal(token("same"), original);
	assert.ok(existsSync(path.join(vms, "same", "user-data")));
	cleanJournal();
});

it("a killed supervisor's live worker is stopped before partial-create cleanup and name reuse", async () => {
	const first = run(["new", "same"], { BOXERY_FAKE_PAUSE: "new" });
	await until(() => existsSync(barrier("same", "new")));
	const op = operationAt("same", "new"), oldToken = token("same");
	assert.ok(O.identity(op.child));
	first.kill("SIGKILL");
	await until(() => O.identity(op.owner) == null);
	// The worker remains alive until the successor fences its process group.
	assert.ok(O.identity(op.child));
	await ok(["new", "same"]);
	assert.equal(O.identity(op.child), null);
	assert.notEqual(token("same"), oldToken);
	release("same", "new");
	await pause(100);
	assert.ok(existsSync(path.join(vms, "same", "user-data")));
	cleanJournal();
});

it("recovery pins the original backend namespace rather than inheriting a successor's overrides", async () => {
	const create = run(["new", "same"], { BOXERY_FAKE_PAUSE: "new" });
	await until(() => existsSync(barrier("same", "new")));
	create.kill("SIGKILL"); await until(() => create.signalCode === "SIGKILL");
	const other = path.join(dir, "other-vms"); mkdirSync(other); writeFileSync(path.join(other, ".base"), "");
	await ok(["new", "same"], { BOXERY_FAKE_DIR: other });
	assert.equal(existsSync(path.join(vms, "same")), false, "old artifacts cleaned in their original namespace");
	assert.ok(existsSync(path.join(other, "same", "user-data")), "new request uses its own namespace");
	cleanJournal();
});

it("reconcile removes abandoned partial captures, preserves source data, and permits retry", async () => {
	await ok(["new", "src"]);
	writeFileSync(path.join(vms, "src", "home", "work"), "keep me");
	const capture = run(["snap", "src", "checkpoint"], { BOXERY_FAKE_PAUSE: "capture" });
	await until(() => existsSync(barrier("src", "capture")));
	capture.kill("SIGKILL");
	await until(() => capture.signalCode === "SIGKILL");
	await ok(["reconcile"]);
	assert.equal(existsSync(path.join(vms, ".images", "src@checkpoint.part")), false);
	assert.equal(readFileSync(path.join(vms, "src", "home", "work"), "utf8"), "keep me");
	await ok(["snap", "src", "checkpoint"]);
	cleanJournal();
});

it("failed recovery retains its journal and locks until a later retry succeeds", async () => {
	const create = run(["new", "same"], { BOXERY_FAKE_PAUSE: "new" });
	await until(() => existsSync(barrier("same", "new")));
	create.kill("SIGKILL"); await until(() => create.signalCode === "SIGKILL");
	const tokens = readFileSync(path.join(conf, "tokens.json"), "utf8");
	writeFileSync(path.join(conf, "tokens.json"), "invalid JSON");
	const failed = await run(["new", "same"]).result;
	assert.equal(failed.code, 1);
	assert.match(failed.stderr, /recovery failed/);
	assert.equal(locks().length, 1, "resource is not handed out after incomplete cleanup");
	assert.equal(existsSync(path.join(vms, "same")), false);
	writeFileSync(path.join(conf, "tokens.json"), tokens);
	await ok(["new", "same"]);
	cleanJournal();
});

it("crashed forks keep completed children but clean unfinished children and their temporary image", async () => {
	await ok(["new", "src"]);
	writeFileSync(path.join(vms, "src", "home", "work"), "source data");
	const fork = run(["fork", "src", "a", "b"], { BOXERY_FAKE_PAUSE: "new" });
	await until(() => existsSync(barrier("a", "new")) && existsSync(barrier("b", "new")));
	release("a", "new");
	await until(() => !db.prepare("SELECT data FROM operation_intents WHERE kind='create'").all().some((r) => JSON.parse(r.data)[0] === "a"));
	fork.kill("SIGKILL"); await until(() => fork.signalCode === "SIGKILL");
	await ok(["reconcile"]);
	assert.equal(readFileSync(path.join(vms, "a", "home", "work"), "utf8"), "source data");
	assert.equal(existsSync(path.join(vms, "b")), false);
	assert.equal(token("b"), undefined);
	assert.doesNotMatch(await ok(["images"]), /@fork-/);
	cleanJournal();
});

it("an image reader holds the source lock until the new VM is fully ready", async () => {
	await ok(["new", "src"]); await ok(["snap", "src", "one"]);
	const create = run(["new", "copy", "--from", "src@one"], { BOXERY_FAKE_PAUSE: "new" });
	await until(() => existsSync(barrier("copy", "new")));
	assert.deepEqual(locks().map((r) => r.resource).sort(), ["copy", "src"]);
	const remove = run(["snap-rm", "src", "one"]);
	await pause(200); assert.equal(remove.exitCode, null);
	release("copy", "new");
	assert.equal((await create.result).code, 0);
	assert.equal((await remove.result).code, 0);
	assert.ok(existsSync(path.join(vms, "copy", "user-data")));
	cleanJournal();
});

it("crashed deletion resumes image, token and grant cleanup after the VM is already gone", async () => {
	await ok(["new", "gone"]); await ok(["snap", "gone", "one"]);
	mkdirSync(path.join(conf, "edge")); writeFileSync(path.join(conf, "edge", "gone.json"), "{}");
	const remove = run(["rm", "gone"], { BOXERY_FAKE_PAUSE: "rm" });
	await until(() => existsSync(barrier("gone", "rm")));
	remove.kill("SIGKILL"); await until(() => remove.signalCode === "SIGKILL");
	await ok(["reconcile"]);
	assert.equal(token("gone"), undefined);
	assert.equal(existsSync(path.join(conf, "edge", "gone.json")), false);
	assert.equal(existsSync(path.join(vms, ".images", "gone@one")), false);
	cleanJournal();
});

it("reaper cannot change an acquiring generation while key installation owns the VM lock", async () => {
	await ok(["new", "pool"]); await ok(["pool", "add", "pool"]);
	const acquire = run(["acquire", "--holder", "alice"], { BOXERY_TEST_KEY_PAUSE: "1" }, KEY);
	await until(() => existsSync(barrier("pool", "key")));
	const before = L.get(db, "pool"); assert.equal(before.state, "ACQUIRING");
	const reap = run(["reap"], { BOXERY_NOW: String(Math.floor(Date.now() / 1000) + 4000) });
	await pause(250);
	assert.equal(L.get(db, "pool").gen, before.gen);
	assert.equal(reap.exitCode, null);
	release("pool", "key");
	assert.equal((await acquire.result).code, 0);
	assert.equal((await reap.result).code, 0);
	assert.equal(L.get(db, "pool").state, "LEASED", "stale observed generation is not reset");
	cleanJournal();
});

it("abandoned key installation resets before the VM can be leased to someone else", async () => {
	await ok(["new", "pool"]); await ok(["pool", "add", "pool"]);
	const acquire = run(["acquire", "--holder", "alice"], { BOXERY_TEST_KEY_PAUSE: "1" }, KEY);
	await until(() => existsSync(barrier("pool", "key")));
	const op = operationAt("pool", "key");
	// The outer acquire process waits for a nested supervisor; kill that supervisor explicitly.
	process.kill(op.owner, "SIGKILL");
	await until(() => O.identity(op.owner) == null);
	await ok(["reconcile"]);
	assert.equal(O.identity(op.child), null);
	assert.equal(L.get(db, "pool").state, "FREE");
	const next = await ok(["acquire", "--holder", "bob"], {}, KEY.replace("holder", "next-holder"));
	assert.match(next, /^pool l-/);
	cleanJournal();
});

it("reset holds its lock through readiness and finish; stale callbacks cannot clear a new holder's grants", async () => {
	await ok(["new", "pool"]); await ok(["pool", "add", "pool"]);
	const lease = (await ok(["acquire", "--holder", "alice"], {}, KEY)).split(" ")[1];
	const reset = run(["release", lease], { BOXERY_FAKE_PAUSE: "reimage" });
	await until(() => existsSync(barrier("pool", "reimage")));
	const old = L.get(db, "pool"); assert.equal(old.state, "RESETTING");
	assert.equal(L.claim(db, "bob", 600, KEY), null);
	release("pool", "reimage"); assert.equal((await reset.result).code, 0);
	await ok(["acquire", "--holder", "bob"], {}, KEY);
	await ok(["edge-set", "pool"], {}, '{"api.example.com":{"headers":{"Authorization":"Bearer next"}}}');
	await ok(["__call", "lease_reset", "pool", String(old.gen), old.epoch]);
	assert.ok(existsSync(path.join(conf, "edge", "pool.json")));
	assert.equal(L.get(db, "pool").state, "LEASED");
	cleanJournal();
});

it("reconcile retries a killed reset immediately rather than waiting for the stale timeout", async () => {
	await ok(["new", "pool"]); await ok(["pool", "add", "pool"]);
	const lease = (await ok(["acquire", "--holder", "alice"], {}, KEY)).split(" ")[1];
	writeFileSync(path.join(vms, "pool", "home", "dirty"), "work");
	const reset = run(["release", lease], { BOXERY_FAKE_PAUSE: "reimage" });
	await until(() => existsSync(barrier("pool", "reimage")));
	const op = operationAt("pool", "reimage"); process.kill(op.owner, "SIGKILL");
	await until(() => O.identity(op.owner) == null);
	await ok(["reconcile"]);
	assert.equal(L.get(db, "pool").state, "FREE");
	assert.equal(existsSync(path.join(vms, "pool", "home", "dirty")), false);
	cleanJournal();
});

it("drift reconciliation fences missing pool VMs but preserves unfamiliar machines and images", async () => {
	await ok(["new", "pool"]); await ok(["pool", "add", "pool"]);
	await ok(["new", "pet"]); await ok(["snap", "pet", "keep"]);
	rmSync(path.join(vms, "pool"), { recursive: true });
	mkdirSync(path.join(vms, "unmanaged"));
	writeFileSync(path.join(vms, "unmanaged", "state"), "running");
	writeFileSync(path.join(vms, "unmanaged", "port"), "22999");
	mkdirSync(path.join(vms, ".images", "unknown@keep"));
	await ok(["reconcile"]);
	assert.equal(L.get(db, "pool").state, "BROKEN");
	assert.equal(token("pool"), undefined);
	assert.ok(existsSync(path.join(vms, "pet")));
	assert.ok(existsSync(path.join(vms, "unmanaged")));
	assert.ok(existsSync(path.join(vms, ".images", "unknown@keep")));
	assert.ok(existsSync(path.join(vms, ".images", "pet@keep")));
	cleanJournal();
});

it("fork resources are deduplicated, sorted, and include all image dependencies", () => {
	assert.deepEqual(O.resources("fork", ["z", "b", "a", "--mem", "1024"]), ["a", "b", "z"]);
	assert.deepEqual(O.resources("new", ["a", "--from", "z@snapshot"]), ["a", "z"]);
	assert.throws(() => O.resources("new", ["a", "--from", "../../bad"]), /invalid image/);
});
