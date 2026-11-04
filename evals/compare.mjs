#!/usr/bin/env node
// Compare two results case by case: what got better or worse between commits, suites or models.
//
//   node compare.mjs                              the latest result vs the previous one of the same model
//   node compare.mjs previous:opus latest:opus    two results by reference
//   node compare.mjs latest:haiku latest:opus     two models
//   node compare.mjs results/<id> out/<timestamp> a saved result vs a local run
//
// A reference is an id in results/, a directory holding meta.json + scorecard.json (results/ or
// out/), latest, or latest:MODEL / previous:MODEL, where MODEL matches part of the model id.
import { caseStats, frac, listResults, pct, resolve } from "./lib/results.mjs";

let [a, b] = process.argv.slice(2);
if (!b) {
	const latest = resolve(a ?? "latest");
	const model = latest.meta.claude.model;
	if (!listResults().some((r) => r.meta.claude.model === model && r.dir !== latest.dir)) {
		console.error(`Only one saved result for ${model} (${latest.id}). Name two to compare, e.g. node compare.mjs latest:haiku latest:opus`);
		process.exit(1);
	}
	[a, b] = [`previous:${model}`, latest.dir];
}
const A = resolve(a);
const B = resolve(b);
const sa = caseStats(A.card);
const sb = caseStats(B.card);

const label = (r) => `${r.id}: ${r.meta.claude.model}, ${r.meta.boxery.commit.slice(0, 7)}${r.meta.boxery.dirty || r.meta.suite.dirty ? "*" : ""}, suite v${r.meta.suite.version} ${r.meta.suite.hash}, Claude Code ${r.meta.claude.cli}`;
console.log(`A  ${label(A)}\nB  ${label(B)}\n`);
for (const [k, what] of [["version", "suite versions"], ["hash", "suite files"]])
	if (A.meta.suite[k] !== B.meta.suite[k]) console.log(`note: different ${what}, so a change may come from the cases rather than boxery or the model`);

const ids = [...new Set([...Object.keys(sa), ...Object.keys(sb)])];
const rate = (s) => (s && s.runs ? s.passed / s.runs : null);
const rows = ids.map((id) => {
	const [x, y] = [sa[id], sb[id]];
	const [ra, rb] = [rate(x), rate(y)];
	const d = ra === null || rb === null ? "new/gone" : rb > ra ? "better" : rb < ra ? "WORSE" : "";
	const ds = x && y && x.shouldTotal && y.shouldTotal ? Math.sign(y.shouldOk / y.shouldTotal - x.shouldOk / x.shouldTotal) : 0;
	return [id, x ? frac(x.passed, x.runs) : "–", y ? frac(y.passed, y.runs) : "–", x ? frac(x.shouldOk, x.shouldTotal) : "–", y ? frac(y.shouldOk, y.shouldTotal) : "–", [d, ds > 0 ? "should up" : ds < 0 ? "should down" : ""].filter(Boolean).join(", ")];
});
const head = ["case", "A pass", "B pass", "A should", "B should", "change"];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
for (const r of [head, ...rows]) console.log(r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd());

const tot = (s) => Object.values(s).reduce((t, c) => ({ runs: t.runs + c.runs, passed: t.passed + c.passed, ok: t.ok + c.shouldOk, n: t.n + c.shouldTotal }), { runs: 0, passed: 0, ok: 0, n: 0 });
const [ta, tb] = [tot(sa), tot(sb)];
console.log(`\nall    A ${pct(ta.passed, ta.runs)} pass, ${pct(ta.ok, ta.n)} should   B ${pct(tb.passed, tb.runs)} pass, ${pct(tb.ok, tb.n)} should`);
console.log("Agents vary between runs: a one-run change in a case is noise until it repeats.");
