#!/usr/bin/env node
// Saved results over time, from results/*/.
//
//   node history.mjs                   every saved result: model, commit, suite, pass rates, cost
//   node history.mjs --model opus      only models whose id contains "opus"
//   node history.mjs --case checkpoint one case's pass rate across results
//   node history.mjs --json            the history as JSON (what results/index.json holds)
//   node history.mjs --write-index     rebuild results/index.json (run.mjs --save does this too)
import { parseArgs } from "node:util";
import { frac, indexEntry, listResults, pct, writeIndex } from "./lib/results.mjs";

const { values: opt } = parseArgs({
	options: { model: { type: "string" }, case: { type: "string" }, json: { type: "boolean" }, "write-index": { type: "boolean" } },
});
if (opt["write-index"]) {
	const rows = writeIndex();
	console.error(`wrote results/index.json (${rows.length} results)`);
	process.exit(0);
}
const rows = listResults().map(indexEntry).filter((r) => !opt.model || r.model.includes(opt.model));
if (opt.json) {
	console.log(JSON.stringify(rows, null, 2));
	process.exit(0);
}
if (!rows.length) {
	console.log("No saved results yet. Make one with: node run.mjs --save");
	process.exit(0);
}

const table = (head, body) => {
	const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => String(r[i]).length)));
	for (const r of [head, ...body]) console.log(r.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd());
};
const when = (r) => r.started.slice(0, 16).replace("T", " ");
const at = (r) => `${r.commit.slice(0, 7)}${r.dirty ? "*" : ""}`;

if (opt.case) {
	const id = opt.case;
	table(["started", "model", "commit", "suite", "pass", "should"], rows.filter((r) => r.cases[id]).map((r) =>
		[when(r), r.model, at(r), `v${r.suite.version}`, frac(r.cases[id].passed, r.cases[id].runs), frac(r.cases[id].shouldOk, r.cases[id].shouldTotal)]));
} else {
	table(["id", "model", "commit", "suite", "runs", "pass", "should", "cost"], rows.map((r) =>
		[r.id, r.model, at(r), `v${r.suite.version}`, r.runs, pct(r.passed, r.runs), pct(r.should.ok, r.should.total), `$${r.cost}`]));
}
if (rows.some((r) => r.dirty)) console.log("\n* run with uncommitted changes (--allow-dirty): the commit alone doesn't recreate it");
