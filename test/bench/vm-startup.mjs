#!/usr/bin/env node
// Real libvirt cold boots and warm leases. Requires an initialized host + existing desktop base.
// node test/bench/vm-startup.mjs [ROUNDS=3] [new flags…] >results.jsonl
// Each VM is removed before the next boot. No shared network/base changes; private state + prefix.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HOST_ENV, loadConfig, ROOT } from "../../host/config.mjs";

const rounds = Number(process.argv[2] ?? 3), flags = process.argv.slice(3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error("ROUNDS must be 1–100");
// Keep names and source images out of the caller's namespace. Only sizing flags are accepted.
for (let i = 0; i < flags.length; i += 2) {
	if (!["--shape", "--cpus", "--mem", "--disk"].includes(flags[i]) || !flags[i + 1] || flags[i + 1].startsWith("-")) {
		throw new Error("only --shape, --cpus, --mem and --disk are supported");
	}
}
const config = loadConfig();
if (config.backend !== "libvirt") throw new Error("this benchmark currently supports libvirt only");
const key = readFileSync(path.join(config.conf, "mgmt_ed25519.pub"), "utf8");
const conf = mkdtempSync(path.join(tmpdir(), "boxery-boot-bench-"));
chmodSync(conf, 0o700);
const prefix = `bxbench-${randomBytes(5).toString("hex")}-`;
const env = { ...config.env, BOXERY_BACKEND: config.backend, BOXERY_CONF: conf, BOXERY_DOMAIN_PREFIX: prefix, BOXERY_TIMINGS: "1" };
const host = path.join(ROOT, "host/boxery-host");
let child, interrupted = false, exists = false, inPool = false;
const samples = { new: [], acquire: [], release: [] };
const interrupt = () => { interrupted = true; child?.kill("SIGINT"); };
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);

function run(args, input) {
	return new Promise((resolve, reject) => {
		const start = performance.now();
		child = spawn(host, args, { env, stdio: ["pipe", "pipe", "pipe"] });
		const current = child;
		let stdout = "", stderr = "";
		current.stdout.on("data", (d) => { stdout += d; });
		current.stderr.on("data", (d) => { stderr += d; process.stderr.write(d); });
		current.stdin.on("error", () => {});
		current.stdin.end(input);
		current.on("error", reject);
		current.on("close", (code) => {
			child = null;
			const ms = Math.round(performance.now() - start);
			if (code !== 0) return reject(new Error(`${args.join(" ")} exited ${code}: ${stderr}`));
			resolve({ ms, stdout: stdout.trim(), stages: stderr.split("\n").filter((l) => l.startsWith("[boxery-timing] ")).map((l) => JSON.parse(l.slice(16))) });
		});
	});
}
function record(kind, round, result) {
	samples[kind].push(result.ms);
	process.stdout.write(`${JSON.stringify({ kind, round, ...result })}\n`);
}
try {
	writeFileSync(path.join(conf, "host.env"), HOST_ENV.filter((k) => env[k]).map((k) => `${k}=${env[k]}\n`).join(""), { mode: 0o600 });
	if (existsSync(path.join(config.conf, "shapes.json"))) copyFileSync(path.join(config.conf, "shapes.json"), path.join(conf, "shapes.json"));
	for (const f of ["mgmt_ed25519", "mgmt_ed25519.pub"]) {
		copyFileSync(path.join(config.conf, f), path.join(conf, f));
		chmodSync(path.join(conf, f), 0o600);
	}
	process.stderr.write(`Real VM benchmark: ${rounds} boots, namespace ${prefix}, state ${conf}\n`);
	for (let round = 1; round <= rounds && !interrupted; round++) {
		exists = true; // also clean a partially failed create
		record("new", round, await run(["new", "boot", ...flags]));
		await run(["rm", "boot"]); exists = false;
	}
	if (!interrupted) {
		exists = true;
		await run(["new", "boot", ...flags]);
		inPool = true; await run(["pool", "add", "boot"]);
		for (let round = 1; round <= rounds && !interrupted; round++) {
			const result = await run(["acquire", "--holder", "startup-bench", "--ttl", "600"], key);
			record("acquire", round, result);
			const lease = result.stdout.split(/\s+/)[1];
			record("release", round, await run(["release", lease]));
		}
	}
	for (const [kind, values] of Object.entries(samples)) {
		if (!values.length) continue;
		const sorted = [...values].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
		process.stdout.write(`${JSON.stringify({ kind: "summary", operation: kind, rounds: values.length, minMs: sorted[0], medianMs: median, maxMs: sorted.at(-1) })}\n`);
	}
} finally {
	// The host supervisor recovers abandoned intents before the next command. Keep state on a
	// cleanup failure so an operator can retry; never orphan domains by deleting their journal.
	let clean = true;
	if (inPool) await run(["pool", "rm", "boot", "--force"]).catch((e) => { clean = false; console.error(e.message); });
	if (exists) await run(["rm", "boot"]).catch((e) => { clean = false; console.error(e.message); });
	if (clean) rmSync(conf, { recursive: true, force: true });
	else console.error(`Cleanup incomplete. Keep BOXERY_CONF=${conf} BOXERY_DOMAIN_PREFIX=${prefix} to retry with ${host}.`);
	process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
	if (interrupted) process.exitCode = 130;
}
