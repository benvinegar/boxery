#!/usr/bin/env node
// OpenSSH-shaped test transport. Remote commands run only inside temporary fake VM roots.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HELPER = fileURLToPath(new URL("./copy-helper.mjs", import.meta.url));
const args = process.argv.slice(2);
let conf, vm;
while (args.length > 1) {
	const flag = args.shift();
	if (flag === "-F") conf = args.shift();
	else if (flag === "-o") args.shift();
	else if (flag.endsWith(".boxery")) vm = flag.slice(0, -7);
}
const host = path.basename(path.dirname(conf ?? ""));
if (!["alpha", "beta", "gamma"].includes(host) || !["vm", "other"].includes(vm)) process.exit(255);
const endpoint = `${host}/${vm}`;
const root = path.join(process.env.COPY_ROOT, "vms", host, vm);
const script = args[0].replaceAll("/home/agent", root).replaceAll("/tmp/.boxery-copy-", `${root}/tmp/.boxery-copy-`);
appendFileSync(process.env.COPY_LOG, JSON.stringify({ kind: "ssh", endpoint, script, pid: process.pid }) + "\n");
if (process.env.COPY_FAIL_CLEANUP === endpoint && script.includes(".cleanup")) {
	process.stderr.write("injected cleanup connection failure\n"); process.exit(255);
}
const preparing = script.includes("mkdir -m 700") && !script.includes("setsid -w") && !script.includes(".cleanup");
if ((preparing && process.env.COPY_HOLD_PREPARE_FD === endpoint) || (script.includes(".cleanup") && process.env.COPY_HOLD_CLEANUP_FD === endpoint)) {
	const helper = spawn(process.execPath, [HELPER, "hold"], { detached: true, stdio: "inherit", env: { ...process.env, COPY_ENDPOINT: endpoint } });
	helper.unref(); process.exit(0);
}
if (preparing && process.env.COPY_LATE_PREPARE === endpoint) {
	const helper = spawn(process.execPath, [HELPER, "late-prepare", script], { detached: true, stdio: "ignore", env: { ...process.env, COPY_ENDPOINT: endpoint } });
	helper.unref(); setInterval(() => {}, 1000);
	await new Promise(() => {}); // the transport is killed at its deadline, not its remote helper
}
if (preparing && process.env.COPY_SLOW_PREPARE === endpoint) await new Promise((r) => setTimeout(r, 200));
const child = spawn("bash", ["-c", script], { env: { ...process.env, COPY_ENDPOINT: endpoint, HOME: root }, cwd: root, stdio: "inherit" });
child.on("error", () => { process.exitCode = 255; });
child.on("close", (code) => { process.exitCode = code ?? 255; });
