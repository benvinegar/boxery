// Core + MCP use the actual single-operation helper through isolated fake SSH.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { fakeSSH, guestFixture } from "./helpers/atomic-edit-fixture.mjs";

const exec = promisify(execFile), dir = mkdtempSync(path.join(tmpdir(), "boxery-edit-wire-"));
const guest = guestFixture(dir); fakeSSH(dir);
mkdirSync(path.join(dir, "home/host-registry"), { recursive: true });
for (const host of ["alpha", "beta"]) {
	const profile = path.join(dir, host); mkdirSync(path.join(profile, "project"), { recursive: true });
	for (const name of ["ssh_config", "config"]) writeFileSync(path.join(profile, name), "# fake\n");
	writeFileSync(path.join(dir, "home/host-registry", host), profile + "\n");
}
writeFileSync(path.join(dir, "home/default-host"), "alpha\n");
const env = { ...guest, BOXERY_HOME: path.join(dir, "home"), NODE_OPTIONS: "", GUEST_NODE_OPTIONS: guest.NODE_OPTIONS };
const children = new Set();
after(() => { for (const p of children) p.kill(); rmSync(dir, { recursive: true, force: true }); });
const destination = (host, name) => path.join(dir, host, "project", name);
async function core(script, injection = "") {
	return exec(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict'; import * as c from ${JSON.stringify(new URL("../core/boxery-core.mjs", import.meta.url).href)}; ${script}`], { env: { ...env, EDIT_INJECT: injection }, timeout: 10000 });
}

test("preaborted call never starts; exactly one SSH request per edit, routed by host", async () => {
	await core(`const ac=new AbortController(); ac.abort(); await assert.rejects(c.editTool('fakevm',{path:'no',oldText:'x'},{signal:ac.signal}),/cancelled/);`);
	assert.equal(existsSync(path.join(dir, "alpha/calls")), false);
	const name = "routed 雪'$(touch NEVER)\nend";
	for (const host of ["alpha", "beta"]) writeFileSync(destination(host, name), host);
	await core(`await Promise.all(['alpha','beta'].map(host=>c.withHost(host,()=>c.editTool('fakevm',{path:${JSON.stringify(name)},oldText:host,newText:host+'-edited'}))));`);
	for (const host of ["alpha", "beta"]) {
		assert.equal(readFileSync(destination(host, name), "utf8"), host + "-edited");
		assert.equal(readFileSync(path.join(dir, host, "calls"), "utf8"), "edit\n");
	}
});

test("lost or malformed acknowledgement after rename warns to reread, retaining diagnostics", async () => {
	for (const injection of ["console.log=()=>{console.error('ack dropped');process.exitCode=255};", "console.log=()=>process.stdout.write('{}');"]) {
		writeFileSync(destination("alpha", "ack"), "before");
		await core(`await assert.rejects(c.editTool('fakevm',{path:'ack',oldText:'before',newText:'after'}),error=>{assert.match(error.message,/commit outcome may be unknown; reread before retrying/); assert.ok(error.cause instanceof Error); return true;});`, injection);
		assert.equal(readFileSync(destination("alpha", "ack"), "utf8"), "after");
	}
});

async function marker(file) {
	const deadline = Date.now() + 5000;
	while (!existsSync(file)) {
		if (Date.now() > deadline) throw new Error("guest never reached barrier");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("MCP signal reaches staged guest; cancellation before/after rename reports error, not success", { timeout: 15000 }, async () => {
	for (const phase of ["stage", "renamed"]) {
		const target = destination("alpha", phase), ready = path.join(dir, phase); writeFileSync(target, "before");
		// Listen before announcing: the marker exists once writeFile opens it, so a cancel can land before writeFile resolves.
		const pause = `const timer=setInterval(()=>{},1000); const signalled=new Promise(resolve=>{for(const s of ['SIGTERM','SIGHUP','SIGINT'])process.once(s,resolve)}); await fs.writeFile(${JSON.stringify(ready)},'ready'); await signalled; clearInterval(timer);`;
		const injection = phase === "stage" ? `const open=fs.open; fs.open=async(...a)=>{const f=await open(...a); f.sync=async()=>{${pause}}; return f;};` :
			`const rename=fs.rename; fs.rename=async(...a)=>{await rename(...a); ${pause}};`;
		const p = spawn(process.execPath, [new URL("../mcp/boxery-mcp.mjs", import.meta.url).pathname, "--vm", "fakevm"], { env: { ...env, EDIT_INJECT: injection }, stdio: ["pipe", "pipe", "pipe"] });
		children.add(p); let buffer = "";
		const response = new Promise((resolve) => p.stdout.on("data", (d) => { buffer += d; if (buffer.includes("\n")) resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))).result); }));
		try {
			p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vm_edit", arguments: { path: phase, edits: [{ oldText: "before", newText: "after" }] } } }) + "\n");
			await marker(ready);
			p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }) + "\n");
			const result = await response; assert.equal(result.isError, true); assert.match(result.content[0].text, /cancelled.*unknown/);
			assert.equal(readFileSync(target, "utf8"), phase === "stage" ? "before" : "after");
			assert.deepEqual(readdirSync(path.dirname(target)).filter((n) => n.startsWith(".boxery-edit-")), []);
		} finally { p.kill(); children.delete(p); }
	}
});
