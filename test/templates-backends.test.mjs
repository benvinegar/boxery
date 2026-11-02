// Exercise the actual adapter status functions with native APIs mocked. Never contact providers.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "../host/config.mjs";
const exec = promisify(execFile);
const jqMissing = spawnSync("jq", ["--version"]).error?.code === "ENOENT";

for (const backend of ["libvirt", "lima", "exe", "boat", "cloud-hypervisor", "fake"]) {
	test(`${backend}: native template preflight, absence and failure semantics`, { skip: jqMissing }, async (t) => {
		const dir = mkdtempSync(path.join(tmpdir(), "boxery-template-adapter-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const baseEnv = { ...process.env, HOME: dir, ROOT, CACHE: dir, PROXY_PORT: "8088", DRIVER: path.join(ROOT, "host/backends", `${backend}.sh`),
			BOXERY_CH_FAST: "0", BOXERY_CH_NET_MODE: "tap", BOXERY_CH_DIR: dir, BOXERY_FAKE_DIR: dir,
			BOXERY_BASE_VOL: "base.qcow2", BOXERY_LIMA_PREFIX: "tpl-", BOXERY_EXE_PREFIX: "tpl-", BOXERY_EXE_DIR: dir,
			BOXERY_BOAT_PREFIX: "tpl-", BOXERY_BOAT_DIR: dir };
		const script = `die() { echo "$*" >&2; exit 1; }; log() { :; }; need() { :; }; SSH_OPTS=()
. "$DRIVER"
virsh() { [[ $FAIL == 0 ]] || return 1; printf '%s' "$DATA"; }
limactl() { [[ $FAIL == 0 ]] || return 1; printf '%s' "$DATA"; }
exe_ls() { [[ $FAIL == 0 ]] || return 1; printf '%s' "$DATA"; }
boat_api() { [[ $FAIL == 0 ]] || return 1; printf '%s' "$DATA"; }
if [[ $SOURCE == image-inventory ]]; then backend_images; else backend_template_status "$SOURCE"; fi`;
		const call = async (data = "", source = "base", fail = "0") => (await exec("bash", ["-euo", "pipefail", "-c", script], { env: { ...baseEnv, DATA: data, SOURCE: source, FAIL: fail } })).stdout.trim();
		if (backend === "fake" || backend === "cloud-hypervisor") {
			assert.equal(await call(), "missing");
			writeFileSync(path.join(dir, backend === "fake" ? ".base" : "base.qcow2"), "fixture");
			assert.equal(await call(), "ready");
		} else {
			const empty = { libvirt: " Name Path\n------\n", lima: "", exe: '{"vms":[]}', boat: '{"snapshots":[]}' }[backend];
			const ready = { libvirt: " Name Path\n------\nbase.qcow2 /tmp/base.qcow2\n", lima: '{"name":"tpl-base","status":"Stopped"}', exe: '{"vms":[{"vm_name":"tpl-base","status":"stopped"}]}', boat: '{"snapshots":[{"name":"tpl-base","status":"ready"}]}' }[backend];
			assert.equal(await call(empty), "missing");
			assert.equal(await call(ready), "ready");
			await assert.rejects(call(ready, "base", "1"), /cannot inspect/);
			await assert.rejects(call('{"error":"bad inventory"}'), /invalid .*template inventory/);
			if (backend === "boat") {
				assert.equal(await call('{"snapshots":[{"name":"tpl-base","status":"building"}]}'), "unready");
				await assert.rejects(call('{"error":"bad inventory"}', "image-inventory"), /invalid boat snapshot inventory/);
			}
			if (backend === "exe") assert.equal(await call('{"vms":[{"vm_name":"tpl-base","status":"creating"}]}'), "unready");
		}
		if (backend === "boat") await assert.rejects(call("", "stock"), /unknown template source/);
		else assert.equal(await call("", "stock"), "on-demand");
	});
}
