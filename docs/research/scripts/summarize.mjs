#!/usr/bin/env node
// Derives a finding's `summary` from its valid runs, prints it as a table, and checks or rewrites it.
//
// usage: node summarize.mjs path/to/results.json [--write]
//
// One summary row per environment and setting, in the order they first appear in `runs`: the mean
// real/user/sys seconds, the real-time range, the kernel share sys / (user + sys), and the speedup
// over the metal environment at the same setting. Without --write it exits 1 when the stored summary
// differs, so a hand edit to a run can't leave the summary stale. Needs only Node.
import { readFileSync, writeFileSync } from "node:fs";

const [file, flag] = process.argv.slice(2);
if (!file || (flag && flag !== "--write")) {
  console.error("usage: node summarize.mjs path/to/results.json [--write]");
  process.exit(2);
}

/** @typedef {{ env: string, setting?: string, real_s: number, user_s: number, sys_s: number, valid: boolean }} Run */
/** @type {{ environments: { id: string, kind: string }[], runs: Run[], summary?: unknown[] }} */
const doc = JSON.parse(readFileSync(file, "utf8"));

const round = (/** @type {number} */ n, /** @type {number} */ places) => Number(n.toFixed(places));
const mean = (/** @type {number[]} */ xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const keyOf = (/** @type {Run} */ r) => `${r.env}\u0000${r.setting ?? ""}`;

const envIds = new Set(doc.environments.map((e) => e.id));
for (const r of doc.runs) {
  if (!envIds.has(r.env)) throw new Error(`run refers to unknown environment ${r.env}`);
}

/** @type {Map<string, Run[]>} */
const groups = new Map();
for (const r of doc.runs.filter((r) => r.valid)) {
  groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
}

const metalIds = new Set(doc.environments.filter((e) => e.kind === "metal").map((e) => e.id));
/** @type {Map<string, number>} metal mean real_s per setting */
const metalReal = new Map();
for (const runs of groups.values()) {
  if (metalIds.has(runs[0].env)) metalReal.set(runs[0].setting ?? "", mean(runs.map((r) => r.real_s)));
}

const summary = [...groups.values()].map((runs) => {
  const real = runs.map((r) => r.real_s);
  const user = mean(runs.map((r) => r.user_s));
  const sys = mean(runs.map((r) => r.sys_s));
  const base = metalReal.get(runs[0].setting ?? "");
  return {
    env: runs[0].env,
    ...(runs[0].setting === undefined ? {} : { setting: runs[0].setting }),
    runs: runs.length,
    real_s: round(mean(real), 2),
    real_range_s: [Math.min(...real), Math.max(...real)],
    user_s: round(user, 2),
    sys_s: round(sys, 2),
    kernel_share: round(sys / (user + sys), 3),
    ...(base === undefined ? {} : { vs_metal: round(base / mean(real), 2) }),
  };
});

console.table(summary.map(({ real_range_s, ...row }) => ({ ...row, range: real_range_s.join("–") })));

if (flag === "--write") {
  writeFileSync(file, `${JSON.stringify({ ...doc, summary }, null, 2)}\n`);
  console.log(`wrote summary to ${file}`);
} else if (JSON.stringify(doc.summary) !== JSON.stringify(summary)) {
  console.error(`${file}: summary is out of date; run with --write`);
  process.exit(1);
}
