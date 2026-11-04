// Checking traces, the run's metadata, and what a result writes: shared by run.mjs (new runs) and
// rescore.mjs (stored transcripts checked again with the current cases).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { SUITE_VERSION, cases } from "../cases.mjs";
import { RESULTS, writeIndex } from "./results.mjs";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EVALS = path.join(ROOT, "evals");
export const TOKEN = "npm_FAKEtok3nForEvalOnly000000000000";
const PKG = JSON.stringify({ name: "toy", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n";
const PKG_LINES = PKG.split("\n").length - 1;

/** A throwaway project for the session to work in: package.json, a source file, one commit. */
export function workDir() {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-eval-"));
	writeFileSync(path.join(dir, "package.json"), PKG);
	writeFileSync(path.join(dir, "index.test.js"), 'import test from "node:test";\nimport assert from "node:assert";\ntest("adds", () => assert.equal(1 + 1, 2));\n');
	const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("add", ".");
	git("-c", "user.name=eval", "-c", "user.email=eval@example.com", "commit", "-qm", "initial toy project");
	return dir;
}

/**
 * What a case's prompt and checks see. defaultHost is the session's host (the server's default, as
 * `boxery version --json` names it). workDir is null when rescoring (the run's work dir is gone).
 * @param {any} c @param {{ vm: string, otherVm: string }} opts @param {string} defaultHost @param {string | null} [workDir]
 */
export const ctxFor = (c, opts, defaultHost, workDir = null) => ({ vm: opts.vm, otherVm: opts.otherVm, defaultVm: c.cfg === "vm" ? opts.vm : undefined, defaultHost, workDir, pkgLines: PKG_LINES, token: TOKEN });
/** The session host a run used, from its metadata. */
export const hostOf = (meta) => meta.boxery.host?.host?.name ?? "local";

/**
 * Run a case's checks over a trace. A check that can't run again (it reads the work dir, gone when
 * rescoring) keeps its earlier result from `before`, if the check existed then.
 */
export function check(c, t, ctx, before = []) {
	const results = c.checks.map((k) => {
		try {
			return { level: k.level, name: k.name, ok: !!k.test(t, ctx) };
		} catch (e) {
			const old = !ctx.workDir && before.find((x) => x.name === k.name && x.level === k.level);
			return old ? { ...old } : { level: k.level, name: k.name, ok: false, error: String(e.message ?? e) };
		}
	});
	return { results, pass: !t.error && results.every((r) => r.level !== "must" || r.ok) };
}

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
const dirty = (...paths) => git("status", "--porcelain", "--", ...paths).length > 0;

/** This suite: its version, a hash of the files that define it, and whether they have uncommitted changes. */
export function suiteInfo() {
	const files = ["cases.mjs", "run.mjs", "rescore.mjs", ...readdirSync(path.join(EVALS, "lib")).sort().map((f) => `lib/${f}`)];
	return {
		version: SUITE_VERSION,
		hash: createHash("sha256").update(files.map((f) => readFileSync(path.join(EVALS, f), "utf8")).join("\0")).digest("hex").slice(0, 12),
		dirty: dirty("evals", ":!evals/results", ":!evals/out"),
	};
}

/** The code under test: this checkout, minus evals/. */
export const boxeryInfo = () => ({ commit: git("rev-parse", "HEAD"), describe: git("describe", "--tags", "--always"), dirty: dirty(".", ":!evals") });

/** Tool arguments that say how boxery was used and are safe to publish; commands, file contents and answers stay in out/. */
const PUBLIC_ARGS = ["action", "vm", "host", "headless", "use", "shape", "snapshot", "spec", "readonly", "timeout"];
/** Arguments published for one tool only: vm_manage's `to` is fork names (vm_copy's is a path). */
const PUBLIC_ARGS_FOR = { vm_manage: ["to"] };
const TMP = [tmpdir(), "/private/var/folders", "/var/folders", "/private/tmp", "/tmp"].map((p) => path.resolve(p));
/** Temp paths → <tmp>, anything under home → ~/…, the eval's token → <token>; recursively. */
export const scrub = (v) =>
	typeof v === "string"
		? TMP.reduce((s, p) => s.split(p).join("<tmp>"), v.split(TOKEN).join("<token>")).replace(/<tmp>[^\s"'=]*/g, "<tmp>").split(homedir()).join("~").replace(/~\/[^\s"'=]*/g, "~/…")
		: Array.isArray(v) ? v.map(scrub)
		: v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
		: v;
const versionOf = (x) => (x && typeof x === "object" ? x.version ?? null : x ?? null);
/** What results/ keeps of the run's metadata: the host's versions but not its name, and a scrubbed command. */
export const publicMeta = (meta) => ({
	...meta,
	command: scrub(meta.command),
	boxery: { ...meta.boxery, host: meta.boxery.host && { controller: versionOf(meta.boxery.host.controller), host: versionOf(meta.boxery.host.host) } },
});

/**
 * A tool call as results/ keeps it: name, denied, and PUBLIC_ARGS scrubbed. A `host` other than the
 * session's (or `local`) becomes <other host>: users' host names aren't published.
 * @param {{ tool: string, denied?: boolean, input?: any, args?: any }} x @param {string} sessionHost
 */
export function publicCall(x, sessionHost) {
	const input = x.input ?? x.args ?? {};
	const args = Object.fromEntries([...PUBLIC_ARGS, ...(PUBLIC_ARGS_FOR[x.tool] ?? [])].filter((k) => input[k] !== undefined).map((k) => [k, scrub(input[k])]));
	if (typeof args.host === "string" && ![sessionHost, "local"].includes(args.host)) args.host = "<other host>";
	return { tool: x.tool, denied: x.denied || undefined, args };
}

/** Per-run results with tool calls reduced by publicCall: what results/ keeps. @param {string} sessionHost */
export function scorecard(runs, sessionHost) {
	return cases.filter((c) => runs.some((r) => r.id === c.id)).map((c) => ({
		id: c.id,
		category: c.category,
		expect: c.expect,
		runs: runs.filter((r) => r.id === c.id).map((r) => ({
			rep: r.rep,
			pass: r.pass,
			error: r.error ? scrub(r.error).slice(0, 120) : undefined,
			checks: r.results.map(({ level, name, ok }) => ({ level, name, ok })),
			calls: r.calls.map((x) => publicCall(x, sessionHost)),
			turns: r.turns,
			cost: +r.cost.toFixed(4),
			ms: r.ms,
		})),
	}));
}

/** Markdown: the metadata, a table per case, then each run's tool calls (plus commands and answers when `full` runs are given). @param {any[] | null} [full] */
export function summary(card, meta, full = null) {
	const runs = card.flatMap((c) => c.runs);
	const show = (x) => `${x.tool}${x.denied ? "✗" : ""}${Object.keys(x.args).length ? ` ${JSON.stringify(x.args)}` : ""}`;
	const shoulds = runs.flatMap((r) => r.checks.filter((x) => x.level === "should"));
	const lines = [
		`# boxery MCP evals`,
		``,
		`| | |`,
		`|---|---|`,
		`| model | ${meta.claude.model} (Claude Code ${meta.claude.cli}) |`,
		`| boxery | \`${meta.boxery.commit.slice(0, 12)}\` (${meta.boxery.describe})${meta.boxery.dirty ? ", uncommitted changes" : ""}; host ${meta.boxery.host?.host?.version ?? meta.boxery.host?.host ?? "?"} |`,
		`| suite | v${meta.suite.version}, \`${meta.suite.hash}\`${meta.suite.dirty ? ", uncommitted changes" : ""}${meta.rescored ? `; rescored ${meta.rescored.at.slice(0, 10)} from a v${meta.rescored.from.version} run` : ""} |`,
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
	const byRun = full ? new Map(full.map((r) => [`${r.id}#${r.rep}`, r])) : null;
	for (const c of card) {
		lines.push(`### ${c.id}`, "", `Expect: ${c.expect}`, "");
		for (const r of c.runs) {
			lines.push(`- **#${r.rep} ${r.pass ? "pass" : "FAIL"}**${r.error ? ` (${r.error})` : ""}`);
			const raw = byRun?.get(`${c.id}#${r.rep}`);
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

/** Write a run (or a rescore) to its out/ directory: everything, including full traces. */
export function writeOut(dir, meta, runs) {
	const card = scorecard(runs, hostOf(meta));
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
	writeFileSync(path.join(dir, "results.json"), JSON.stringify({ runs }, null, 2));
	writeFileSync(path.join(dir, "scorecard.json"), JSON.stringify(card, null, 2) + "\n");
	writeFileSync(path.join(dir, "summary.md"), summary(card, meta, runs));
	return card;
}

/** Keep a result in results/ (publishable files only) and rebuild the index. @returns {string} its directory */
export function saveResult(meta, card) {
	const base = path.join(RESULTS, `${meta.started.slice(0, 10)}-${meta.boxery.commit.slice(0, 7)}-${meta.claude.model.replace(/[^a-z0-9.-]+/gi, "_")}${meta.rescored ? `-rescored-v${meta.suite.version}` : ""}`);
	let dir = base;
	for (let i = 2; existsSync(dir); i++) dir = `${base}-${i}`;
	mkdirSync(dir, { recursive: true });
	const pub = publicMeta(meta);
	writeFileSync(path.join(dir, "meta.json"), JSON.stringify(pub, null, 2) + "\n");
	writeFileSync(path.join(dir, "scorecard.json"), JSON.stringify(card, null, 2) + "\n");
	writeFileSync(path.join(dir, "summary.md"), summary(card, pub));
	writeIndex();
	return dir;
}
