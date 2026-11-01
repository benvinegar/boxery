#!/usr/bin/env node
// Short SQLite transactions arbitrate resource locks; no transaction spans a VM operation.
// A supervisor owns every worker process group. A successor kills an abandoned group BEFORE
// replaying its durable intents. Workers wait on fd 3 until their identity is committed.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "./boxery-leases.mjs";

const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const assertName = (n) => { if (!NAME.test(n ?? "")) throw new Error(`invalid VM name: ${n}`); return n; };
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };
// Unlike lease test clocks, process fencing must use the actual machine boot identity.
const BOOT = (() => {
	try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
	catch (e) {
		if (e.code !== "ENOENT") throw e;
		const init = identity(1); // macOS launchd's start time, unaffected by wall-clock adjustments
		if (!init) throw new Error("cannot determine host boot identity");
		return init;
	}
})();

// Linux exposes precise kernel start ticks; macOS uses ps lstart in a fixed locale/timezone.
// Zombies no longer execute side effects. Inspection errors other than "not found" fail closed.
export function identity(pid) {
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
			if (["Z", "X"].includes(fields[0])) return null;
			if (!/^\d+$/.test(fields[19] ?? "")) throw new Error("malformed process start time");
			return `linux:${fields[19]}`;
		} catch (e) {
			if (["ENOENT", "ESRCH"].includes(e.code)) return null;
			throw e;
		}
	}
	const r = spawnSync("ps", ["-p", String(pid), "-o", "stat=", "-o", "lstart="], { encoding: "utf8", env: PS_ENV });
	if (r.error || (r.status !== 0 && r.status !== 1) || (r.status === 1 && r.stderr?.trim())) throw new Error(`cannot inspect process ${pid}`);
	const s = r.stdout?.trim();
	if (r.status !== 0 || !s || s.startsWith("Z")) return null;
	return s.replace(/^\S+\s+/, "");
}
const alive = (r) => r.boot === BOOT && identity(r.owner) === r.owner_start;

export function resources(command, args) {
	let names = [];
	if (["new", "fork"].includes(command)) {
		for (let i = 0; i < args.length; i++) {
			if (["--cpus", "--mem", "--disk"].includes(args[i])) { i++; continue; }
			if (args[i] === "--from") {
				const image = args[++i];
				if (!/^[a-z][a-z0-9-]{0,30}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(image ?? "")) throw new Error("invalid image name");
				names.push(image.split("@")[0]);
			} else if (args[i].startsWith("-")) throw new Error(`unknown flag ${args[i]}`);
			else names.push(assertName(args[i]));
		}
	} else if (command === "pool") {
		if (["add", "rm"].includes(args[0])) names = [assertName(args[1])];
	} else if (["start", "stop", "resize", "rm", "delete", "snap", "snap-rm", "revert", "edge-set"].includes(command)) names = [assertName(args[0])];
	return [...new Set(names)].sort();
}

function transaction(db, fn) {
	db.exec("BEGIN IMMEDIATE");
	try { const r = fn(); db.exec("COMMIT"); return r; }
	catch (e) { db.exec("ROLLBACK"); throw e; }
}
const row = (db, id) => db.prepare("SELECT * FROM operations WHERE id=?").get(id);
const actions = (db, id) => db.prepare("SELECT id, kind, data FROM operation_intents WHERE operation_id=? ORDER BY seq DESC").all(id).map((r) => ({ ...r, data: JSON.parse(r.data) }));

function stopAbandoned(r) {
	if (!r.child || r.boot !== BOOT) return;
	const current = identity(r.child);
	if (current && current !== r.child_start) return; // reused PID, not our worker
	try { process.kill(-r.child, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
	// A killed leader may leave descendants behind; don't release the resource until all
	// non-zombie group members have exited. A timeout fails closed, retaining the journal.
	for (let i = 0; i < 100; i++) {
		const p = spawnSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8", env: PS_ENV });
		if (p.status !== 0) throw new Error("cannot inspect abandoned worker process group");
		if (!p.stdout.split("\n").some((s) => { const [g, st] = s.trim().split(/\s+/); return Number(g) === r.child && st && !st.startsWith("Z"); })) return;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	}
	throw new Error(`worker group ${r.child} did not stop; recovery deferred`);
}

async function worker(db, op, host, args, recovery = false) {
	const env = { ...process.env, BOXERY_OPERATION_ID: op.id, BOXERY_LOCKS: `:${JSON.parse(op.resources).join(":")}:` };
	for (const [key, value] of Object.entries(JSON.parse(op.env))) {
		if (value == null) delete env[key];
		else env[key] = value;
	}
	const child = spawn("bash", ["-c", 'IFS= read -r gate <&3 || exit 1; exec "$@"', "boxery-worker", host, ...args], {
		env, detached: true, stdio: [recovery ? "ignore" : "inherit", "inherit", "inherit", "pipe"],
	});
	// Install listeners before opening the gate (a fast child may exit immediately).
	const ended = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
	});
	child.stdio[3].on("error", () => {});
	const start = identity(child.pid);
	if (!start) { child.stdio[3].end(); await ended; throw new Error("worker exited before registration"); }
	db.prepare("UPDATE operations SET child=?, child_start=? WHERE id=?").run(child.pid, start, op.id);
	child.stdio[3].end("go\n");
	const forward = (signal) => { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; } };
	const term = () => forward("SIGTERM"), interrupt = () => forward("SIGINT");
	process.on("SIGTERM", term); process.on("SIGINT", interrupt);
	try { return await ended; }
	finally {
		process.off("SIGTERM", term); process.off("SIGINT", interrupt);
		// Never leave background backend commands running after a worker exits.
		stopAbandoned({ ...op, child: child.pid, child_start: start });
		db.prepare("UPDATE operations SET child=NULL, child_start=NULL WHERE id=?").run(op.id);
	}
}

function finish(db, id, conf) {
	// Keep the journal until temporary seed/work files are gone too.
	rmSync(path.join(conf, "work", id), { recursive: true, force: true });
	transaction(db, () => {
		db.prepare("DELETE FROM operation_locks WHERE operation_id=?").run(id);
		db.prepare("DELETE FROM operation_intents WHERE operation_id=?").run(id);
		db.prepare("DELETE FROM operations WHERE id=?").run(id);
	});
}
async function recover(db, op, host, conf) {
	if (actions(db, op.id).length) {
		process.stderr.write(`==> recovering abandoned ${op.command} (${op.id})\n`);
		if (await worker(db, op, host, ["__recover"], true) !== 0 || actions(db, op.id).length) throw new Error(`recovery failed for ${op.id}; journal retained`);
	}
	finish(db, op.id, conf);
}

// Claim all resources atomically, including fork source/destinations and image readers.
// Recovery takes ownership of the OLD operation and its complete lock set before doing work.
async function acquire(db, wanted, command, env, host, conf, reconcile = false) {
	const owner = process.pid, ownerStart = identity(owner);
	for (;;) {
		const result = transaction(db, () => {
			const rows = db.prepare("SELECT * FROM operations ORDER BY created_at, id").all();
			const conflicts = reconcile ? rows : rows.filter((r) => JSON.parse(r.resources).some((n) => wanted.includes(n)));
			const abandoned = conflicts.find((r) => !alive(r));
			if (abandoned) {
				stopAbandoned(abandoned);
				db.prepare("UPDATE operations SET owner=?, owner_start=?, boot=?, child=NULL, child_start=NULL WHERE id=?").run(owner, ownerStart, BOOT, abandoned.id);
				return { recovery: row(db, abandoned.id) };
			}
			if (reconcile) return { done: true }; // leave live operations alone
			if (conflicts.length) return {};
			const id = randomUUID();
			db.prepare("INSERT INTO operations(id, command, resources, env, owner, owner_start, boot, created_at) VALUES(?,?,?,?,?,?,?,?)")
				.run(id, command, JSON.stringify(wanted), JSON.stringify(env), owner, ownerStart, BOOT, Date.now());
			for (const n of wanted) db.prepare("INSERT INTO operation_locks(resource, operation_id) VALUES(?,?)").run(n, id);
			return { operation: row(db, id) };
		});
		if (result.recovery) { await recover(db, result.recovery, host, conf); continue; }
		if (result.done) return null;
		if (result.operation) return result.operation;
		await sleep(50);
	}
}

// Persist only backend routing settings, never arbitrary environment variables or credentials.
const SETTINGS = ["BOXERY_BACKEND", "BOXERY_POOL", "BOXERY_POOL_DIR", "BOXERY_BASE_VOL", "BOXERY_DOMAIN_PREFIX", "BOXERY_NET", "LIBVIRT_DEFAULT_URI", "LIMA_HOME", "BOXERY_LIMA_PREFIX", "BOXERY_LIMA_GATEWAY", "BOXERY_LIMA_VMTYPE", "BOXERY_LIMA_ARCH", "BOXERY_CH_DIR", "BOXERY_CH_NET", "BOXERY_CH_DNS", "BOXERY_CH_FIRMWARE", "BOXERY_CH_SUDO", "BOXERY_FAKE_DIR", "BOXERY_PROXY_PORT"];
async function main() {
	const [mode, confArg, ...args] = process.argv.slice(2);
	const conf = path.resolve(confArg);
	mkdirSync(conf, { recursive: true, mode: 0o700 });
	const db = open(path.join(conf, "leases.db"));
	const id = process.env.BOXERY_OPERATION_ID;
	if (mode === "token") {
		transaction(db, () => {
			const file = path.join(conf, "tokens.json");
			let tokens;
			try { tokens = JSON.parse(readFileSync(file, "utf8")); }
			catch (e) { if (e.code !== "ENOENT") throw e; tokens = {}; }
			assertName(args[1]);
			if (args[0] === "set") tokens[args[1]] = args[2];
			else if (args[0] === "del") delete tokens[args[1]];
			else throw new Error("unknown token operation");
			const tmp = `${file}.tmp`;
			writeFileSync(tmp, JSON.stringify(tokens), { mode: 0o600 });
			renameSync(tmp, file);
		});
		return;
	}
	if (mode === "intent") {
		const [kind, ...data] = args;
		const op = row(db, id);
		if (!op || !alive(op)) throw new Error("operation no longer owns its locks");
		const actionId = randomUUID();
		db.prepare("INSERT INTO operation_intents(id, operation_id, kind, data) VALUES(?,?,?,?)").run(actionId, id, kind, JSON.stringify(data));
		console.log(actionId); return;
	}
	if (mode === "done") { db.prepare("DELETE FROM operation_intents WHERE id=? AND operation_id=?").run(args[0], id); return; }
	if (mode === "intents") { console.log(JSON.stringify(actions(db, id))); return; }
	const env = { BOXERY_CONF: conf, ...Object.fromEntries(SETTINGS.map((k) => [k, process.env[k] ?? null])) };
	if (mode === "reconcile") { await acquire(db, [], "reconcile", env, args[0], conf, true); return; }
	let names, host, command, childArgs;
	if (mode === "dispatch") {
		[host, command] = args;
		childArgs = ["__dispatch", command, ...args.slice(2)];
		names = resources(command, args.slice(2));
	} else if (mode === "run") {
		const name = assertName(args[0]); host = args[1]; command = args[2];
		names = [name]; childArgs = ["__call", ...args.slice(2)];
	} else throw new Error(`unknown operation mode: ${mode}`);
	const op = await acquire(db, names, command, env, host, conf);
	const rc = await worker(db, op, host, childArgs);
	// Success must have committed every intent. On failure, compensate under the same locks.
	if (actions(db, op.id).length) {
		await recover(db, op, host, conf);
		process.exitCode = rc || 1; // a compensated operation did not complete successfully
	} else {
		finish(db, op.id, conf);
		process.exitCode = rc;
	}
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main().catch((e) => { console.error(`boxery-operations: ${e.message}`); process.exitCode = 1; });
