// Opt-in LIVE test. Requires a configured OpenShell Boxery host using the bundled offline policy.
// Creates/removes one disposable sandbox. No real credentials or public resources are required.
// Usage: node test/openshell-smoke.mjs HOST
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { bashTool, boxeryCli, copyTool, editTool, hostBackend, jobsTool, readTool, screenshot, withHost, writeTool } from "../core/boxery-core.mjs";

const host = process.argv[2];
if (!host) throw new Error("usage: node test/openshell-smoke.mjs HOST (uses the bundled offline policy)");
// Two characters fit even with the longest supported namespace prefix. Creation refuses collisions.
const entropy = randomBytes(2);
const name = "abcdefghijklmnopqrstuvwxyz"[entropy[0] % 26] + "abcdefghijklmnopqrstuvwxyz0123456789"[entropy[1] % 36];
const dir = mkdtempSync(path.join(tmpdir(), "boxery-openshell-smoke-"));
const pass = (message) => console.log(`PASS ${message}`);
try {
	await withHost(host, async () => {
		assert.equal(hostBackend(host), "openshell", "refusing to run against a non-OpenShell host");
		let created = false;
		try {
			await boxeryCli(["new", name, "--headless"]); created = true;
			pass("create and pinned gateway SSH");
			const result = await bashTool(name, { command: 'set -e; test "$(id -u)" != 0; test "$HOME" = /home/agent; test ! -x /usr/bin/sudo; if touch /etc/boxery-smoke-forbidden 2>/dev/null; then exit 1; fi; if curl --max-time 5 -fsS https://example.com >/dev/null 2>&1; then exit 1; fi; echo restricted-ok', timeout: 20 });
			assert.equal(result.isError, false, result.text); assert.match(result.text, /restricted-ok/);
			pass("non-root, protected filesystem and offline egress");
			await writeTool(name, { path: "smoke.txt", content: "alpha\nbeta\n" });
			await editTool(name, { path: "smoke.txt", edits: [{ oldText: "beta", newText: "gamma" }] });
			assert.equal((await readTool(name, { path: "smoke.txt" })).text, "alpha\ngamma\n");
			pass("shared write/edit/read tools");
			const source = path.join(dir, "in.txt"), destination = path.join(dir, "out.txt");
			writeFileSync(source, "copy-roundtrip\n");
			await copyTool({ from: `local:${source}`, to: `${name}:copy.txt` });
			await copyTool({ from: `${name}:copy.txt`, to: `local:${destination}` });
			assert.equal(readFileSync(destination, "utf8"), "copy-roundtrip\n");
			pass("streaming file copy both directions");
			const started = await jobsTool(name, { action: "start", command: "sleep 1; echo job-ok" });
			const job = JSON.parse(started.text).id;
			const waited = await jobsTool(name, { action: "wait", job, timeout: 20 });
			assert.equal(waited.isError, false, waited.text); assert.equal(waited.structured?.exit_code, 0); assert.match(waited.text, /job-ok/);
			pass("background job survives the initiating tool call and completes");
			await boxeryCli(["stop", name]); await boxeryCli(["start", name]);
			assert.equal((await readTool(name, { path: "smoke.txt" })).text, "alpha\ngamma\n");
			pass("stop/start preserves files");
			await assert.rejects(screenshot(name), /headless/);
			for (const args of [["snap", name, "test"], ["fork", name, `${name}-fork`], ["pool", "add", name], ["grant", name, "llm:openai"], ["resize", name, "--cpus", "2"]]) {
				await assert.rejects(boxeryCli(args));
			}
			pass("desktop, snapshots, forks, pool membership, grants and resize refused");
		} finally {
			if (created) {
				await boxeryCli(["rm", name]);
				for (let i = 0; ; i++) {
					const rows = JSON.parse(await boxeryCli(["ls", "--json"]));
					if (!rows.some((r) => r.name === name)) break;
					assert.ok(i < 30, "sandbox deletion did not complete");
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
				pass("delete completed; test sandbox absent from live inventory");
			}
		}
	});
} finally { rmSync(dir, { recursive: true, force: true }); }
