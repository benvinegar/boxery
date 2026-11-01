#!/usr/bin/env node
// Adversarial tar double around the REAL system tar; never buffers the archive.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const role = args[0] === "-cf" ? "source" : "destination";
const endpoint = process.env.COPY_ENDPOINT ?? "local";
const pgid = Number(spawnSync("ps", ["-p", String(process.pid), "-o", "pgid="], { encoding: "utf8" }).stdout.trim());
const note = (data) => appendFileSync(process.env.COPY_LOG, JSON.stringify({ endpoint, role, pgid, ...data }) + "\n");
note({ kind: "tar", pid: process.pid });
if (process.env.COPY_IGNORE_TERM === endpoint && role === "source") {
	process.on("SIGTERM", () => note({ kind: "term", pid: process.pid }));
	setInterval(() => {}, 1000); // force the KILL escalation path, including after its tar child exits
}
if (process.env.COPY_FAIL_DESTINATION === endpoint && role === "destination") {
	process.stderr.write("injected consumer failure\n"); process.exit(9);
}
const child = spawn(process.env.REAL_TAR, args, { stdio: ["inherit", role === "source" ? "pipe" : "ignore", "inherit"] });
note({ kind: "tar-child", pid: child.pid });
const exited = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code) => resolve(code)); });
try {
	if (role === "source") {
		if (process.env.COPY_SLOW_SOURCE === endpoint) {
			const throttle = new Transform({ transform(chunk, _encoding, callback) { setTimeout(() => callback(null, chunk), 10); } });
			await pipeline(child.stdout, throttle, process.stdout);
		} else await pipeline(child.stdout, process.stdout);
	}
	const code = await exited;
	if ((process.env.COPY_ORPHAN_SOURCE === endpoint && role === "source") || (process.env.COPY_ORPHAN_DESTINATION === endpoint && role === "destination")) {
		const helper = spawn(process.execPath, [fileURLToPath(new URL("./copy-helper.mjs", import.meta.url)), "orphan"], {
			stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, COPY_ENDPOINT: endpoint },
		});
		await new Promise((resolve, reject) => { helper.once("message", resolve); helper.once("error", reject); });
		helper.unref(); // no stdout/stderr inheritance; the producer can now close completely
	}
	if (process.env.COPY_FAIL_SOURCE === endpoint && role === "source") {
		// A complete, valid archive has already reached the consumer. Its exit status still matters.
		process.stderr.write("injected producer failure after archive EOF\n"); process.exitCode = 7;
	} else process.exitCode = code ?? 1;
} catch (e) {
	process.stderr.write(`tar fixture: ${e.message}\n`);
	child.kill(); await exited;
	process.exitCode = 1;
}
