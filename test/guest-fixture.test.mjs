// Exercise the macOS guest-lock shim on every platform, with only temporary files/processes.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { guestFixture, lockHeld } from "./helpers/atomic-edit-fixture.mjs";

test("macOS flock shim retains descriptor locks in the parent and supports command locks", { timeout: 5000 }, async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-flock-shim-"));
	const env = guestFixture(dir, { emulateFlock: true }), lock = path.join(dir, "lock");
	const p = spawn("bash", ["-c", 'set -eu; exec 9>"$1"; flock 9; echo ready; read -r release', "fixture", lock], { env, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	p.stderr.on("data", (d) => stderr += d);
	const closed = once(p, "close");
	try {
		await Promise.race([
			once(p.stdout, "data").then(([data]) => assert.equal(data.toString(), "ready\n")),
			closed.then(() => assert.fail(`lock holder exited early: ${stderr}`)),
		]);
		assert.equal(lockHeld(lock), true, "the parent keeps the lock after the flock helper exits");
		p.stdin.end("release\n");
		const [code] = await closed;
		assert.equal(code, 0, stderr);
		assert.equal(lockHeld(lock), false);
		assert.equal(execFileSync("flock", ["-w", "60", lock, "printf", "command-ok"], { env, encoding: "utf8" }), "command-ok");
	} finally {
		if (p.exitCode === null && p.signalCode === null) p.kill();
		await closed;
		rmSync(dir, { recursive: true, force: true });
	}
});
