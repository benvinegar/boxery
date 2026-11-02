// Isolated streaming transfers using real tar and temporary fake SSH endpoints. No real VMs.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test as nodeTest } from "node:test";
const test = (name, fn) => nodeTest(name, { timeout: 45_000 }, fn);
import { q } from "../core/shell.mjs";

/** @typedef {import("node:child_process").ChildProcess & { stdout: import("node:stream").Readable, stderr: import("node:stream").Readable, result: Promise<any> }} WorkerChild */

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
let dir, env, children;
const vmroot = (host = "alpha", vm = "vm") => path.join(dir, "vms", host, vm);
const project = (host = "alpha", vm = "vm") => path.join(vmroot(host, vm), "project");
const profile = (host) => path.join(dir, "home", "profiles", host);
const logs = () => readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
	for (let i = 0; i < 400; i++) { if (fn()) return; await pause(25); }
	throw new Error("timed out waiting for streaming copy");
}
function alive(pid) {
	try {
		process.kill(pid, 0);
		return !execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim().startsWith("Z");
	} catch { return false; }
}
function worker(from, to, extra = {}, settings = {}) {
	const child = /** @type {WorkerChild} */ (spawn(process.execPath, [path.join(FIXTURES, "copy-worker.mjs"), from, to, JSON.stringify(settings)], {
		env: { ...env, ...extra }, cwd: dir, stdio: ["ignore", "pipe", "pipe", "ipc"],
	}));
	children.push(child);
	let out = "", err = "", inspection;
	child.on("message", (message) => { inspection = message; });
	const deadline = setTimeout(() => { if (child.connected) child.send("inspect"); }, 25_000);
	const hardDeadline = setTimeout(() => {
		const pids = [...new Set([child.pid, ...logs().flatMap((r) => [r.pid, r.pgid]).filter(Boolean)])];
		let processes = "";
		try { processes = execFileSync("ps", ["-p", pids.join(","), "-o", "pid=,ppid=,pgid=,stat=,args="], { encoding: "utf8" }); } catch {}
		err += `\nTimed out. Handles: ${JSON.stringify(inspection)}\n${processes}\nEvents: ${JSON.stringify(logs())}`;
		child.kill("SIGKILL");
	}, 30_000);
	child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
	child.result = new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", () => {
			clearTimeout(deadline); clearTimeout(hardDeadline);
			try { resolve({ ...JSON.parse(out), ...(err.includes("Timed out") ? { inspection, debug: err } : {}) }); }
			catch { reject(new Error(`copy worker produced no result: ${err} ${out}`)); }
		});
	});
	return child;
}
async function copy(from, to, extra) {
	const result = await worker(from, to, extra).result;
	assert.equal(result.ok, true, result.error);
	return result;
}
function noStages() {
	const staged = /** @type {string[]} */ (readdirSync(dir, { recursive: true })).filter((p) => path.basename(p).startsWith(".boxery-copy-"));
	assert.deepEqual(staged, [], `staging directories remain: ${staged}`);
}
async function noTarJobs() {
	const pids = logs().filter((r) => ["tar", "tar-child", "orphan"].includes(r.kind)).map((r) => r.pid);
	await until(() => pids.every((pid) => !alive(pid)));
}
function largeFile(file, mib = 192) {
	const fd = openSync(file, "w");
	try {
		// BSD tar automatically encodes sparse holes. Write real nonzero blocks so every
		// platform must actually stream the full archive, not a tiny sparse-file descriptor.
		const block = randomBytes(64 * 1024);
		const size = mib * 1024 * 1024;
		for (let at = 0; at < size; at += block.length) writeSync(fd, block, 0, block.length, at);
		const tail = Buffer.from("stream-tail");
		writeSync(fd, tail, 0, tail.length, size - tail.length);
	} finally { closeSync(fd); }
}
async function digest(file) {
	const hash = createHash("sha256");
	for await (const data of createReadStream(file)) hash.update(data);
	return hash.digest("hex");
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "boxery-copy-")); children = [];
	mkdirSync(path.join(dir, "bin")); mkdirSync(path.join(dir, "home", "host-registry"), { recursive: true });
	writeFileSync(path.join(dir, "calls"), "");
	for (const host of ["alpha", "beta", "gamma"]) {
		mkdirSync(profile(host), { recursive: true });
		writeFileSync(path.join(profile(host), "config"), "# fake\n");
		writeFileSync(path.join(profile(host), "ssh_config"), "# fake\n");
		writeFileSync(path.join(dir, "home", "host-registry", host), `${profile(host)}\n`);
		for (const vm of ["vm", "other"]) {
			mkdirSync(path.join(vmroot(host, vm), "project"), { recursive: true });
			mkdirSync(path.join(vmroot(host, vm), "tmp"));
		}
	}
	writeFileSync(path.join(dir, "home", "default-host"), "alpha\n");
	for (const [bin, script] of [["ssh", "copy-ssh.mjs"], ["tar", "copy-tar.mjs"]]) {
		writeFileSync(path.join(dir, "bin", bin), `#!/usr/bin/env bash\nexec ${q(process.execPath)} ${q(path.join(FIXTURES, script))} "$@"\n`, { mode: 0o755 });
	}
	if (process.env.COPY_TEST_SH) writeFileSync(path.join(dir, "bin", "sh"), `#!/usr/bin/env bash\nexec ${q(process.env.COPY_TEST_SH)} "$@"\n`, { mode: 0o755 });
	// macOS has no setsid; emulate a new group with the same PID, as in existing MCP tests.
	writeFileSync(path.join(dir, "bin", "setsid"), "#!/usr/bin/env bash\n[ \"$1\" != -w ] || shift\nexec perl -e 'setpgrp(0,0); exec @ARGV or die' -- \"$@\"\n", { mode: 0o755 });
	env = { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, BOXERY_HOME: path.join(dir, "home"), COPY_ROOT: dir, COPY_LOG: path.join(dir, "calls"), REAL_TAR: process.env.COPY_TEST_TAR ?? execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim() };
});
afterEach(async () => {
	for (const child of children) {
		if (child.exitCode == null && child.signalCode == null) {
			if (child.connected) child.send("abort");
			await Promise.race([child.result.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 20_000).unref())]);
			child.kill("SIGKILL");
		}
	}
	// Fault tests deliberately create TERM-ignoring jobs. If an assertion fails, do not
	// leave those jobs behind while diagnosing it; only signal our still-running fixture.
	for (const record of logs().filter((r) => ["tar", "orphan", "metadata-holder", "late-prepare"].includes(r.kind) && r.pgid > 1 && alive(r.pid))) {
		let command;
		try { command = execFileSync("ps", ["-p", String(record.pid), "-o", "args="], { encoding: "utf8" }); }
		catch { continue; } // it exited between the liveness check and inspection
		if (["copy-tar.mjs", "copy-helper.mjs"].some((file) => command.includes(path.join(FIXTURES, file)))) {
			try { process.kill(-record.pgid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
		}
	}
	const writableDirectories = (directory) => {
		chmodSync(directory, 0o700);
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) writableDirectories(path.join(directory, entry.name));
		}
	};
	writableDirectories(dir);
	rmSync(dir, { recursive: true, force: true });
});

test("local ↔ VM, same-host VM ↔ VM, cross-host, and local ↔ local preserve destination semantics", async () => {
	const source = path.join(dir, "source folder"); mkdirSync(source);
	writeFileSync(path.join(source, "script's $file\n.txt"), "contents\n", { mode: 0o755 });
	symlinkSync("script's $file\n.txt", path.join(source, "link"));
	await copy(`local:${source}`, "alpha/vm:uploaded");
	assert.equal(readFileSync(path.join(project(), "uploaded", "script's $file\n.txt"), "utf8"), "contents\n");
	assert.equal(readlinkSync(path.join(project(), "uploaded", "link")), "script's $file\n.txt");
	assert.equal(statSync(path.join(project(), "uploaded", "script's $file\n.txt")).mode & 0o777, 0o755);
	await copy("alpha/vm:uploaded", "alpha/other:renamed");
	await copy("alpha/other:renamed", "beta/vm:received");
	const local = path.join(dir, "downloaded");
	await copy("beta/vm:received", `local:${local}`);
	assert.equal(readFileSync(path.join(local, "script's $file\n.txt"), "utf8"), "contents\n");
	const existing = path.join(dir, "existing"); mkdirSync(existing, { mode: 0o700 });
	writeFileSync(path.join(existing, "keep"), "keep");
	await copy(`local:${local}`, `local:${existing}`);
	assert.equal(readFileSync(path.join(existing, "downloaded", "script's $file\n.txt"), "utf8"), "contents\n");
	assert.equal(readFileSync(path.join(existing, "keep"), "utf8"), "keep");
	assert.equal(statSync(existing).mode & 0o777, 0o700, "do not copy staging-root permissions onto an existing directory");
	const remoteDirectory = path.join(project("beta"), "private"); mkdirSync(remoteDirectory, { mode: 0o700 });
	await copy(`local:${path.join(local, "script's $file\n.txt")}`, "beta/vm:private");
	assert.equal(readFileSync(path.join(remoteDirectory, "script's $file\n.txt"), "utf8"), "contents\n");
	assert.equal(statSync(remoteDirectory).mode & 0o777, 0o700);
	const renamed = path.join(dir, "overwrite's.txt"); writeFileSync(renamed, "old");
	await copy(`local:${path.join(local, "script's $file\n.txt")}`, `local:${renamed}`);
	assert.equal(readFileSync(renamed, "utf8"), "contents\n");
	noStages();
});

test("writable existing destinations do not require write access to their parents", async () => {
	const source = path.join(dir, "source"); writeFileSync(source, "data");
	const parent = path.join(dir, "readonly-parent"), destination = path.join(parent, "writable");
	mkdirSync(destination, { recursive: true, mode: 0o700 }); chmodSync(parent, 0o555);
	await copy(`local:${source}`, `local:${destination}`);
	assert.equal(readFileSync(path.join(destination, "source"), "utf8"), "data");
	assert.equal(statSync(parent).mode & 0o777, 0o555);
	const vmParent = path.dirname(vmroot()); chmodSync(vmParent, 0o555);
	await copy(`local:${source}`, "alpha/vm:~"); // like /home/agent with a root-owned /home
	assert.equal(readFileSync(path.join(vmroot(), "source"), "utf8"), "data");
	assert.equal(statSync(vmParent).mode & 0o777, 0o555);
	noStages();
});

test("read-only trees clean up on success and producer failure without changing symlink targets", async () => {
	const outside = path.join(dir, "outside"); mkdirSync(outside); chmodSync(outside, 0o555);
	const tree = (name) => {
		mkdirSync(name); writeFileSync(path.join(name, "file"), "data", { mode: 0o400 });
		mkdirSync(path.join(name, "nested")); writeFileSync(path.join(name, "nested", "child"), "child");
		chmodSync(path.join(name, "nested"), 0o555);
		symlinkSync(outside, path.join(name, "external")); chmodSync(name, 0o555);
		return name;
	};
	const localTree = tree(path.join(dir, "readonly"));
	const remoteTree = tree(path.join(project(), "readonly"));
	for (const [from, to, output] of [
		[`local:${localTree}`, `local:${path.join(dir, "local-result")}`, path.join(dir, "local-result")],
		[`local:${localTree}`, "beta/vm:remote-result", path.join(project("beta"), "remote-result")],
		["alpha/vm:readonly", `local:${path.join(dir, "download-result")}`, path.join(dir, "download-result")],
	]) {
		mkdirSync(output);
		await copy(from, to);
		assert.equal(readFileSync(path.join(output, "readonly", "file"), "utf8"), "data");
		assert.equal(statSync(path.join(output, "readonly")).mode & 0o777, 0o555);
		assert.equal(statSync(path.join(output, "readonly", "nested")).mode & 0o777, 0o555);
		assert.equal(statSync(outside).mode & 0o777, 0o555, "cleanup must not follow archived symlinks");
		noStages();
	}
	const failed = await worker(`local:${localTree}`, "beta/vm:failed-readonly", { COPY_FAIL_SOURCE: "local" }).result;
	assert.equal(failed.ok, false);
	assert.match(failed.error, /injected producer failure/);
	assert.doesNotMatch(failed.error, /Cleanup incomplete/);
	assert.equal(existsSync(path.join(project("beta"), "failed-readonly")), false);
	assert.equal(statSync(localTree).mode & 0o777, 0o555);
	assert.equal(statSync(remoteTree).mode & 0o777, 0o555);
	assert.equal(statSync(outside).mode & 0o777, 0o555);
	noStages(); await noTarJobs();
});

test("large transfers exceed the old 64 MiB capture limit with bounded agent buffers", async () => {
	const source = path.join(dir, "large.bin"); largeFile(source);
	const expected = await digest(source);
	const results = [
		await copy(`local:${source}`, "alpha/vm:large.bin"),
		await copy("alpha/vm:large.bin", "beta/vm:large.bin"),
		await copy("beta/vm:large.bin", `local:${path.join(dir, "returned.bin")}`),
	];
	for (const result of results) {
		assert.ok(Number(result.text.match(/\((\d+) bytes tar\)/)[1]) > 192 * 1024 * 1024);
		assert.ok(result.peakBuffers < 64 * 1024 * 1024, `archive-sized agent buffers: ${JSON.stringify(result)}`);
	}
	assert.equal(await digest(path.join(dir, "returned.bin")), expected);
	noStages();
});

test("a valid archive followed by producer failure never replaces the destination", async () => {
	writeFileSync(path.join(project(), "source"), "new data");
	const destination = path.join(dir, "destination"); writeFileSync(destination, "keep old data");
	const result = await worker("alpha/vm:source", `local:${destination}`, { COPY_FAIL_SOURCE: "alpha/vm" }).result;
	assert.equal(result.ok, false);
	assert.match(result.error, /injected producer failure/);
	assert.equal(readFileSync(destination, "utf8"), "keep old data");
	noStages(); await noTarJobs();
});

test("local producer failure cannot publish a complete archive into a VM", async () => {
	const source = path.join(dir, "source"); writeFileSync(source, "new data");
	const destination = path.join(project("beta"), "destination"); writeFileSync(destination, "old data");
	const result = await worker(`local:${source}`, "beta/vm:destination", { COPY_FAIL_SOURCE: "local" }).result;
	assert.equal(result.ok, false);
	assert.match(result.error, /injected producer failure/);
	assert.equal(readFileSync(destination, "utf8"), "old data");
	noStages(); await noTarJobs();
});

test("local extractor failure stops the remote producer and removes local staging", async () => {
	largeFile(path.join(project(), "source"), 32);
	const destination = path.join(dir, "destination"); writeFileSync(destination, "old data");
	const result = await worker("alpha/vm:source", `local:${destination}`, { COPY_FAIL_DESTINATION: "local", COPY_SLOW_SOURCE: "alpha/vm" }).result;
	assert.equal(result.ok, false);
	assert.match(result.error, /injected consumer failure/);
	assert.equal(readFileSync(destination, "utf8"), "old data");
	noStages(); await noTarJobs();
});

test("leading-dash and shell-hostile source/destination names remain literal", async () => {
	const name = "-$(touch pwned); 'quoted\\n.txt";
	const source = path.join(dir, name); writeFileSync(source, "literal");
	await copy(`local:${source}`, "beta/vm:folder's\\nname/renamed");
	assert.equal(readFileSync(path.join(project("beta"), "folder's\\nname", "renamed"), "utf8"), "literal");
	assert.equal(existsSync(path.join(dir, "pwned")), false);
	noStages();
});

test("consumer failure stops a streaming producer and cleans remote staging", async () => {
	largeFile(path.join(project(), "source"), 32);
	const result = await worker("alpha/vm:source", "beta/vm:destination", { COPY_FAIL_DESTINATION: "beta/vm", COPY_SLOW_SOURCE: "alpha/vm" }).result;
	assert.equal(result.ok, false);
	assert.match(result.error, /injected consumer failure/);
	assert.equal(existsSync(path.join(project("beta"), "destination")), false);
	noStages(); await noTarJobs();
});

for (const [from, to, sourceEndpoint] of [
	["local", "local", "local"],
	["local", "alpha/vm", "local"],
	["alpha/vm", "local", "alpha/vm"],
	["alpha/vm", "beta/vm", "alpha/vm"],
]) {
	test(`cancellation stops both sides and cleans staging: ${from} → ${to}`, async () => {
		const local = path.join(dir, "source"); largeFile(local, 32);
		largeFile(path.join(project(), "source"), 32);
		const source = from === "local" ? `local:${local}` : `${from}:source`;
		const destination = to === "local" ? `local:${path.join(dir, "destination")}` : `${to}:destination`;
		const child = worker(source, destination, { COPY_SLOW_SOURCE: sourceEndpoint, COPY_IGNORE_TERM: sourceEndpoint });
		await until(() => logs().filter((r) => r.kind === "tar").length >= 2);
		child.send("abort");
		const result = await child.result;
		assert.equal(result.ok, false);
		assert.equal(result.name, "AbortError", JSON.stringify(result));
		assert.ok(logs().some((r) => r.kind === "term" && r.endpoint === sourceEndpoint), "exercise TERM-ignoring source and KILL escalation");
		noStages(); await noTarJobs();
	});
}

test("group EPERM during cancellation falls back to owned members without skipping cleanup", async () => {
	const source = path.join(dir, "source"); largeFile(source, 32);
	const child = worker(`local:${source}`, `local:${path.join(dir, "destination")}`, { COPY_SLOW_SOURCE: "local", COPY_IGNORE_TERM: "local" }, { groupEperm: true });
	await until(() => logs().filter((r) => r.kind === "tar").length >= 2);
	child.send("abort");
	const result = await child.result;
	assert.equal(result.name, "AbortError", JSON.stringify(result));
	assert.doesNotMatch(result.error, /Cleanup incomplete/);
	noStages(); await noTarJobs();
});

test("closed producer leaders do not leave descriptor-free TERM-ignoring descendants", async () => {
	const source = path.join(dir, "source"); writeFileSync(source, "data");
	await copy(`local:${source}`, `local:${path.join(dir, "destination")}`, { COPY_ORPHAN_SOURCE: "local" });
	assert.ok(logs().some((r) => r.kind === "orphan"));
	assert.ok(logs().some((r) => r.kind === "orphan-term"), "exercise escalation after the leader closed");
	noStages(); await noTarJobs();
});

for (const fail of [false, true]) {
	test(`remote closed-leader producer descendants are stopped (failure=${fail})`, async () => {
		writeFileSync(path.join(project(), "source"), "data");
		const destination = path.join(dir, "destination"); writeFileSync(destination, "old");
		const result = await worker("alpha/vm:source", `local:${destination}`, {
			COPY_ORPHAN_SOURCE: "alpha/vm", ...(fail ? { COPY_FAIL_SOURCE: "alpha/vm" } : {}),
		}).result;
		assert.equal(result.ok, !fail, result.error);
		assert.equal(readFileSync(destination, "utf8"), fail ? "old" : "data");
		assert.ok(logs().some((r) => r.kind === "orphan-term"));
		noStages(); await noTarJobs();
	});
}

test("remote escalation keeps cleanup witnesses when a dying leader cannot refresh its snapshot", async () => {
	writeFileSync(path.join(dir, "no-exit-trap.sh"), 'trap() { if [ "$2" = EXIT ]; then return 0; fi; builtin trap "$@"; }\n');
	writeFileSync(path.join(project(), "source"), Buffer.alloc(8 * 1024 * 1024, 42));
	const child = worker("alpha/vm:source", `local:${path.join(dir, "destination")}`, {
		COPY_SKIP_EXIT_SNAPSHOT: "alpha/vm", COPY_SLOW_SOURCE: "alpha/vm", COPY_IGNORE_TERM: "alpha/vm",
	});
	await until(() => logs().filter((r) => r.kind === "tar").length >= 2);
	await new Promise((resolve) => setTimeout(resolve, 100));
	child.send("abort");
	const result = await child.result;
	assert.equal(result.name, "AbortError", JSON.stringify(result));
	assert.doesNotMatch(result.error, /Cleanup incomplete/);
	assert.ok(logs().some((r) => r.kind === "term" && r.endpoint === "alpha/vm"));
	noStages(); await noTarJobs();
});

test("remote extractor identities survive replacement by the subsequent publish worker", async () => {
	const source = path.join(dir, "source"); writeFileSync(source, "data");
	const destination = path.join(project("beta"), "existing"); mkdirSync(destination);
	await copy(`local:${source}`, "beta/vm:existing", { COPY_ORPHAN_DESTINATION: "beta/vm" });
	assert.equal(readFileSync(path.join(destination, "source"), "utf8"), "data");
	assert.ok(logs().some((r) => r.kind === "orphan-term"));
	noStages(); await noTarJobs();
});

for (const abort of [false, true]) {
	test(`metadata completion is bounded when a detached helper holds stdio (abort=${abort})`, async () => {
		writeFileSync(path.join(project(), "source"), "data");
		const started = Date.now();
		const child = worker("alpha/vm:source", `local:${path.join(dir, "destination")}`, { COPY_HOLD_PREPARE_FD: "alpha/vm" }, { metadataTimeoutMs: 1000 });
		await until(() => logs().some((r) => r.kind === "metadata-holder"));
		if (abort) child.send("abort");
		const result = await child.result;
		assert.equal(result.ok, false);
		assert.match(result.error, /Cleanup incomplete/);
		if (!abort) assert.match(result.error, /timed out/);
		assert.ok(Date.now() - started < 5000, JSON.stringify(result));
		assert.ok(logs().some((r) => r.kind === "metadata-holder" && alive(r.pid)), "helper still holds its descriptors, but cannot block completion");
		noStages();
	});
}

test("cleanup deadlines do not wait indefinitely for an escaped descriptor holder", async () => {
	writeFileSync(path.join(project(), "source"), "data");
	const destination = path.join(dir, "destination"), started = Date.now();
	const result = await worker("alpha/vm:source", `local:${destination}`, { COPY_HOLD_CLEANUP_FD: "alpha/vm" }, { metadataTimeoutMs: 1000, cleanupTimeoutMs: 1000 }).result;
	assert.equal(result.ok, false);
	assert.match(result.error, /Cleanup incomplete/);
	assert.match(result.error, /cleanup alpha\/vm: timed out/);
	assert.ok(Date.now() - started < 5000, JSON.stringify(result));
	assert.equal(readFileSync(destination, "utf8"), "data", "publication can precede a cleanup failure");
	assert.ok(logs().some((r) => r.kind === "metadata-holder" && alive(r.pid)));
	await noTarJobs();
});

test("timed-out remote preparation reports unverified cleanup even before late mkdir", async () => {
	writeFileSync(path.join(project(), "source"), "data");
	const result = await worker("alpha/vm:source", `local:${path.join(dir, "destination")}`, { COPY_LATE_PREPARE: "alpha/vm" }, { metadataTimeoutMs: 1000 }).result;
	assert.equal(result.ok, false);
	assert.match(result.error, /Cleanup incomplete/);
	assert.match(result.error, /late staging may remain/);
	assert.ok(!logs().some((r) => r.kind === "tar"));
	await until(() => logs().some((r) => r.kind === "late-prepare-finished"));
	assert.ok(readdirSync(dir, { recursive: true }).some((p) => path.basename(p).startsWith(".boxery-copy-")), "late remote work is explicitly reported, never claimed clean");
});

test("copy cleanup remains pinned after profile/default changes during a transfer", async () => {
	largeFile(path.join(project(), "source"), 32);
	const child = worker("alpha/vm:source", "beta/vm:destination", { COPY_SLOW_SOURCE: "alpha/vm" });
	await until(() => logs().filter((r) => r.kind === "tar").length >= 2);
	writeFileSync(path.join(dir, "home", "host-registry", "beta"), `${profile("gamma")}\n`);
	writeFileSync(path.join(dir, "home", "default-host"), "gamma\n");
	child.send("abort");
	const result = await child.result;
	assert.equal(result.name, "AbortError", JSON.stringify(result));
	const cleanupHosts = logs().filter((r) => r.kind === "ssh" && r.script.includes('for record in "$t"/pgid.')).map((r) => r.endpoint);
	assert.deepEqual(cleanupHosts.sort(), ["alpha/vm", "beta/vm"]);
	noStages(); await noTarJobs();
});

test("abort during remote preparation waits for setup, then cleans without launching tar", async () => {
	writeFileSync(path.join(project(), "source"), "data");
	const child = worker("alpha/vm:source", `local:${path.join(dir, "destination")}`, { COPY_SLOW_PREPARE: "alpha/vm" });
	await until(() => logs().some((r) => r.kind === "ssh"));
	child.send("abort");
	assert.equal((await child.result).name, "AbortError");
	assert.ok(!logs().some((r) => r.kind === "tar"));
	noStages();
});

test("pre-aborted and unknown-host calls have no endpoint side effects", async () => {
	writeFileSync(path.join(dir, "source"), "data");
	const first = await worker(`local:${path.join(dir, "source")}`, "alpha/vm:destination", {}, { preabort: true }).result;
	assert.equal(first.name, "AbortError");
	const second = await worker(`local:${path.join(dir, "source")}`, "unknown/vm:destination").result;
	assert.equal(second.ok, false);
	const root = await worker("local:/", "alpha/vm:destination").result;
	assert.equal(root.ok, false);
	assert.match(root.error, /filesystem root/);
	assert.deepEqual(logs(), []);
	noStages();
});

test("missing sources clean staging and do not create the requested destination", async () => {
	for (const source of [`local:${path.join(dir, "missing")}`, "alpha/vm:missing"]) {
		const result = await worker(source, "beta/vm:destination").result;
		assert.equal(result.ok, false);
		assert.equal(existsSync(path.join(project("beta"), "destination")), false);
		noStages();
	}
});

test("copying into the source tree excludes private staging rather than recursing", async () => {
	const source = path.join(dir, "source"); mkdirSync(source); writeFileSync(path.join(source, "file"), "data");
	await copy(`local:${source}`, `local:${path.join(source, "child")}`);
	assert.equal(readFileSync(path.join(source, "child", "file"), "utf8"), "data");
	assert.deepEqual(readdirSync(path.join(source, "child")), ["file"]);
	noStages();
});

test("unreachable cleanup is reported rather than silently claiming a clean transfer", async () => {
	writeFileSync(path.join(dir, "source"), "data");
	const result = await worker(`local:${path.join(dir, "source")}`, "beta/vm:destination", { COPY_FAIL_CLEANUP: "beta/vm" }).result;
	assert.equal(result.ok, false);
	assert.match(result.error, /Cleanup incomplete/);
	assert.match(result.error, /beta\/vm/);
	await noTarJobs();
});
