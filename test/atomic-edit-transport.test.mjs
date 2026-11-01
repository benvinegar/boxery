// Cancellation and routing through unmodified sshRun and the actual MCP callback.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const CORE = new URL("../core/boxery-core.mjs", import.meta.url).href;
let dir, env;
const children = new Set();
before(() => {
	dir = mkdtempSync(path.join(tmpdir(), "boxery-edit-wire-"));
	mkdirSync(path.join(dir, "bin")); mkdirSync(path.join(dir, "home", "host-registry"), { recursive: true });
	for (const host of ["alpha", "beta"]) {
		const profile = path.join(dir, host); mkdirSync(profile); mkdirSync(path.join(profile, "project"));
		writeFileSync(path.join(profile, "ssh_config"), "# fake\n"); writeFileSync(path.join(profile, "config"), "# fake\n");
		writeFileSync(path.join(dir, "home", "host-registry", host), profile + "\n");
	}
	writeFileSync(path.join(dir, "home", "default-host"), "alpha\n");
	writeFileSync(path.join(dir, "bin", "ssh"), `#!/usr/bin/env python3
import io,json,os,shlex,sys,signal
args=sys.argv[1:]
profile=os.path.dirname(args[args.index('-F')+1])
assert args[-2]=='fakevm.boxery'
outer=shlex.split(args[-1]); inner=shlex.split(outer[2])
assert inner[:3]==['exec','python3','-c']
r=json.load(sys.stdin)
r['path']=r['path'].replace('/home/agent',profile,1)
with open(os.path.join(profile,'calls'),'a') as log: log.write(r['op']+'\\n')
sys.stdin=io.TextIOWrapper(io.BytesIO(json.dumps(r).encode()))
scope={'__name__':'fixture'}
exec(compile(inner[3],'<remote helper>','exec'),scope)
scope['LOCK_DIRECTORY']=os.path.join(os.path.dirname(profile),'locks')
if os.environ.get('EDIT_SNAPSHOT_FAILURE') and r['op']=='snapshot':
 print('snapshot link dropped',file=sys.stderr)
 sys.exit(255)
if os.environ.get('EDIT_COMMIT_RESPONSE'):
 original=scope['run']
 def run(request):
  result=original(request)
  if request['op']=='commit':
   mode=os.environ['EDIT_COMMIT_RESPONSE']
   if mode=='lost':
    print('commit acknowledgement dropped',file=sys.stderr)
    sys.exit(255)
   if mode=='killed':
    sys.exit(137)
   if mode=='remote-error':
    print('remote process failed after rename',file=sys.stderr)
    sys.exit(1)
   sys.stdout.write('{"committed":' if mode=='truncated' else '{}')
   sys.exit(0)
  return result
 scope['run']=run
if os.environ.get('EDIT_BARRIER'):
 def barrier(fd):
  with open(os.environ['EDIT_BARRIER'],'w') as marker: marker.write('staged')
  signal.pause()
 scope['os'].fsync=barrier
if os.environ.get('EDIT_ACK_BARRIER'):
 original=scope['run']
 def run(request):
  result=original(request)
  if request['op']=='commit':
   with open(os.environ['EDIT_ACK_BARRIER'],'w') as marker: marker.write('renamed')
   signal.pause()
  return result
 scope['run']=run
sys.exit(scope['main']())
`);
	chmodSync(path.join(dir, "bin", "ssh"), 0o755);
	env = { ...process.env, BOXERY_HOME: path.join(dir, "home"), PATH: `${path.join(dir, "bin")}:${process.env.PATH}` };
});
after(() => { for (const p of children) p.kill(); rmSync(dir, { recursive: true, force: true }); });
const destination = (host, name) => path.join(dir, host, "project", name);
async function core(script, overrides = {}) {
	return exec(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict'; import * as c from ${JSON.stringify(CORE)}; ${script}`], { env: { ...env, ...overrides }, timeout: 10000 });
}
function client(overrides = {}) {
	const p = spawn(process.execPath, [path.join(ROOT, "mcp/boxery-mcp.mjs"), "--vm", "fakevm"], { env: { ...env, ...overrides }, stdio: ["pipe", "pipe", "pipe"] });
	children.add(p); let buffer = "", id = 0;
	const pending = new Map();
	p.stdout.on("data", (d) => {
		buffer += d;
		while (buffer.includes("\n")) {
			const i = buffer.indexOf("\n"), msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
			pending.get(msg.id)?.(msg.result); pending.delete(msg.id);
		}
	});
	return {
		p,
		edit: (args) => {
			const requestId = ++id;
			const result = new Promise((resolve) => pending.set(requestId, resolve));
			p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name: "vm_edit", arguments: args } }) + "\n");
			return { id: requestId, result };
		},
		cancel: (requestId) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } }) + "\n"),
		close: () => { p.kill(); children.delete(p); },
	};
}
async function marker(file) {
	const deadline = Date.now() + 5000;
	while (!existsSync(file)) {
		if (Date.now() > deadline) throw new Error(`helper never reached ${file}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("core preaborted/precommit-aborted calls never commit; original matching semantics retained", async () => {
	const target = destination("alpha", "semantics"); writeFileSync(target, "abc def abc");
	await core(`
 const ac=new AbortController(); ac.abort();
 await assert.rejects(c.editTool('fakevm',{path:'semantics',oldText:'def',newText:'DEF'},{signal:ac.signal}),/cancelled/);
 const fs=await import('node:fs'); assert.equal(fs.existsSync(${JSON.stringify(path.join(dir, "alpha", "calls"))}),false);
 for (const edits of [[{oldText:'abc',newText:'x'}],[{oldText:'absent'}],[{oldText:''}],[{oldText:'abc def'},{oldText:'def abc'}]]) {
  await assert.rejects(c.editTool('fakevm',{path:'semantics',edits}));
 }
 const cancel=new AbortController();
 await assert.rejects(c.editTool('fakevm',{path:'semantics',edits:[{oldText:'def',get newText(){cancel.abort();return 'DEF'}}]},{signal:cancel.signal}),/cancelled/);
 assert.equal(fs.readFileSync(${JSON.stringify(target)},'utf8'),'abc def abc');
 await c.editTool('fakevm',{path:'semantics',oldText:'def',newText:'DEF'});
 await c.editTool('fakevm',{path:'semantics',edits:[{oldText:'abc DEF',newText:'first'},{oldText:' abc',newText:' last'}]});
 assert.equal(fs.readFileSync(${JSON.stringify(target)},'utf8'),'first last');
 `);
	assert.deepEqual(readFileSync(path.join(dir, "alpha", "calls"), "utf8").trim().split("\n"), ["snapshot", "snapshot", "snapshot", "snapshot", "snapshot", "snapshot", "commit", "snapshot", "commit"]);
});

test("concurrent named-host edits keep both snapshot and commit on their resolved host", async () => {
	for (const host of ["alpha", "beta"]) writeFileSync(destination(host, "routed"), host);
	await core(`await Promise.all(['alpha','beta'].map(host=>c.withHost(host,()=>c.editTool('fakevm',{path:'routed',oldText:host,newText:host+'-edited'}))));`);
	for (const host of ["alpha", "beta"]) {
		assert.equal(readFileSync(destination(host, "routed"), "utf8"), host + "-edited");
		assert.deepEqual(readFileSync(path.join(dir, host, "calls"), "utf8").trim().split("\n").slice(-2), ["snapshot", "commit"]);
	}
});

test("commit lost acknowledgement and invalid responses warn of unknown outcome, retaining diagnostics/cause", async () => {
	for (const mode of ["lost", "truncated", "invalid", "killed", "remote-error"]) {
		const name = `response-${mode}`, target = destination("alpha", name); writeFileSync(target, "original");
		await core(`
 let failure;
 try { await c.editTool('fakevm',{path:${JSON.stringify(name)},oldText:'original',newText:'complete'}); }
 catch (error) { failure=error; }
 assert.ok(failure);
 assert.match(failure.message,/commit outcome may be unknown; reread before retrying/);
 assert.ok(failure.cause instanceof Error);
 assert.ok(failure.message.includes(failure.cause.message));
 ${mode === "lost" ? "assert.match(failure.message,/VM .* unreachable over ssh: commit acknowledgement dropped/);" : mode === "truncated" ? "assert.ok(failure.cause instanceof SyntaxError);" : mode === "killed" ? "assert.match(failure.message,/exit 137/);" : mode === "remote-error" ? "assert.match(failure.message,/remote process failed after rename/);" : "assert.match(failure.message,/invalid edit commit acknowledgement/);"}
 `, { EDIT_COMMIT_RESPONSE: mode });
		assert.equal(readFileSync(target, "utf8"), "complete");
	}
});

test("snapshot transport failure does not imply a possible commit", async () => {
	const name = "snapshot-lost", target = destination("alpha", name); writeFileSync(target, "original");
	await core(`
 await assert.rejects(c.editTool('fakevm',{path:'snapshot-lost',oldText:'original',newText:'complete'}),error=>{
  assert.match(error.message,/snapshot link dropped/);
  assert.doesNotMatch(error.message,/unknown/); return true;
 });
 `, { EDIT_SNAPSHOT_FAILURE: "1" });
	assert.equal(readFileSync(target, "utf8"), "original");
});

test("MCP cancellation reaches staged guest helper, no success/partial bytes or leaked temp", { timeout: 10000 }, async () => {
	const name = "cancel", target = destination("alpha", name), ready = path.join(dir, "staged");
	writeFileSync(target, "original");
	const c = client({ EDIT_BARRIER: ready });
	try {
		const call = c.edit({ path: name, edits: [{ oldText: "original", newText: "complete" }] });
		await marker(ready); assert.equal(readFileSync(target, "utf8"), "original"); c.cancel(call.id);
		const result = await call.result;
		assert.equal(result.isError, true); assert.match(result.content[0].text, /cancelled/);
		assert.equal(readFileSync(target, "utf8"), "original");
		assert.deepEqual(readdirSync(path.dirname(target)).filter((n) => n.startsWith(".boxery-edit-")), []);
	} finally { c.close(); }
	await core(`await c.editTool('fakevm',{path:'cancel',oldText:'original',newText:'complete'});`);
});

test("MCP cancellation after rename is an error with unknown outcome, never a false success", { timeout: 10000 }, async () => {
	const name = "lost-ack", target = destination("alpha", name), ready = path.join(dir, "renamed");
	writeFileSync(target, "original"); const c = client({ EDIT_ACK_BARRIER: ready });
	try {
		const call = c.edit({ path: name, edits: [{ oldText: "original", newText: "complete" }] });
		await marker(ready); c.cancel(call.id);
		const result = await call.result; assert.equal(result.isError, true); assert.match(result.content[0].text, /unknown/);
		assert.equal(readFileSync(target, "utf8"), "complete");
	} finally { c.close(); }
});
