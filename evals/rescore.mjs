#!/usr/bin/env node
// Check a stored run again with the current cases, without running the agent again: after fixing
// or adding a check, rescore past runs so their results compare with new ones. Reads the full
// traces in out/<timestamp>/results.json (results/ keeps only scrubbed calls, not enough to check).
//
//   node rescore.mjs out/<timestamp> [out/<timestamp> …] [--save]
//
// Writes out/<timestamp>-rescored-v<SUITE_VERSION>/; --save also keeps it in results/ as
// <date>-<commit>-<model>-rescored-v<N>/. meta.rescored records the suite it first ran under and
// suiteCommit, the commit whose evals/ did the rescoring (boxery.commit stays the code under test).
// Cases the suite no longer has are dropped; cases added since aren't in the old run. A check that
// needs the run's work dir (gone by now) keeps its old result, if it existed then.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { cases } from "./cases.mjs";
import { ROOT, boxeryInfo, check, ctxFor, hostOf, saveResult, suiteInfo, writeOut } from "./lib/report.mjs";

const { values: opt, positionals } = parseArgs({
	allowPositionals: true,
	options: { save: { type: "boolean", default: false }, "allow-dirty": { type: "boolean", default: false } },
});
if (!positionals.length) throw new Error("usage: node rescore.mjs out/<timestamp> [...] [--save]");
const suite = suiteInfo();
if (opt.save && suite.dirty && !opt["allow-dirty"]) throw new Error("--save needs the suite committed, so its commit records the checks used (or pass --allow-dirty)");

for (const ref of positionals) {
	const dir = path.resolve(ref);
	if (!existsSync(path.join(dir, "results.json"))) throw new Error(`${ref} has no results.json (only out/ directories hold full traces)`);
	const old = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
	const { runs: before } = JSON.parse(readFileSync(path.join(dir, "results.json"), "utf8"));
	const options = old.options;
	const runs = before.flatMap((r) => {
		const c = cases.find((x) => x.id === r.id);
		return c ? [{ ...r, ...check(c, r, ctxFor(c, options, hostOf(old)), r.results) }] : [];
	});
	const meta = {
		...old,
		suite,
		rescored: { from: old.rescored?.from ?? old.suite, at: new Date().toISOString(), suiteCommit: boxeryInfo().commit },
		runs: runs.length,
		passed: runs.filter((r) => r.pass).length,
		cost: +runs.reduce((n, r) => n + r.cost, 0).toFixed(2),
	};
	const out = `${dir.replace(/-rescored-v\d+$/, "")}-rescored-v${suite.version}`;
	const card = writeOut(out, meta, runs);
	const changed = runs.filter((r) => r.pass !== before.find((b) => b.id === r.id && b.rep === r.rep)?.pass).length;
	console.error(`${path.relative(process.cwd(), dir)}: ${meta.passed}/${meta.runs} pass (${changed} runs changed) → ${path.relative(process.cwd(), out)}`);
	if (opt.save) console.error(`  saved ${path.relative(ROOT, saveResult(meta, card))}`);
}
