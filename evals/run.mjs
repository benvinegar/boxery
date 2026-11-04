#!/usr/bin/env node
// Behavioural evals for the boxery MCP server. Each case's prompt goes to a fresh headless
// `claude -p` session that has only boxery-mcp loaded; the tools it calls are checked against
// what we'd want (cases.mjs). Talks to real VMs and spends tokens, so it's not part of `npm test`.
//
// Tools that aren't allowed are denied (in -p mode a denied call is still in the transcript), so a
// run shows what the agent tries to do without creating, forking or changing VMs.
//
// Everything a run produces goes to out/<timestamp>/ (ignored by git: transcripts hold VM contents
// and local paths). --save also writes results/<date>-<commit>-<model>/: the run's metadata, and
// per-run check results and tool calls with their arguments reduced to what's safe to publish,
// and adds it to results/index.json. history.mjs and compare.mjs read those.
//
//   node evals/run.mjs [--repeat 3] [--concurrency 4] [--only id,id] [--model NAME]
//                      [--vm demo] [--other-vm hunk-perf] [--tool-search on|off] [--out DIR]
//                      [--save [--allow-dirty]]
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { SUITE_VERSION, cases } from "./cases.mjs";
import { RESULTS, writeIndex } from "./lib/results.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER = path.join(ROOT, "mcp/boxery-mcp.mjs");
// Local tools act on a throwaway work dir. In VMs only lookups run, unless a case sets `exec`:
// its prompt asks for something harmless, so vm_bash/vm_jobs/vm_browser may run on existing VMs.
const LOCAL = ["Read", "Glob", "Grep", "Edit", "Write", "Bash(git log:*)", "Bash(wc:*)", "Bash(ls:*)", "Bash(cat:*)"];
const VM_READ = ["mcp__boxery__vm_info", "mcp__boxery__vm_read", "mcp__boxery__vm_screenshot"];
const VM_EXEC = ["mcp__boxery__vm_bash", "mcp__boxery__vm_jobs", "mcp__boxery__vm_browser"];
const TIMEOUT_MS = 5 * 60_000;
/** Tool arguments that say how boxery was used and are safe to publish; commands, file contents and answers stay in out/. */
const PUBLIC_ARGS = ["action", "vm", "to", "host", "headless", "use", "shape", "snapshot", "spec", "readonly", "timeout"];
const TMP = [tmpdir(), "/private/var/folders", "/var/folders", "/private/tmp", "/tmp"].map((p) => path.resolve(p));
const scrub = (v) =>
	typeof v === "string" ? TMP.reduce((s, p) => s.split(p).join("<tmp>"), v).replace(/<tmp>[^\s"'=]*/g, "<tmp>").split(homedir()).join("~")
	: Array.isArray(v) ? v.map(scrub) : v;

const { values: opt } = parseArgs({
	options: {
		repeat: { type: "string", default: "3" },
		concurrency: { type: "string", default: "4" },
		only: { type: "string" },
		model: { type: "string" },
		vm: { type: "string", default: "demo" },
		"other-vm": { type: "string", default: "hunk-perf" },
		"tool-search": { type: "string" },
		out: { type: "string" },
		save: { type: "boolean", default: false },
		"allow-dirty": { type: "boolean", default: false },
	},
});
const only = opt.only?.split(",");
const selected = cases.filter((c) => !only || only.includes(c.id));
if (!selected.length) throw new Error(`no cases match --only ${opt.only}`);
const started = new Date();
const outDir = path.resolve(opt.out ?? path.join(import.meta.dirname, "out", started.toISOString().replace(/[:.]/g, "-")));

// What the results depend on, so a saved run can be recreated: the code under test (this checkout,
// minus evals/), the suite (evals/, minus outputs), the agent (CLI version + model) and the host.
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
const dirty = (...paths) => git("status", "--porcelain", "--", ...paths).length > 0;
const meta = {
	suite: {
		version: SUITE_VERSION,
		hash: createHash("sha256").update(["cases.mjs", "run.mjs"].map((f) => readFileSync(path.join(import.meta.dirname, f), "utf8")).join("\0")).digest("hex").slice(0, 12),
		dirty: dirty("evals", ":!evals/results", ":!evals/out"),
	},
	boxery: { commit: git("rev-parse", "HEAD"), describe: git("describe", "--tags", "--always"), dirty: dirty(".", ":!evals"), host: tryJson("boxery", ["version", "--json"]) },
	claude: { cli: execFileSync("claude", ["--version"], { encoding: "utf8" }).replace(/\(Claude Code\)/, "").trim(), model: "" },
	node: process.version,
	platform: `${process.platform}-${process.arch}`,
	command: ["node", "evals/run.mjs", ...process.argv.slice(2)].join(" "),
	options: { repeat: Number(opt.repeat), only: opt.only ?? null, model: opt.model ?? null, toolSearch: opt["tool-search"] ?? null, vm: opt.vm, otherVm: opt["other-vm"] },
	started: started.toISOString(),
	finished: "",
	runs: 0,
	passed: 0,
	cost: 0,
};
if (opt.save && (meta.suite.dirty || meta.boxery.dirty) && !opt["allow-dirty"])
	throw new Error("--save needs a clean checkout so the commit recreates the run (commit first, or pass --allow-dirty)");
mkdirSync(path.join(outDir, "raw"), { recursive: true });

function tryJson(cmd, args) {
	try {
		return JSON.parse(execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
	} catch {
		return null;
	}
}

/** A throwaway project for the session to work in: package.json, a source file, one commit. */
function workDir() {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-eval-"));
	const pkg = JSON.stringify({ name: "toy", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n";
	writeFileSync(path.join(dir, "package.json"), pkg);
	writeFileSync(path.join(dir, "index.test.js"), 'import test from "node:test";\nimport assert from "node:assert";\ntest("adds", () => assert.equal(1 + 1, 2));\n');
	const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("add", ".");
	git("-c", "user.name=eval", "-c", "user.email=eval@example.com", "commit", "-qm", "initial toy project");
	return { dir, pkgLines: pkg.split("\n").length - 1 };
}

/** Run one case once; resolve with its trace and check results. */
async function runOne(c, rep) {
	const { dir, pkgLines } = workDir();
	const ctx = { vm: opt.vm, otherVm: opt["other-vm"], defaultVm: c.cfg === "vm" ? opt.vm : undefined, workDir: dir, pkgLines, token: "npm_FAKEtok3nForEvalOnly000000000000" };
	const mcp = path.join(dir, "..", `${path.basename(dir)}.mcp.json`);
	writeFileSync(mcp, JSON.stringify({ mcpServers: { boxery: { command: process.execPath, args: [SERVER, ...(ctx.defaultVm ? ["--vm", ctx.defaultVm] : [])] } } }));
	const args = ["-p", c.prompt(ctx), "--mcp-config", mcp, "--strict-mcp-config", "--setting-sources", "project", "--output-format", "stream-json", "--verbose", "--max-turns", "12",
		"--allowedTools", ...LOCAL, ...VM_READ, ...(c.exec ? VM_EXEC : [])];
	if (opt.model) args.push("--model", opt.model);
	const env = { ...process.env };
	if (opt["tool-search"]) env.ENABLE_TOOL_SEARCH = opt["tool-search"] === "off" ? "false" : "true";

	const t0 = Date.now();
	const raw = await new Promise((resolve) => {
		const p = spawn("claude", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (out += d));
		const timer = setTimeout(() => p.kill("SIGTERM"), TIMEOUT_MS);
		p.on("close", () => (clearTimeout(timer), resolve(out)));
	});
	writeFileSync(path.join(outDir, "raw", `${c.id}.${rep}.jsonl`), raw);

	const t = parse(raw);
	const results = c.checks.map((k) => {
		try {
			return { level: k.level, name: k.name, ok: !!k.test(t, ctx) };
		} catch (e) {
			return { level: k.level, name: k.name, ok: false, error: String(e.message ?? e) };
		}
	});
	rmSync(dir, { recursive: true, force: true });
	rmSync(mcp, { force: true });
	const pass = !t.error && results.every((r) => r.level !== "must" || r.ok);
	return { id: c.id, category: c.category, rep, pass, results, ms: Date.now() - t0, ...t };
}

/** stream-json transcript → { model, deferred, calls, final, cost, turns, error } */
function parse(raw) {
	const t = { model: "", deferred: false, calls: /** @type {{ tool: string, input: any, denied: boolean, error: boolean }[]} */ ([]), final: "", cost: 0, turns: 0, error: "" };
	const byId = new Map();
	for (const line of raw.split("\n")) {
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "system" && e.subtype === "init") {
			t.model = e.model;
			if (!e.mcp_servers?.some((s) => s.name === "boxery" && s.status === "connected")) t.error = "boxery MCP server not connected";
		}
		for (const x of e.type === "assistant" ? e.message.content : []) {
			if (x.type !== "tool_use") continue;
			if (x.name === "ToolSearch") {
				t.deferred = true;
				continue;
			}
			const call = { tool: x.name.replace(/^mcp__boxery__/, ""), input: x.input, denied: false, error: false };
			byId.set(x.id, call);
			t.calls.push(call);
		}
		for (const x of e.type === "user" && Array.isArray(e.message?.content) ? e.message.content : [])
			if (x.type === "tool_result" && x.is_error && byId.has(x.tool_use_id)) byId.get(x.tool_use_id).error = true;
		if (e.type === "result") {
			t.final = e.result ?? "";
			t.cost = e.total_cost_usd ?? 0;
			t.turns = e.num_turns ?? 0;
			for (const d of e.permission_denials ?? []) if (byId.has(d.tool_use_id)) byId.get(d.tool_use_id).denied = true;
			if (e.is_error && !t.error) t.error = e.subtype ?? "error";
		}
	}
	if (!t.model && !t.error) t.error = `no transcript: ${raw.slice(0, 200)}`;
	return t;
}

/** Run fn over items, at most n at a time. */
async function pool(items, n, fn) {
	const out = [];
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	}));
	return out;
}

const repeat = Number(opt.repeat);
const jobs = selected.flatMap((c) => Array.from({ length: repeat }, (_, rep) => ({ c, rep })));
console.error(`${selected.length} cases × ${repeat} = ${jobs.length} runs → ${outDir}`);
let done = 0;
const runs = await pool(jobs, Number(opt.concurrency), async ({ c, rep }) => {
	const r = await runOne(c, rep);
	console.error(`[${++done}/${jobs.length}] ${r.pass ? "PASS" : "FAIL"} ${c.id}#${rep}${r.error ? ` (${r.error})` : ""}`);
	return r;
});
const runsAll = runs;
Object.assign(meta, { finished: new Date().toISOString(), runs: runs.length, passed: runs.filter((r) => r.pass).length, cost: +runs.reduce((n, r) => n + r.cost, 0).toFixed(2) });
meta.claude.model = [...new Set(runs.map((r) => r.model).filter(Boolean))].join(",");
const card = scorecard(runs);
writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ opt, runs }, null, 2));
writeFileSync(path.join(outDir, "scorecard.json"), JSON.stringify(card, null, 2) + "\n");
writeFileSync(path.join(outDir, "summary.md"), summary(card, true));
console.log(summary(card, false));
console.error(`\nwrote ${path.join(outDir, "summary.md")}`);
if (opt.save) {
	const base = path.join(RESULTS, `${meta.started.slice(0, 10)}-${meta.boxery.commit.slice(0, 7)}-${meta.claude.model.replace(/[^a-z0-9.-]+/gi, "_")}`);
	let dir = base;
	for (let i = 2; existsSync(dir); i++) dir = `${base}-${i}`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
	writeFileSync(path.join(dir, "scorecard.json"), JSON.stringify(card, null, 2) + "\n");
	writeFileSync(path.join(dir, "summary.md"), summary(card, false));
	writeIndex();
	console.error(`saved ${path.relative(ROOT, dir)} and updated results/index.json`);
}

/** Per-run results with tool arguments reduced to PUBLIC_ARGS: what results/ keeps. */
function scorecard(runs) {
	return cases.filter((c) => runs.some((r) => r.id === c.id)).map((c) => ({
		id: c.id,
		category: c.category,
		expect: c.expect,
		runs: runs.filter((r) => r.id === c.id).map((r) => ({
			rep: r.rep,
			pass: r.pass,
			error: r.error || undefined,
			checks: r.results.map(({ level, name, ok }) => ({ level, name, ok })),
			calls: r.calls.map((x) => ({ tool: x.tool, denied: x.denied || undefined, args: Object.fromEntries(PUBLIC_ARGS.filter((k) => x.input?.[k] !== undefined).map((k) => [k, scrub(x.input[k])])) })),
			turns: r.turns,
			cost: +r.cost.toFixed(4),
			ms: r.ms,
		})),
	}));
}

/** Markdown: the metadata, a table per case, then each run's tool calls (plus answers when private). */
function summary(card, withAnswers) {
	const runs = card.flatMap((c) => c.runs);
	const show = (x) => `${x.tool}${x.denied ? "✗" : ""}${Object.keys(x.args).length ? ` ${JSON.stringify(x.args)}` : ""}`;
	const shoulds = runs.flatMap((r) => r.checks.filter((x) => x.level === "should"));
	const lines = [
		`# boxery MCP evals`,
		``,
		`| | |`,
		`|---|---|`,
		`| model | ${meta.claude.model} (Claude Code ${meta.claude.cli}) |`,
		`| boxery | \`${meta.boxery.commit.slice(0, 12)}\` (${meta.boxery.describe})${meta.boxery.dirty ? ", uncommitted changes" : ""}; host ${meta.boxery.host?.host?.version ?? "?"} |`,
		`| suite | v${meta.suite.version}, \`${meta.suite.hash}\`${meta.suite.dirty ? ", uncommitted changes" : ""} |`,
		`| runs | ${runs.length}: ${runs.filter((r) => r.pass).length} passed every must check; should checks ${shoulds.filter((x) => x.ok).length}/${shoulds.length}; $${meta.cost} |`,
		`| command | \`${meta.command}\` |`,
		`| started | ${meta.started} |`,
		``,
		`✗ = call denied by the eval's permissions (shows intent only).`,
		``,
		`| case | category | pass | should | failed checks |`,
		`|---|---|---|---|---|`,
	];
	for (const c of card) {
		const sh = c.runs.flatMap((r) => r.checks.filter((x) => x.level === "should"));
		const failed = new Map();
		for (const r of c.runs) for (const x of r.checks) if (!x.ok) failed.set(`${x.level}: ${x.name}`, (failed.get(`${x.level}: ${x.name}`) ?? 0) + 1);
		for (const r of c.runs) if (r.error) failed.set(`error: ${r.error}`, (failed.get(`error: ${r.error}`) ?? 0) + 1);
		lines.push(`| ${c.id} | ${c.category} | ${c.runs.filter((r) => r.pass).length}/${c.runs.length} | ${sh.length ? `${sh.filter((x) => x.ok).length}/${sh.length}` : "–"} | ${[...failed].map(([k, n]) => `${k} (${n})`).join("<br>")} |`);
	}
	lines.push("", "## Runs", "");
	const full = withAnswers ? new Map(runsAll.map((r) => [`${r.id}#${r.rep}`, r])) : null;
	for (const c of card) {
		lines.push(`### ${c.id}`, "", `Expect: ${c.expect}`, "");
		for (const r of c.runs) {
			lines.push(`- **#${r.rep} ${r.pass ? "pass" : "FAIL"}**${r.error ? ` (${r.error})` : ""}`);
			const raw = full?.get(`${c.id}#${r.rep}`);
			r.calls.forEach((x, i) => {
				lines.push(`  - \`${show(x).replace(/`/g, "'")}\``);
				const cmd = raw?.calls[i]?.input?.command;
				if (cmd) lines.push(`    - \`$ ${String(cmd).replace(/\s+/g, " ").replace(/`/g, "'").slice(0, 200)}\``);
			});
			if (raw) lines.push(`  - → ${raw.final.replace(/\s+/g, " ").slice(0, 300)}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}
