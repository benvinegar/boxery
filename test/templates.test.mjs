import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "../host/config.mjs";
import { definitions, extractTemplate, applyTemplate, listTemplates, assertUnreferenced } from "../host/templates.mjs";
import { resources } from "../host/boxery-operations.mjs";
import { setVmKind } from "../host/kinds.mjs";
import { formatTemplates, manage } from "../core/boxery-core.mjs";
import { registerHost } from "./fixtures/register-host.mjs";

const exec = promisify(execFile);
function fixture(t, backend = "fake") {
	const conf = mkdtempSync(path.join(tmpdir(), "boxery-templates-"));
	t.after(() => rmSync(conf, { recursive: true, force: true }));
	const rt = { conf, root: ROOT, backend, vms: {
		images: async () => [{ image: "golden@dev" }], templateStatus: async (source) => source === "base" ? "missing" : "on-demand",
	} };
	const save = (templates, other = {}) => writeFileSync(path.join(conf, "templates.json"), JSON.stringify({ version: 1, backends: { [backend]: templates, ...other } }));
	return { rt, save };
}

test("each backend owns its declaration; boat does not advertise stock headless", (t) => {
	for (const backend of ["fake", "libvirt", "lima", "cloud-hypervisor", "exe", "boat"]) {
		const { rt } = fixture(t, backend);
		assert.deepEqual(definitions(rt).map((d) => d.name), backend === "boat" ? ["desktop"] : ["desktop", "headless"]);
	}
});
test("definitions belong to the selected backend/profile and names are not universal", (t) => {
	const { rt, save } = fixture(t);
	save({ dev: { image: "golden@dev" } }, { boat: { different: { image: "boat@native" } } });
	assert.deepEqual(definitions(rt).map((d) => d.name), ["desktop", "dev", "headless"]);
	assert.equal(definitions({ ...rt, backend: "boat" }).find((d) => d.name === "different").image, "boat@native");
});
test("malformed, oversized, reserved and executable definitions fail closed", (t) => {
	const { rt } = fixture(t);
	const file = path.join(rt.conf, "templates.json");
	for (const value of ["{", JSON.stringify({ version: 2, backends: {} }), JSON.stringify({ version: 1, backends: [] }),
		JSON.stringify({ version: 1, backends: { fake: { desktop: { image: "golden@dev" } } } }),
		JSON.stringify({ version: 1, backends: { fake: { dev: { image: "../escape" } } } }),
		JSON.stringify({ version: 1, backends: { fake: { dev: { image: "golden@dev", exec: "anything" } } } }),
		JSON.stringify({ version: 1, backends: { fake: { dev: { image: "golden@boxery-clean" } } } }),
		JSON.stringify({ version: 1, backends: { fake: { dev: { image: "golden@fork-123" } } } }), " ".repeat(1024 * 1024 + 1)]) {
		writeFileSync(file, value);
		assert.throws(() => definitions(rt));
	}
});
test("discovery distinguishes supported, ready, missing and provision-on-demand", async (t) => {
	const { rt, save } = fixture(t);
	save({ dev: { image: "golden@dev" }, absent: { image: "missing@dev" } });
	setVmKind(rt.conf, "golden", "headless");
	const result = await listTemplates(rt);
	const byName = Object.fromEntries(result.templates.map((d) => [d.name, d]));
	assert.equal(byName.desktop.status, "missing");
	assert.equal(byName.headless.status, "on-demand");
	assert.equal(byName.headless.ready, false);
	assert.equal(byName.dev.kind, "headless");
	assert.equal(byName.dev.ready, true);
	assert.equal(byName.absent.kind, null);
	assert.ok(result.templates.every((d) => d.supported));
	assert.match(formatTemplates(result), /headless.*on-demand/);
});
test("discovery and selection propagate inventory failures rather than substitute", async (t) => {
	const { rt, save } = fixture(t);
	save({ dev: { image: "golden@dev" } });
	rt.vms.images = async () => { throw new Error("provider offline"); };
	await assert.rejects(listTemplates(rt), /provider offline/);
	await assert.rejects(applyTemplate(rt, "dev", {}, ["child"]), /provider offline/);
	rt.vms.templateStatus = async () => { throw new Error("base API offline"); };
	await assert.rejects(applyTemplate(rt, "desktop", {}, ["child"]), /base API offline/);
});
test("selection binds an image before locking; later edits cannot retarget worker argv", async (t) => {
	const { rt, save } = fixture(t);
	save({ dev: { image: "golden@dev" } });
	const selected = extractTemplate(["child", "--template", "dev", "--cold"]);
	const canonical = await applyTemplate(rt, selected.name, {}, selected.args);
	assert.deepEqual(canonical, ["child", "--cold", "--from", "golden@dev"]);
	assert.deepEqual(resources("new", canonical), ["child", "golden"]);
	save({ dev: { image: "different@dev" } });
	assert.deepEqual(resources("new", canonical), ["child", "golden"]);
	assert.throws(() => resources("new", ["child", "--template", "dev"]), /unknown flag/);
});
test("unknown, conflicting, missing and pending selections fail without fallback", async (t) => {
	const { rt } = fixture(t, "boat");
	await assert.rejects(applyTemplate(rt, "headless", {}, ["child"]), /unsupported/);
	await assert.rejects(applyTemplate(rt, "desktop", { from: "x@y" }, ["child"]), /cannot be combined/);
	await assert.rejects(applyTemplate(rt, "desktop", { headless: true }, ["child"]), /cannot be combined/);
	await assert.rejects(applyTemplate(rt, "desktop", {}, ["child"]), /missing/);
	rt.vms.templateStatus = async () => "unready";
	await assert.rejects(applyTemplate(rt, "desktop", {}, ["child"]), /unready/);
	assert.throws(() => extractTemplate(["child", "--template"]));
	assert.throws(() => extractTemplate(["child", "--template", "a", "--template", "b"]));
	assert.deepEqual(extractTemplate(["child", "--mem", "--template"]), { name: "", args: ["child", "--mem", "--template"] });
});
test("built-in selectors reuse ordinary paths and explicit cold flags", async (t) => {
	const { rt } = fixture(t);
	assert.deepEqual(await applyTemplate(rt, "headless", {}, ["child", "--cold"]), ["child", "--cold", "--headless"]);
	rt.vms.templateStatus = async () => "ready";
	assert.deepEqual(await applyTemplate(rt, "desktop", {}, ["child"]), ["child"]);
});
test("configured image references block deletion only in their own backend", (t) => {
	const { rt, save } = fixture(t);
	save({ dev: { image: "golden@dev" } }, { boat: { other: { image: "boat@dev" } } });
	assert.throws(() => assertUnreferenced(rt, (i) => i === "golden@dev"), /referenced by template.*dev/);
	assert.doesNotThrow(() => assertUnreferenced(rt, (i) => i === "boat@dev"));
	save({}); assert.doesNotThrow(() => assertUnreferenced(rt, () => true));
});
test("tool-level selectors reject conflicts and unsafe names before any transport", async () => {
	await assert.rejects(manage({ action: "new", vm: "child", template: "dev", from: "golden@dev" }), /cannot be combined/);
	await assert.rejects(manage({ action: "new", vm: "child", template: "../../bad" }), /invalid template/);
});

test("real host CLI/fake backend: define, discover, select and protect an image", async (t) => {
	const { rt, save } = fixture(t);
	const bin = path.join(rt.conf, "bin"); mkdirSync(bin);
	writeFileSync(path.join(bin, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	writeFileSync(path.join(rt.conf, "mgmt_ed25519.pub"), "ssh-ed25519 AAAAtest management\n");
	writeFileSync(path.join(rt.conf, "mgmt_ed25519"), "fixture\n");
	const env = { ...process.env, BOXERY_CONF: rt.conf, BOXERY_BACKEND: "fake", BOXERY_FAKE_DIR: path.join(rt.conf, "vms"), PATH: `${bin}:${process.env.PATH}`, NODE_NO_WARNINGS: "1", BOXERY_SSH_WAIT_TRIES: "1" };
	const call = async (...args) => (await exec(path.join(ROOT, "host/boxery-host"), args, { env, timeout: 20_000 })).stdout.trim();
	let listing = JSON.parse(await call("templates", "--json"));
	assert.equal(listing.templates.find((d) => d.name === "desktop").ready, false);
	await assert.rejects(call("new", "bad", "--template", "desktop"), /missing/);
	assert.equal(existsSync(path.join(env.BOXERY_FAKE_DIR, "bad")), false);
	await call("new", "golden", "--template", "headless");
	await call("snap", "golden", "dev");
	save({ dev: { image: "golden@dev" } });
	listing = JSON.parse(await call("templates", "--json"));
	assert.equal(listing.templates.find((d) => d.name === "dev").kind, "headless");
	const home = path.join(rt.conf, "client"), profile = path.join(home, "profile");
	mkdirSync(profile, { recursive: true });
	writeFileSync(path.join(profile, "config"), `HOST=local\nHOST_BIN='${ROOT}/host/boxery-host'\nIDENTITY='${rt.conf}/mgmt_ed25519'\n`);
	registerHost(home, "test", profile);
	const clientEnv = { ...env, BOXERY_HOME: home };
	const cli = async (...args) => (await exec(path.join(ROOT, "controller/boxery"), args, { env: clientEnv, timeout: 20_000 })).stdout.trim();
	assert.equal(JSON.parse(await cli("templates", "--json")).backend, "fake");
	assert.match(await cli("new", "child", "--template", "dev"), /^child /);
	const program = `import {manage} from ${JSON.stringify(new URL("../core/boxery-core.mjs", import.meta.url).href)}; import {infoAction} from ${JSON.stringify(new URL("../core/boxery-tools.mjs", import.meta.url).href)}; await manage({action:'new',vm:'toolchild',template:'dev'}); console.log(JSON.stringify((await infoAction({action:'templates'})).structured));`;
	const toolInfo = JSON.parse((await exec(process.execPath, ["--input-type=module", "-e", program], { env: clientEnv, timeout: 20_000 })).stdout.trim());
	assert.equal(toolInfo.templates.find((d) => d.name === "dev").ready, true);
	assert.equal(JSON.parse(await call("ls", "--json")).find((v) => v.name === "child").desktop, false);
	await assert.rejects(call("snap-rm", "golden", "dev"), /referenced by template/);
	await assert.rejects(call("rm", "golden"), /referenced by template/);
	await call("rm", "child"); await call("rm", "toolchild");
	save({}); await call("snap-rm", "golden", "dev"); await call("rm", "golden");
	assert.deepEqual(JSON.parse(await call("ls", "--json")), []);
});
