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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { cases } from "./cases.mjs";
import { ROOT, boxeryInfo, check, ctxFor, hostOf, saveResult, suiteInfo, summary, workDir, writeOut } from "./lib/report.mjs";

const SERVER = path.join(ROOT, "mcp/boxery-mcp.mjs");
// Local tools act on a throwaway work dir. In VMs only lookups run, unless a case sets `exec`:
// its prompt asks for something harmless, so vm_bash/vm_jobs/vm_browser may run on existing VMs.
const LOCAL = ["Read", "Glob", "Grep", "Edit", "Write", "Bash(git log:*)", "Bash(wc:*)", "Bash(ls:*)", "Bash(cat:*)"];
const VM_READ = ["mcp__boxery__vm_info", "mcp__boxery__vm_read", "mcp__boxery__vm_screenshot"];
const VM_EXEC = ["mcp__boxery__vm_bash", "mcp__boxery__vm_jobs", "mcp__boxery__vm_browser"];
const TIMEOUT_MS = 5 * 60_000;

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
const options = { repeat: Number(opt.repeat), only: opt.only ?? null, model: opt.model ?? null, toolSearch: opt["tool-search"] ?? null, vm: opt.vm, otherVm: opt["other-vm"] };

// What the results depend on, so a saved run can be recreated: the code under test (this checkout,
// minus evals/), the suite (evals/, minus outputs), the agent (CLI version + model) and the host.
const meta = {
	suite: suiteInfo(),
	boxery: { ...boxeryInfo(), host: tryJson("boxery", ["version", "--json"]) },
	claude: { cli: execFileSync("claude", ["--version"], { encoding: "utf8" }).replace(/\(Claude Code\)/, "").trim(), model: "" },
	node: process.version,
	platform: `${process.platform}-${process.arch}`,
	command: ["node", "evals/run.mjs", ...process.argv.slice(2)].join(" "),
	options,
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

/** Run one case once; resolve with its trace and check results. */
async function runOne(c, rep) {
	const dir = workDir();
	const ctx = ctxFor(c, options, hostOf(meta), dir);
	const mcp = path.join(dir, "..", `${path.basename(dir)}.mcp.json`);
	writeFileSync(mcp, JSON.stringify({ mcpServers: { boxery: { command: process.execPath, args: [SERVER, ...(ctx.defaultVm ? ["--vm", ctx.defaultVm] : [])] } } }));
	const args = ["-p", c.prompt(ctx), "--mcp-config", mcp, "--strict-mcp-config", "--setting-sources", "project", "--output-format", "stream-json", "--verbose", "--max-turns", "12",
		"--allowedTools", ...LOCAL, ...VM_READ, ...(c.exec ? VM_EXEC : [])];
	if (opt.model) args.push("--model", opt.model);
	const env = { ...process.env };
	if (opt["tool-search"]) env.ENABLE_TOOL_SEARCH = opt["tool-search"] === "off" ? "false" : "true";

	const t0 = Date.now();
	// stdout and stderr apart, so stderr can't split a stream-json line; stderr is appended after.
	const { raw, timedOut } = await new Promise((resolve) => {
		const p = spawn("claude", args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", err = "", timedOut = false;
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (err += d));
		const timer = setTimeout(() => ((timedOut = true), p.kill("SIGTERM")), TIMEOUT_MS);
		p.on("close", () => (clearTimeout(timer), resolve({ raw: out + (err && !out.endsWith("\n") ? "\n" : "") + err, timedOut })));
	});
	writeFileSync(path.join(outDir, "raw", `${c.id}.${rep}.jsonl`), raw);

	const t = parse(raw);
	if (timedOut) t.error = `timed out after ${TIMEOUT_MS / 1000} s`;
	const { results, pass } = check(c, t, ctx);
	rmSync(dir, { recursive: true, force: true });
	rmSync(mcp, { force: true });
	return { id: c.id, category: c.category, rep, pass, results, ms: Date.now() - t0, ...t };
}

/** stream-json transcript → { model, deferred, calls, final, cost, turns, error } */
function parse(raw) {
	let ended = false;
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
			ended = true;
			t.final = e.result ?? "";
			t.cost = e.total_cost_usd ?? 0;
			t.turns = e.num_turns ?? 0;
			for (const d of e.permission_denials ?? []) if (byId.has(d.tool_use_id)) byId.get(d.tool_use_id).denied = true;
			if (e.is_error && !t.error) t.error = e.subtype ?? "error";
		}
	}
	if (!t.model && !t.error) t.error = `no transcript: ${raw.slice(0, 200)}`;
	// A session that ends without a result event (killed, crashed) is judged on nothing, not on a partial trace.
	if (!ended && !t.error) t.error = "no result event (killed or crashed)";
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
Object.assign(meta, { finished: new Date().toISOString(), runs: runs.length, passed: runs.filter((r) => r.pass).length, cost: +runs.reduce((n, r) => n + r.cost, 0).toFixed(2) });
meta.claude.model = [...new Set(runs.map((r) => r.model).filter(Boolean))].join(",");
const card = writeOut(outDir, meta, runs);
console.log(summary(card, meta));
console.error(`\nwrote ${path.join(outDir, "summary.md")}`);
if (opt.save) console.error(`saved ${path.relative(ROOT, saveResult(meta, card))} and updated results/index.json`);
