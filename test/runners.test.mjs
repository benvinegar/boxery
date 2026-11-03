// host/runners.mjs: the GitHub Actions runner manager. Policy runs against injected fakes (pool, guest,
// GitHub) with scaled-down timers; the GitHub client against a local HTTP server; and one end-to-end run
// drives the real boxery-host (supervisor, SQLite, fake backend, stub ssh) against a stub GitHub API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

let R, L;
try { R = await import("../host/runners.mjs"); L = await import("../host/boxery-leases.mjs"); }
catch (e) { if (!String(e.message).includes("sqlite")) throw e; }
const it = R ? test : test.skip;

const TOKEN = `ghp_${"S3cr3t".repeat(6)}`;
const b64 = (/** @type {unknown} */ o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64");
const unb64 = (/** @type {string} */ s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
/** A JIT config shaped like GitHub's: base64 JSON of files, each base64. */
const jitConfig = (/** @type {string} */ name) => b64({ ".runner": b64({ AgentName: name, DisableUpdate: false, Ephemeral: true }), ".credentials": b64({ Scheme: "OAuthAccessToken", secret: `cred-${name}` }) });
// ttl 90: renewals sleep 30 s (scaled: 30 ms), a value no back-off below uses.
const CONFIG = { repo: "o/r", vms: ["ci-1"], count: 1, labels: ["gpu"], group: 1, ttl: 90, api: "https://api.github.com", prefix: "boxery-test" };
const RENEW_SLEEP = 30000;

/** Scaled sleep: 1000× faster, ended early by the signal; every call is recorded. */
function scaledSleep(events) {
	return (ms, signal) => {
		events.push(["sleep", ms]);
		return /** @type {Promise<void>} */ (new Promise((resolve) => {
			if (signal?.aborted) return resolve();
			const t = setTimeout(resolve, ms / 1000);
			signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
		}));
	};
}

/** Fakes for pool, guest and GitHub, recording every call. leases: what acquire hands out in order (null =
 *  none free; after the list, none). jobPolls: status polls a started runner stays "running".
 *  stopAfterReleases: stop the manager after this many releases.
 * @param {{ config?: any, leases?: any[], jobPolls?: number, held?: any[], list?: any[], saved?: any, initial?: Record<string, string>,
 *   stopAfterReleases?: number, timing?: any, github?: any }} [opts] */
function fixture({ config = CONFIG, leases = [{ vm: "ci-1", lease: "l-1" }], jobPolls = 2, held = [], list = [], saved = {}, initial = {}, stopAfterReleases = 1, timing = {}, github = {} } = {}) {
	const events = [], logs = [];
	const queue = [...leases];
	/** @type {Record<string, { started: boolean, polls: number }>} */
	const vm = {};
	let releases = 0, ids = 100;
	/** @type {import("../host/runners.mjs").RunnerManager} */
	let manager;
	const pool = {
		acquire: async (only) => {
			events.push(["acquire", only]);
			const l = queue.length ? queue.shift() : null;
			return l && { ...l, expires: Math.floor(Date.now() / 1000) + 3600 };
		},
		renew: async (lease) => { events.push(["renew", lease]); return Math.floor(Date.now() / 1000) + 3600; },
		release: async (lease) => { events.push(["release", lease]); if (++releases >= stopAfterReleases) manager.stop(); },
		held: () => held,
	};
	const guest = {
		status: async (name) => {
			const v = (vm[name] ??= { started: false, polls: 0 });
			let s;
			if (initial[name]) { s = initial[name]; delete initial[name]; }
			else if (!v.started) s = "none";
			else s = ++v.polls > jobPolls ? "exited" : "running";
			events.push(["status", name, s]);
			return s;
		},
		start: async (name, jit) => { events.push(["start", name, jit]); (vm[name] ??= { started: false, polls: 0 }).started = true; },
		stop: async (name) => { events.push(["stop", name]); },
	};
	const gh = {
		generateJitConfig: async (opts) => { events.push(["generate", opts]); const id = ++ids; return { id, name: opts.name, encoded: jitConfig(opts.name) }; },
		list: async () => { events.push(["list"]); return list; },
		get: async (id) => { events.push(["get", id]); return { id, busy: false, status: "online", name: "x" }; },
		remove: async (id) => { events.push(["remove", id]); return true; },
		...github,
	};
	manager = new R.RunnerManager({
		config, github: gh, pool, guest, arch: "x64", log: (m) => logs.push(m), sleep: scaledSleep(events), random: () => "abc123",
		savedRunners: saved, timing,
	});
	const kinds = (...want) => events.filter((e) => want.includes(e[0]));
	return { manager, events, logs, kinds, vm };
}

it("a slot's full cycle: lease → JIT config → runner started → exit → registration deleted → lease released", async () => {
	const f = fixture();
	await f.manager.run();
	const seq = f.kinds("acquire", "generate", "start", "remove", "release").map((e) => e[0]);
	assert.deepEqual(seq, ["acquire", "generate", "start", "remove", "release"]);
	assert.deepEqual(f.kinds("acquire")[0][1], ["ci-1"], "leases only the configured runner VMs");
	const gen = f.kinds("generate")[0][1];
	assert.equal(gen.name, "boxery-test-ci-1-abc123");
	assert.deepEqual(gen.labels, ["self-hosted", "linux", "x64", "boxery", "gpu"]);
	assert.equal(gen.group, 1);
	// The runner is started with updates off (the image pins its version), and nothing else changed.
	const [, name, jit] = f.kinds("start")[0];
	assert.equal(name, "ci-1");
	const files = unb64(jit);
	assert.deepEqual(unb64(files[".runner"]), { AgentName: gen.name, Ephemeral: true, DisableUpdate: true });
	assert.equal(files[".credentials"], unb64(jitConfig(gen.name))[".credentials"]);
	assert.deepEqual(f.kinds("status").map((e) => e[2]), ["none", "running", "running", "exited"]);
	assert.deepEqual(f.kinds("remove")[0], ["remove", 101]);
	assert.deepEqual(f.kinds("release")[0], ["release", "l-1"]);
	assert.ok(f.logs.some((l) => /ci-1: runner boxery-test-ci-1-abc123 waiting for a job/.test(l)));
	for (const l of f.logs) assert.ok(!l.includes(jit) && !l.includes("cred-"), `a log line carries the JIT config: ${l}`);
});

it("no free VM: backs off 5 s, doubling to 60 s, and says so once", async () => {
	const f = fixture({ leases: [null, null, null, null, null, null, { vm: "ci-1", lease: "l-1" }] });
	await f.manager.run();
	const before = f.events.findIndex((e) => e[0] === "generate");
	assert.deepEqual(f.events.slice(0, before).filter((e) => e[0] === "sleep" && e[1] !== RENEW_SLEEP).map((e) => e[1]), [5000, 10000, 20000, 40000, 60000, 60000]);
	assert.equal(f.logs.filter((l) => /no free runner VM/.test(l)).length, 1);
	assert.equal(f.kinds("release").length, 1);
});

it("GitHub API errors: the clean VM is kept, retries back off, a rate limit's reset is honoured", async () => {
	let calls = 0;
	const f = fixture({ github: {
		generateJitConfig: async (opts) => {
			calls++;
			if (calls <= 2) throw new R.GitHubError("POST repos/o/r/actions/runners/generate-jitconfig: 502 Bad Gateway", { status: 502 });
			if (calls === 3) throw new R.GitHubError("POST repos/o/r/actions/runners/generate-jitconfig: 403 API rate limit exceeded", { status: 403, retryAfter: 42 });
			return { id: 7, name: opts.name, encoded: jitConfig(opts.name) };
		},
	} });
	await f.manager.run();
	assert.equal(calls, 4);
	assert.equal(f.kinds("acquire").length, 1, "one lease across the retries");
	const start = f.events.findIndex((e) => e[0] === "start");
	const slept = f.events.slice(0, start).filter((e) => e[0] === "sleep" && e[1] !== RENEW_SLEEP).map((e) => e[1]);
	assert.deepEqual(slept, [10000, 20000, 42000]);
	assert.ok(f.logs.some((l) => /retrying in 10s: .*502/.test(l)) && f.logs.some((l) => /retrying in 42s: .*rate limit/.test(l)));
	assert.deepEqual(f.kinds("release").map((e) => e[1]), ["l-1"]);
});

it("a job longer than the lease: renewed at a third of the TTL until the runner exits", async () => {
	const f = fixture({ config: { ...CONFIG, ttl: 60 }, jobPolls: 40, timing: { poll: 15000 } }); // 40 × 15 ms polls; ttl 60 → renew every 20 ms
	await f.manager.run();
	const firstRelease = f.events.findIndex((e) => e[0] === "release");
	const lastRunning = f.events.findLastIndex((e) => e[0] === "status" && e[2] === "running");
	assert.ok(firstRelease > lastRunning, "released only after the runner exited");
	assert.ok(f.kinds("renew").length >= 10, `renewed ${f.kinds("renew").length} times`);
	assert.ok(f.events.slice(firstRelease).every((e) => e[0] !== "renew"), "no renewal after the release");
});

it("restart: adopts a VM whose runner still runs, releases other leftovers, deletes only its own offline registrations", async () => {
	const f = fixture({
		config: { ...CONFIG, vms: ["ci-1", "ci-2"], count: 2 },
		leases: [],
		held: [
			{ name: "ci-1", state: "LEASED", lease_id: "l-a", expires_at: 9e9 },
			{ name: "ci-2", state: "LEASED", lease_id: "l-b", expires_at: 9e9 },
			{ name: "ci-3", state: "RESETTING", lease_id: null, expires_at: null },
		],
		initial: { "ci-1": "running", "ci-2": "exited" },
		saved: { "ci-1": { runner_id: 7, runner: "boxery-test-ci-1-old" } },
		list: [
			{ id: 7, name: "boxery-test-ci-1-old", status: "online", busy: true },
			{ id: 8, name: "boxery-test-ci-2-gone", status: "offline", busy: false },
			{ id: 9, name: "other-host-ci-1-x", status: "offline", busy: false },
			{ id: 10, name: "boxery-test-ci-1-live", status: "online", busy: false },
			{ id: 11, name: "boxery-tester-ci-1-x", status: "offline", busy: false },
		],
		stopAfterReleases: 2,
	});
	// The adopted runner (ci-1) stays running for 2 polls, then exits.
	f.vm["ci-1"] = { started: true, polls: 0 };
	await f.manager.run();
	assert.deepEqual(f.kinds("release").map((e) => e[1]), ["l-b", "l-a"], "ci-2's leftover lease at once; ci-1's after its job");
	assert.deepEqual(f.kinds("remove").map((e) => e[1]), [8, 7], "only our own offline registration, then the adopted runner's when it is done");
	assert.ok(!f.kinds("generate").some((e) => e[1].name.includes("ci-1")), "no new runner for the adopted VM while its job runs");
	assert.ok(f.logs.some((l) => /ci-1: adopting its running runner boxery-test-ci-1-old/.test(l)));
});

it("a VM without the runner layer is given back and not leased again", async () => {
	const f = fixture({ config: { ...CONFIG, vms: ["ci-1", "ci-2"], count: 1 }, leases: [{ vm: "ci-1", lease: "l-1" }, { vm: "ci-2", lease: "l-2" }], initial: { "ci-1": "missing" }, stopAfterReleases: 2 });
	await f.manager.run();
	assert.deepEqual(f.kinds("acquire").map((e) => e[1]), [["ci-1", "ci-2"], ["ci-2"]]);
	assert.deepEqual(f.kinds("release").map((e) => e[1]), ["l-1", "l-2"]);
	assert.ok(f.logs.some((l) => /ci-1: has no GitHub runner/.test(l)));
});

it("an unreachable VM: given back after a few polls, its registration deleted", async () => {
	const f = fixture({ timing: { unreachable: 3 } });
	const status = [];
	f.manager.guest.status = async (name) => { const s = status.length ? "unreachable" : "none"; status.push(s); f.events.push(["status", name, s]); return s; };
	await f.manager.run();
	assert.deepEqual(status, ["none", "unreachable", "unreachable", "unreachable"]);
	assert.deepEqual(f.kinds("stop", "remove", "release").map((e) => e[0]), ["stop", "remove", "release"]);
});

for (const busy of [false, true]) {
	it(`shutdown: ${busy ? "a busy runner keeps its VM for the next manager" : "an idle runner is stopped, deregistered and its VM released"}`, async () => {
		const f = fixture({ jobPolls: 1000, github: { get: async (id) => ({ id, busy, status: "online", name: "x" }) } });
		const running = f.manager.run();
		while (!f.kinds("status").some((e) => e[2] === "running")) await new Promise((r) => setTimeout(r, 5));
		f.manager.stop();
		await running;
		if (busy) {
			assert.deepEqual(f.kinds("stop", "remove", "release"), []);
			assert.ok(f.logs.some((l) => /running a job; leaving it/.test(l)));
		} else assert.deepEqual(f.kinds("stop", "remove", "release").map((e) => e[0]), ["stop", "remove", "release"]);
	});
}

it("a restart (stop without release) leaves every lease for the next manager", async () => {
	const f = fixture({ jobPolls: 1000 });
	const running = f.manager.run();
	while (!f.kinds("status").some((e) => e[2] === "running")) await new Promise((r) => setTimeout(r, 5));
	f.manager.stop({ release: false });
	await running;
	assert.deepEqual(f.kinds("get", "stop", "remove", "release"), [], "not even a busy check: an upgrade holds the host-wide lock");
	assert.ok(f.logs.some((l) => /ci-1: restarting; left for the next manager/.test(l)));
});

// ---------------------------------------------------------------- pure helpers
it("disableUpdates sets DisableUpdate in .runner (any case, BOM), and passes on configs it doesn't know", () => {
	const runner = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ AgentName: "a", disableUpdate: false }))]).toString("base64");
	const out = R.disableUpdates(b64({ ".runner": runner, ".credentials": "Y3JlZA==" }));
	assert.equal(out.patched, true);
	assert.deepEqual(unb64(unb64(out.encoded)[".runner"]), { AgentName: "a", DisableUpdate: true });
	assert.equal(unb64(out.encoded)[".credentials"], "Y3JlZA==");
	for (const odd of ["not base64 json", b64({ other: "x" }), b64({ ".runner": b64("[1]") })]) assert.deepEqual(R.disableUpdates(odd), { encoded: odd, patched: false });
});

it("checkConfig: one of repo/org, runner VMs, count ≤ VMs, safe labels, https API", () => {
	const ok = R.checkConfig({ repo: "o/r", vms: ["ci-1", "ci-2", "ci-1"], prefix: "boxery-h" });
	assert.deepEqual(ok, { repo: "o/r", vms: ["ci-1", "ci-2"], count: 2, labels: [], group: 1, ttl: 1800, api: "https://api.github.com", prefix: "boxery-h" });
	assert.equal(R.checkConfig({ org: "acme", vms: ["ci-1"], prefix: "p", api: "http://127.0.0.1:9/" }).api, "http://127.0.0.1:9");
	for (const [bad, why] of /** @type {Array<[any, RegExp]>} */ ([
		[{ vms: ["ci-1"], prefix: "p" }, /--repo/], [{ repo: "o/r", org: "x", vms: ["ci-1"], prefix: "p" }, /one of/],
		[{ repo: "o", vms: ["ci-1"], prefix: "p" }, /repository/], [{ repo: "o/r", vms: [], prefix: "p" }, /--vms/],
		[{ repo: "o/r", vms: ["ci-1"], count: 2, prefix: "p" }, /--count/], [{ repo: "o/r", vms: ["ci-1"], labels: ["a,b"], prefix: "p" }, /labels/],
		[{ repo: "o/r", vms: ["ci-1"], api: "http://github.example.com", prefix: "p" }, /--api/], [{ repo: "o/r", vms: ["ci-1"], prefix: "Bad!" }, /--prefix/],
	])) assert.match(R.checkConfig(bad), why);
	assert.equal(R.defaultPrefix(null, "Build-Box.example.com"), "boxery-build-box");
	assert.equal(R.defaultPrefix("ci", "h"), "boxery-h-ci");
	assert.ok(R.defaultPrefix(null, "x".repeat(60)).length <= 24);
	assert.deepEqual(R.runnerLabels(["Linux", "gpu", "GPU"], "arm64"), ["self-hosted", "linux", "arm64", "boxery", "gpu"]);
	assert.equal(R.guestArch({ BOXERY_BACKEND: "lima", BOXERY_LIMA_ARCH: "aarch64" }, "x64"), "arm64");
	assert.equal(R.guestArch({}, "arm64"), "arm64");
});

it("the token file: 0600 only, first line of stdin, never echoed", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-runners-token-"));
	try {
		assert.equal(R.readGithubToken(dir), null);
		R.writeGithubToken(dir, `\n${TOKEN}\nignored\n`);
		assert.equal(statSync(path.join(dir, R.TOKEN_FILE)).mode & 0o777, 0o600);
		assert.equal(R.readGithubToken(dir), TOKEN);
		chmodSync(path.join(dir, R.TOKEN_FILE), 0o644);
		assert.throws(() => R.readGithubToken(dir), /readable by other users/);
		assert.throws(() => R.writeGithubToken(dir, "not a token\n"), (/** @type {any} */ e) => /expected a GitHub token/.test(e.message) && !e.message.includes("not a token"));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- GitHub client
/** A stub GitHub API on loopback: routes[METHOD path] → (req, body) => [status, json, headers]. */
async function stubGitHub(routes) {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => { body += d; });
		req.on("end", () => {
			const parsed = body ? JSON.parse(body) : null;
			requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
			const key = `${req.method} ${req.url?.replace(/\?.*/, "")}`;
			const route = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith("/:id") && key.startsWith(k.slice(0, -3)) && /\/\d+$/.test(key))?.[1];
			const [status, json, headers = {}] = route ? route(req, parsed) : [404, { message: "Not Found" }];
			res.writeHead(status, { "Content-Type": "application/json", ...headers });
			res.end(status === 204 ? undefined : JSON.stringify(json));
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
	return { server, requests, api: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}` };
}

it("the GitHub client: headers, the JIT request, pagination, 404s, rate limits; errors never carry the token", async () => {
	const many = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, name: `r${i}`, status: "offline", busy: false }));
	const gh = await stubGitHub({
		"POST /repos/o/r/actions/runners/generate-jitconfig": (_req, body) => [201, { runner: { id: 5, name: body.name }, encoded_jit_config: "ZW5j" }],
		"GET /repos/o/r/actions/runners": (req) => { const page = Number(new URL(req.url, "http://x").searchParams.get("page")); return [200, { total_count: 150, runners: many.slice((page - 1) * 100, page * 100) }]; },
		"GET /repos/o/r/actions/runners/:id": (req) => (req.url.endsWith("/404") ? [404, { message: "Not Found" }] : [200, { id: 5, busy: true }]),
		"DELETE /repos/o/r/actions/runners/:id": (req) => (req.url.endsWith("/404") ? [404, { message: "Not Found" }] : [204, null]),
	});
	try {
		const client = R.createGitHub({ api: gh.api, repo: "o/r", token: () => TOKEN });
		assert.deepEqual(await client.generateJitConfig({ name: "n1", labels: ["self-hosted", "boxery"], group: 1 }), { id: 5, name: "n1", encoded: "ZW5j" });
		const post = gh.requests[0];
		assert.deepEqual(post.body, { name: "n1", runner_group_id: 1, labels: ["self-hosted", "boxery"], work_folder: "_work" });
		assert.equal(post.headers.authorization, `Bearer ${TOKEN}`);
		assert.equal(post.headers["x-github-api-version"], R.API_VERSION);
		assert.equal(post.headers.accept, "application/vnd.github+json");
		assert.equal((await client.list()).length, 150);
		assert.deepEqual(gh.requests.slice(1, 3).map((r) => r.url), ["/repos/o/r/actions/runners?per_page=100&page=1", "/repos/o/r/actions/runners?per_page=100&page=2"]);
		assert.equal((await client.get(5)).busy, true);
		assert.equal(await client.get(404), null);
		assert.equal(await client.remove(5), true);
		assert.equal(await client.remove(404), false);

		const org = R.createGitHub({ api: gh.api, org: "acme", token: () => TOKEN, now: () => 1000_000 });
		gh.server.removeAllListeners("request");
		gh.server.on("request", (req, res) => {
			res.writeHead(403, { "Content-Type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1060" });
			res.end(JSON.stringify({ message: `API rate limit exceeded\nfor ${req.url}` }));
		});
		const err = await org.generateJitConfig({ name: "n", labels: ["x"], group: 2 }).then(() => null, (e) => e);
		assert.ok(err instanceof R.GitHubError);
		assert.equal(err.status, 403);
		assert.equal(err.retryAfter, 60);
		assert.match(err.message, /^POST orgs\/acme\/actions\/runners\/generate-jitconfig: 403 API rate limit exceeded for/);
		assert.ok(!err.message.includes(TOKEN));
		const none = await R.createGitHub({ api: gh.api, repo: "o/r", token: () => null }).list().then(() => null, (e) => e);
		assert.match(none.message, /no GitHub token/);
		const down = await R.createGitHub({ api: "http://127.0.0.1:9", repo: "o/r", token: () => TOKEN }).list().then(() => null, (e) => e);
		assert.match(down.message, /unreachable/);
		assert.ok(!down.message.includes(TOKEN));
	} finally { gh.server.close(); }
});

// ---------------------------------------------------------------- end to end: the real boxery-host
const HOST = path.resolve(import.meta.dirname, "../host/boxery-host");
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIleasekeyoneleasekeyone holder";
let dir, conf, vms, env, children;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what) {
	for (let i = 0; i < 600; i++) { if (fn()) return; await pause(25); }
	throw new Error(`timed out waiting for ${what}`);
}
function run(args, input = "") {
	const child = spawn(HOST, args, { env, stdio: ["pipe", "pipe", "pipe"] });
	children.push(child);
	let stdout = "", stderr = "";
	child.stdout.on("data", (d) => { stdout += d; });
	child.stderr.on("data", (d) => { stderr += d; });
	child.stdin.end(input);
	const result = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
	return Object.assign(child, { result, output: () => stderr });
}
async function ok(args, input) {
	const r = await run(args, input).result;
	assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

beforeEach(() => {
	if (!R) return;
	dir = mkdtempSync(path.join(tmpdir(), "boxery-runners-"));
	conf = path.join(dir, "conf"); vms = path.join(dir, "vms"); children = [];
	mkdirSync(conf); mkdirSync(vms); mkdirSync(path.join(dir, "bin"));
	writeFileSync(path.join(vms, ".base"), "");
	writeFileSync(path.join(conf, "mgmt_ed25519"), "");
	writeFileSync(path.join(conf, "mgmt_ed25519.pub"), KEY.replace("holder", "management"));
	writeFileSync(path.join(conf, "authorized_keys"), "");
	// ssh stub: runs the command in the fake VM's home; boxery-runner (image/layers/github-runner.sh) is
	// simulated: start keeps its stdin (the JIT config), status reports .runner-done, stop is logged.
	writeFileSync(path.join(dir, "bin", "ssh"), `#!/usr/bin/env bash
port=""; while [ $# -gt 0 ]; do case $1 in -p) port=$2; shift 2 ;; -o|-F|-i) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
case "$*" in *cloud-init*|*6080*) exit 0 ;; esac
for d in "$BOXERY_FAKE_DIR"/*/; do
  if [ "$(cat "$d/port" 2>/dev/null)" = "$port" ]; then
    mkdir -p "$d/home"; h="$d/home"
    case "$*" in
      *"boxery-runner start"*) cat >"$h/.runner-jit"; touch "$h/.runner-started"; echo "start $(basename "$d")" >>"$BOXERY_FAKE_DIR/../guest.log"; exit 0 ;;
      *"boxery-runner status"*) [ -e "$h/.runner-done" ] && exit 1; [ -e "$h/.runner-started" ] && exit 0; exit 2 ;;
      *"boxery-runner stop"*) echo "stop $(basename "$d")" >>"$BOXERY_FAKE_DIR/../guest.log"; exit 0 ;;
    esac
    cd "$h" && HOME="$h" exec bash -c "\${*:-true}"
  fi
done
exit 255
`, { mode: 0o755 });
	env = { ...process.env, BOXERY_CONF: conf, BOXERY_FAKE_DIR: vms, BOXERY_BACKEND: "fake", BOXERY_BOOT_ID: "test-boot", BOXERY_SSH_WAIT_TRIES: "1",
		BOXERY_RUNNERS_POLL: "0.05", PATH: `${path.join(dir, "bin")}:${process.env.PATH}` };
});
afterEach(async () => {
	if (!R) return;
	for (const c of children) if (c.exitCode == null && c.signalCode == null) c.kill("SIGKILL");
	await Promise.all(children.map((c) => c.result));
	rmSync(dir, { recursive: true, force: true });
});

/** Every file under DIR (recursively). @param {string} d @returns {string[]} */
const files = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));

it("end to end: boxery-host runners run serves jobs on a pool VM, survives a crash, and stops cleanly", async () => {
	let jits = 0;
	const gh = await stubGitHub({
		"GET /repos/o/r/actions/runners": () => [200, { total_count: 2, runners: [
			{ id: 99, name: "boxery-test-gone-aaaaaa", status: "offline", busy: false },
			{ id: 98, name: "someone-else-ci-1", status: "offline", busy: false },
		] }],
		"POST /repos/o/r/actions/runners/generate-jitconfig": (req, body) => {
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return [401, { message: "Bad credentials" }];
			jits++;
			return [201, { runner: { id: 100 + jits, name: body.name, status: "offline", busy: false }, encoded_jit_config: jitConfig(body.name) }];
		},
		"GET /repos/o/r/actions/runners/:id": () => [200, { id: 0, busy: false, status: "online" }],
		"DELETE /repos/o/r/actions/runners/:id": () => [204, null],
	});
	const home = path.join(vms, "ci-1", "home");
	const lease = () => L.heldBy(db, "github-runner");
	const db = L.open(path.join(conf, "leases.db"));
	try {
		await ok(["new", "ci-1"]); await ok(["new", "pet"]);
		await ok(["pool", "add", "ci-1"]); await ok(["pool", "add", "pet"]); // an agent's pool VM: never taken by the manager
		await ok(["runners", "config", "--repo", "o/r", "--vms", "ci-1", "--api", gh.api, "--prefix", "boxery-test", "--ttl", "60"]);
		const noToken = await run(["runners", "run"]).result;
		assert.equal(noToken.code, 1);
		assert.match(noToken.stderr, /no GitHub token/);
		await ok(["runners", "token"], `${TOKEN}\n`);

		// 1. A runner starts on ci-1 with a JIT config; the stale registration of ours is deleted, not anyone else's.
		const m1 = run(["runners", "run"]);
		await until(() => existsSync(path.join(home, ".runner-jit")), "the first runner");
		assert.deepEqual(gh.requests.filter((r) => r.method === "DELETE").map((r) => r.url), ["/repos/o/r/actions/runners/99"]);
		const post = gh.requests.find((r) => r.method === "POST");
		assert.match(post.body.name, /^boxery-test-ci-1-[0-9a-f]{6}$/);
		assert.deepEqual(post.body.labels.slice(0, 2), ["self-hosted", "linux"]);
		assert.ok(post.body.labels.includes("boxery"));
		const jit = readFileSync(path.join(home, ".runner-jit"), "utf8");
		assert.equal(unb64(unb64(jit)[".runner"]).DisableUpdate, true);
		assert.deepEqual(lease().map((r) => [r.name, r.state]), [["ci-1", "LEASED"]]);
		assert.equal(L.get(db, "pet").state, "FREE");
		const status = JSON.parse(await ok(["runners", "status", "--json"]));
		assert.equal(status.token, true);
		assert.deepEqual(status.vms_leased.map((v) => [v.name, v.lease, v.runner, v.phase]), [["ci-1", "leased", post.body.name, "running"]]);

		// 2. The manager dies mid-job; the next one adopts the running runner instead of resetting the VM.
		m1.kill("SIGKILL"); await m1.result;
		const m2 = run(["runners", "run"]);
		await until(() => /adopting its running runner/.test(m2.output()), "adoption");
		assert.equal(jits, 1);

		// 3. The job ends: registration deleted, lease released, VM reset (the runner's files are gone), next runner.
		writeFileSync(path.join(home, ".runner-done"), "");
		await until(() => jits === 2 && existsSync(path.join(home, ".runner-jit")) && !existsSync(path.join(home, ".runner-done")), "the second runner on a reset VM");
		assert.ok(gh.requests.some((r) => r.method === "DELETE" && r.url === "/repos/o/r/actions/runners/101"));
		assert.match(m2.output(), /ci-1 reset → FREE/);

		// 4. `runners stop` (it leaves runners.stopping, then SIGTERM) with an idle runner: stopped, deregistered, released.
		writeFileSync(path.join(conf, R.STOP_FILE), "stop\n");
		m2.kill("SIGTERM");
		const r2 = await m2.result;
		assert.equal(r2.code, 0, r2.stderr);
		assert.ok(gh.requests.some((r) => r.method === "DELETE" && r.url === "/repos/o/r/actions/runners/102"));
		assert.match(readFileSync(path.join(dir, "guest.log"), "utf8"), /stop ci-1/);
		assert.deepEqual(lease(), []);
		assert.equal(L.get(db, "ci-1").state, "FREE");
		assert.ok(!existsSync(path.join(conf, R.LOCK_FILE)));

		// The token never reached a VM, the managers' logs, or anything but GitHub's Authorization header.
		for (const f of files(vms)) assert.ok(!readFileSync(f).includes(TOKEN), `${f} carries the GitHub token`);
		for (const out of [m1.output(), m2.output(), JSON.stringify(status)]) {
			assert.ok(!out.includes(TOKEN), "a log carries the GitHub token");
			assert.ok(!out.includes(jit), "a log carries a JIT config");
		}
		assert.ok(gh.requests.every((r) => !JSON.stringify(r.body ?? "").includes(TOKEN) && !r.url.includes(TOKEN)));
	} finally { db.close(); gh.server.close(); }
});
