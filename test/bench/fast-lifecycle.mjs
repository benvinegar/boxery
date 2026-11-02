#!/usr/bin/env node
// REAL VMs. Use ONLY an empty, disposable, initialized CH profile with matching desktop/headless
// templates. BOXERY_CONF=... node test/bench/fast-lifecycle.mjs --run
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig, ROOT } from "../../host/config.mjs";
import { registerHost } from "../fixtures/register-host.mjs";

if (process.argv[2] !== "--run") throw new Error("Requires --run: creates and destroys real VMs in a DISPOSABLE profile");
const roundsIndex = process.argv.indexOf("--rounds");
const rounds = roundsIndex < 0 ? 0 : Number(process.argv[roundsIndex + 1]);
if (!Number.isInteger(rounds) || rounds < 0 || rounds > 20) throw new Error("--rounds must be 0..20");
const config = loadConfig();
if (config.backend !== "cloud-hypervisor" || config.env.BOXERY_CH_FAST !== "1") throw new Error("use an initialized experimental CH fast profile");
const exec = promisify(execFile), hostBin = path.join(ROOT, "host/boxery-host");
const host = async (args) => (await exec(hostBin, args, { env: config.env, timeout: 600_000 })).stdout.trim();
assert.deepEqual(JSON.parse(await host(["ls", "--json"])), [], "profile must be empty, not a shared user profile");
assert.deepEqual(JSON.parse(await host(["pool", "ls", "--json"])), [], "pool must be empty");
const work = mkdtempSync(path.join(tmpdir(), "boxery-fast-life-")), home = path.join(work, "c"), profile = path.join(home, "p");
mkdirSync(profile, { recursive: true, mode: 0o700 });
process.env.BOXERY_HOME = home;
process.env.BOXERY_CONF = config.conf;
const core = await import("../../core/boxery-core.mjs");
const key = path.join(work, "client-key");
await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
const pub = readFileSync(`${key}.pub`, "utf8").trim();
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
writeFileSync(path.join(profile, "config"), `HOST=local\nHOST_BIN=${q(hostBin)}\nIDENTITY=${q(key)}\n`);
const sshConf = path.join(profile, "ssh_config");
writeFileSync(sshConf, `Host *.boxery\n User agent\n IdentityFile ${JSON.stringify(key)}\n IdentitiesOnly yes\n StrictHostKeyChecking no\n UserKnownHostsFile /dev/null\n LogLevel ERROR\n ConnectTimeout 3\n ControlMaster auto\n ControlPersist 30\n ControlPath ${profile}/cm-%C\n ProxyCommand env BOXERY_CONF=${q(config.conf)} ${q(hostBin)} connect %h %p\n`);
registerHost(home, "fast", profile);
await new Promise((resolve, reject) => {
 const p = spawn(hostBin, ["add-key"], { env: config.env, stdio: ["pipe", "ignore", "pipe"] });
 p.on("error", reject); p.on("close", (code) => code ? reject(new Error("add-key failed")) : resolve()); p.stdin.end(pub + "\n");
});
const prefix = "fl-" + randomBytes(3).toString("hex"), vm = prefix + "-d", hv = prefix + "-h", clone = prefix + "-f", cold = prefix + "-c", crash = prefix + "-x";
const created = new Set(), pooled = new Set();
const cli = (args) => core.boxeryCli(args);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const phase = async (name, fn) => {
 const start = performance.now();
 try { const result = await fn(); emit({ phase: name, ok: true, ms: Math.round(performance.now() - start) }); return result; }
 catch (e) { emit({ phase: name, ok: false, ms: Math.round(performance.now() - start), error: e.message }); throw e; }
};
const ssh = async (name, command) => (await core.sshOk(name, command)).toString().trim();
const newVm = async (name, extra = {}) => {
 created.add(name);
 await core.manage({ action: "new", vm: name, cpus: 2, mem: 2048, disk: 20, ...extra });
};
const info = async (name) => JSON.parse(await host(["ls", "--json"])).find((v) => v.name === name);
const metadata = (name) => JSON.parse(readFileSync(path.join(config.env.BOXERY_CH_DIR, "vms", name, "runtime.json")));
const wait = async (fn, seconds = 45) => {
 const end = Date.now() + seconds * 1000;
 while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
 throw new Error("readiness wait timed out");
};
const auth = async (token) => (await fetch(`http://127.0.0.1:${config.proxyPort}/ollama/not-allowed`, { headers: { Authorization: `Bearer ${token}` } })).status;
const managementSsh = async (name, command, identity = path.join(config.conf, "mgmt_ed25519"), check = true) => {
 const row = await info(name), sep = row.ssh_addr.lastIndexOf(":"), address = row.ssh_addr.slice(0, sep), port = row.ssh_addr.slice(sep + 1);
 try { return (await exec("ssh", ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-i", identity, "-p", port, `agent@${address}`, command], { timeout: 20_000 })).stdout.trim(); }
 catch (e) { if (check) throw e; return e.code; }
};
let lease;
let clean = true;
try {
 for (const forceCold of [false, true]) for (let i = 0; i < rounds; i++) {
  const name = `${prefix}-r${forceCold ? "c" : "f"}${i}`;
  await phase(`${forceCold ? "cold" : "fast"} desktop round ${i + 1}`, () => newVm(name, { cold: forceCold }));
  await cli(["rm", name]); created.delete(name);
 }
 await phase("fast desktop create via controller/core", () => newVm(vm));
 assert.equal(metadata(vm).restore, true);
 await phase("shell, HTTPS, git and proxy authentication", async () => {
  const out = await ssh(vm, "set -e; hostname; curl --max-time 15 -fsS -o /dev/null https://example.com; git ls-remote https://github.com/benvinegar/boxery HEAD; curl -fsS http://127.0.0.1:8088/healthz");
  assert.ok(out.includes(vm) && out.includes("HEAD") && out.includes("ok"));
  assert.equal(await auth(await ssh(vm, 'printf %s "$(<~/.boxery/token)"')), 403);
  assert.equal(await auth("invalid"), 401);
 });
 await phase("file read/write/edit/copy", async () => {
  await core.writeTool(vm, { path: "/home/agent/project/fast.txt", content: "before\n" });
  await core.editTool(vm, { path: "/home/agent/project/fast.txt", edits: [{ oldText: "before", newText: "after" }] });
  assert.match((await core.readTool(vm, { path: "/home/agent/project/fast.txt" })).text, /after/);
  const source = path.join(work, "input.txt"), dest = path.join(work, "output.txt");
  writeFileSync(source, "copy-check\n");
  await core.copyTool({ from: `local:${source}`, to: `${vm}:/home/agent/project/copied.txt` });
  await core.copyTool({ from: `${vm}:/home/agent/project/copied.txt`, to: `local:${dest}` });
  assert.equal(readFileSync(dest, "utf8"), "copy-check\n");
 });
 await phase("background jobs and restore incarnation", async () => {
  const job = (await core.jobsTool(vm, { action: "start", command: "printf job-ok; exit 7" })).structured;
  const done = await core.jobsTool(vm, { action: "wait", job: job.id, timeout: 10 });
  assert.equal(done.structured.exit_code, 7);
  const record = JSON.parse(await ssh(vm, `printf %s "$(<~/.boxery/jobs/${job.id}.json)"`));
  const epoch = await ssh(vm, 'printf "%s:%s" "$(</proc/sys/kernel/random/boot_id)" "$(</run/boxery/incarnation)"');
  assert.equal(record.boot_id, epoch);
 });
 await phase("two RAM clones: fresh identity, entropy and service caches", async () => {
  const peer = prefix + "-i";
  await newVm(peer);
  const records = [];
  for (const name of [vm, peer]) {
   const record = JSON.parse(await ssh(name, `python3 -c 'import json,os; from pathlib import Path; print(json.dumps({"machine":Path("/etc/machine-id").read_text().strip(),"boot":Path("/proc/sys/kernel/random/boot_id").read_text().strip(),"incarnation":Path("/run/boxery/incarnation").read_text().strip(),"key":Path("/etc/ssh/ssh_host_ed25519_key.pub").read_text(),"random":os.urandom(32).hex()}))'`));
   const manager = await ssh(name, "sudo busctl --system call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.DBus.Peer GetMachineId");
   assert.ok(manager.includes(record.machine), "PID 1's sd-bus cache must use the newly assigned machine-id");
   record.bus = await ssh(name, "sudo busctl --system call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetId");
   const log = JSON.parse(await ssh(name, "logger -t boxery-fast-identity check; sudo journalctl --sync; sudo journalctl -q -t boxery-fast-identity -n1 -o json"));
   assert.equal(log._MACHINE_ID, record.machine, "journald must not retain its template machine-id");
   records.push(record);
  }
  assert.equal(records[0].boot, records[1].boot, "these really resumed the same kernel template");
  for (const field of ["machine", "incarnation", "key", "random", "bus"]) assert.notEqual(records[0][field], records[1][field]);
  await cli(["rm", peer]); created.delete(peer);
 });
 await phase("fresh browser launch and real screenshot", async () => {
  const result = await core.browser(vm, { code: `await page.goto('https://example.com'); return await page.title();`, screenshot: true });
  assert.match(result.text, /Example Domain/);
  assert.ok(result.image?.data);
  writeFileSync(path.join(work, "browser.png"), Buffer.from(result.image.data, "base64"));
  const screen = await core.screenshot(vm);
  assert.ok(screen.image?.data);
  writeFileSync(path.join(work, "desktop.png"), Buffer.from(screen.image.data, "base64"));
 });
 await phase("dummy environment grant and revoke", async () => {
  process.env.BOXERY_FAST_CHECK = "dummy-not-a-secret";
  await cli(["grant", vm, "env:BOXERY_FAST_CHECK"]);
  assert.match((await core.bashTool(vm, { command: "printf %s \"$BOXERY_FAST_CHECK\"" })).text, /dummy-not-a-secret/);
  await cli(["revoke", vm, "all"]);
 });
 await phase("guest reboot and persisted data", async () => {
  const before = await ssh(vm, 'printf %s "$(</run/boxery/incarnation)"');
  await ssh(vm, `printf '%s\\n' 'GRUB_CMDLINE_LINUX="$GRUB_CMDLINE_LINUX boxery_fast_check=1"' | sudo tee /etc/default/grub.d/99-boxery-fast-check.cfg >/dev/null; sudo update-grub >/dev/null`);
  await core.sshRun(vm, "sudo reboot").catch(() => {});
  await exec("ssh", ["-F", sshConf, "-O", "exit", `${vm}.boxery`]).catch(() => {});
  await wait(async () => (await ssh(vm, 'printf %s "$(</run/boxery/incarnation)"')) !== before);
  assert.equal(await ssh(vm, 'printf %s "$(<~/project/fast.txt)"'), "after");
  assert.match(await ssh(vm, 'printf %s "$(</proc/cmdline)"'), /boxery_fast_check=1/, "guest reboot must honor its own GRUB/kernel configuration, not the template's old direct kernel");
  assert.equal(await auth(await ssh(vm, 'printf %s "$(<~/.boxery/token)"')), 403);
 });
 await phase("headless fast creation and desktop refusal", async () => {
  await newVm(hv, { headless: true });
  assert.equal(metadata(hv).restore, true);
  await ssh(hv, "test -f /etc/boxery/headless; curl --max-time 15 -fsS -o /dev/null https://example.com");
  await assert.rejects(core.screenshot(hv), /headless/);
 });
 await phase("explicit cold bypass through vm_manage", async () => {
  await newVm(cold, { cold: true });
  assert.equal(metadata(cold).restore, false);
  assert.equal(metadata(cold).agent, false);
  await ssh(cold, "curl --max-time 15 -fsS -o /dev/null https://example.com");
 });
 await phase("pool lease, snapshot and ordinary restart", async () => {
  pooled.add(vm);
  await cli(["pool", "add", vm]);
  const out = await cli(["acquire", "--ttl", "600"]);
  const match = out.match(new RegExp(`${vm} (l-[0-9a-f]{32})`));
  assert.ok(match, out);
  lease = match[1];
  const token = await ssh(vm, 'printf %s "$(<~/.boxery/token)"');
  writeFileSync(path.join(work, "stale.key"), readFileSync(path.join(profile, "leases", `${lease}.key`)), { mode: 0o600 });
  await cli(["stop", vm]);
  await wait(async () => (await info(vm)).state !== "running");
  await cli(["start", vm]);
  assert.ok((await ssh(vm, 'printf %s "$(<~/.boxery/token)"')) === token, "restart must not replay the original pet token");
  assert.equal(await auth(token), 403);
  await ssh(vm, 'mkdir -p /run/user/$(id -u)/boxery; printf temporary >/run/user/$(id -u)/boxery/probe');
  const job = (await core.jobsTool(vm, { action: "start", command: "sleep 120" })).structured;
  await cli(["snap", vm, "lease"]);
  await newVm(clone, { from: `${vm}@lease` });
  assert.equal(metadata(clone).restore, false, "ordinary snapshots MUST cold boot, never borrow unrelated RAM");
  assert.equal(await ssh(clone, 'printf %s "$(<~/project/fast.txt)"'), "after");
  await ssh(clone, 'test ! -e /run/user/$(id -u)/boxery/probe');
  const listed = (await core.jobsTool(clone, { action: "list" })).structured.jobs;
  assert.equal(listed.find((j) => j.id === job.id)?.state, "lost");
  assert.equal(await managementSsh(clone, "true", path.join(work, "stale.key"), false), 255);
  assert.ok((await ssh(clone, 'printf %s "$(<~/.boxery/token)"')) !== token);
  await cli(["release", vm]);
  lease = null;
  assert.equal(await auth(token), 401);
  assert.equal(await managementSsh(vm, "true", path.join(work, "stale.key"), false), 255);
  await managementSsh(vm, 'test ! -e /run/user/$(id -u)/boxery/probe');
  assert.equal(JSON.parse(await host(["pool", "ls", "--json"]))[0].state, "free");
 });
 await phase("interrupted-create journal recovery", async () => {
  const child = spawn(hostBin, ["new", crash, "--cpus", "2", "--mem", "2048", "--disk", "20"], { env: config.env, stdio: ["ignore", "ignore", "ignore"] });
  created.add(crash);
  try {
   await wait(() => existsSync(path.join(config.env.BOXERY_CH_DIR, "vms", crash, "unit-name")), 15);
   child.kill("SIGKILL");
   await new Promise((resolve) => child.once("close", resolve));
   await host(["reconcile"]);
   assert.equal(existsSync(path.join(config.env.BOXERY_CH_DIR, "vms", crash)), false);
   assert.equal(Object.hasOwn(JSON.parse(readFileSync(path.join(config.conf, "tokens.json"))), crash), false);
   created.delete(crash);
  } finally { child.kill("SIGKILL"); }
 });
 emit({ phase: "complete", ok: true, evidence: work });
} finally {
 if (lease) await cli(["release", vm]).catch(() => {});
 for (const name of pooled) await host(["pool", "rm", name, "--force"]).catch(() => {});
 for (const name of created) {
  await exec("ssh", ["-F", sshConf, "-O", "exit", `${name}.boxery`]).catch(() => {});
  await host(["rm", name]).catch((e) => { clean = false; console.error(`cleanup ${name}: ${e.message}`); });
 }
 const keys = path.join(config.conf, "authorized_keys");
 if (existsSync(keys)) writeFileSync(keys, readFileSync(keys, "utf8").split("\n").filter((l) => l && l !== pub).join("\n") + "\n", { mode: 0o600 });
 if (clean) {
  rmSync(home, { recursive: true, force: true });
  for (const file of [key, `${key}.pub`, path.join(work, "stale.key")]) rmSync(file, { force: true });
 } else console.error(`Retained controller state for cleanup: ${home}`);
}
