#!/usr/bin/env node
// Real local libvirt smoke test. Uses an existing base read-only, unique domain prefix and private
// state/management-key copy. No init/build-base/network changes and no hosted-provider spending.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig, ROOT, HOST_ENV } from "../../host/config.mjs";

if (process.argv[2] !== "--run") throw new Error("requires --run: creates real local VMs");
const config = loadConfig();
if (config.backend !== "libvirt") throw new Error("select an initialized local libvirt profile with a desktop base");
const exec = promisify(execFile), conf = mkdtempSync(path.join(tmpdir(), "boxery-template-live-"));
const prefix = `bxtpl-${randomBytes(5).toString("hex")}-`;
const env = { ...config.env, BOXERY_CONF: conf, BOXERY_DOMAIN_PREFIX: prefix };
const host = async (...args) => (await exec(path.join(ROOT, "host/boxery-host"), args, { env, timeout: 180_000 })).stdout.trim();
const created = new Set(); let clean = true;
const emit = (phase, extra = {}) => console.log(JSON.stringify({ phase, ...extra }));
const source = "golden", dest = "child";
let saved;
const definitions = (templates) => writeFileSync(path.join(conf, "templates.json"), JSON.stringify({ version: 1, backends: { libvirt: templates } }));
const ssh = async (endpoint, command) => {
 const [address, port] = endpoint.split(" ")[1].split(":");
 return (await exec("ssh", ["-i", path.join(conf, "mgmt_ed25519"), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-p", port, `agent@${address}`, command], { timeout: 30_000 })).stdout.trim();
};
try {
 for (const key of ["mgmt_ed25519", "mgmt_ed25519.pub"]) {
  copyFileSync(path.join(config.conf, key), path.join(conf, key)); chmodSync(path.join(conf, key), 0o600);
 }
 writeFileSync(path.join(conf, "host.env"), HOST_ENV.filter((k) => config.env[k] && k !== "BOXERY_DOMAIN_PREFIX").map((k) => `${k}=${config.env[k]}\n`).join("") + `BOXERY_DOMAIN_PREFIX=${prefix}\n`);
 const discovery = JSON.parse(await host("templates", "--json"));
 assert.equal(discovery.templates.find((d) => d.name === "desktop").status, "ready", "prepare the source profile's base first");
 emit("native discovery", { ok: true });
 created.add(source);
 saved = await host("new", source, "--template", "desktop", "--cpus", "2", "--mem", "2048", "--disk", "20");
 await ssh(saved, "printf template-check >~/project/template-check");
 await host("snap", source, "dev");
 definitions({ dev: { image: `${source}@dev` } });
 assert.equal(JSON.parse(await host("templates", "--json")).templates.find((d) => d.name === "dev").ready, true);
 emit("registered native disk image", { ok: true });
 created.add(dest);
 const cloned = await host("new", dest, "--template", "dev", "--cpus", "2", "--mem", "2048", "--disk", "20");
 assert.equal(await ssh(cloned, "hostname"), dest);
 assert.equal(await ssh(cloned, "cat ~/project/template-check"), "template-check");
 assert.notEqual(await ssh(saved, "cat /etc/machine-id"), await ssh(cloned, "cat /etc/machine-id"));
 await ssh(cloned, "printf private-change >~/project/template-check");
 assert.equal(await ssh(saved, "cat ~/project/template-check"), "template-check");
 await assert.rejects(host("snap-rm", source, "dev"), /referenced by template/);
 await assert.rejects(host("rm", source), /referenced by template/);
 emit("named clone, identity, private writes and deletion safety", { ok: true });
} finally {
 definitions({});
 for (const name of [...created].reverse()) await host("rm", name).catch((e) => { clean = false; console.error(`cleanup ${name}: ${e.message}`); });
 for (const key of ["mgmt_ed25519", "mgmt_ed25519.pub"]) rmSync(path.join(conf, key), { force: true });
 if (clean) rmSync(conf, { recursive: true, force: true });
 else console.error(`Retained recovery state: ${conf} (prefix ${prefix})`);
}
if (!clean) throw new Error("template smoke test cleanup needs recovery");
emit("complete", { ok: true });
