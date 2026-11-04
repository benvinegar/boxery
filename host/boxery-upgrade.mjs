#!/usr/bin/env node
// `boxery-host version` and `boxery-host upgrade`. Upgrade updates this install (a git checkout or a
// global npm install of boxery-vm), then re-runs `init` for every profile whose services run it, while
// holding each profile's host-wide operation lock. A failed init or health check rolls the code back,
// and each profile's lease store and state files with it (from the copy taken before applying).
// This file is loaded into memory before the code on disk changes; it imports the operations module
// (node:sqlite) only when it needs the lock, so `version` works on any Node.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ version: string, describe: string | null, commit: string | null, branch: string | null, install: "git" | "npm" | "unknown", root: string }} VersionInfo */
/** A boxery service file's command. @typedef {{ kind: "proxy" | "reaper", root: string, conf: string | null, node: string | null, path: string | null }} Service */
/** One profile's services of this install. @typedef {{ proxy?: Service, reaper?: Service }} ProfileServices */
/** A service of another install. @typedef {{ file: string, root: string, conf: string }} OtherService */
/** @typedef {{ check: boolean, reinit: boolean, ref: string | null, wait: number }} UpgradeOptions */
/** @typedef {{ from: string, to: string, upToDate: boolean, fromLabel: string, toLabel: string, mode?: "ff" | "detach", branch?: string | null, dirty?: boolean }} Plan */
/** @import { Hold } from "./boxery-operations.mjs" */
/** Where the new code comes from (git or npm). @typedef {{ plan(): Plan, apply(p: Plan): void, rollback(p: Plan): void }} Source */

const SELF = fileURLToPath(import.meta.url);
export const ROOT = path.resolve(path.dirname(SELF), "..");
const HOST = path.join(ROOT, "host/boxery-host");
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const log = (/** @type {string} */ m) => process.stderr.write(`==> ${m}\n`);
/** @type {(message: string, exitCode?: number) => never} */
const fail = (message, exitCode = 1) => { throw Object.assign(new Error(message), { exitCode }); };
const defaultConf = () => path.join(homedir(), ".config/boxery");

/** @param {string} cmd @param {string[]} args @param {{ cwd?: string, env?: NodeJS.ProcessEnv, quiet?: boolean, allowFail?: boolean }} [opts] @returns {string | null} */
function sh(cmd, args, { cwd = ROOT, env = process.env, quiet = true, allowFail = false } = {}) {
	// quiet: capture stdout (returned) and stderr (in the error). Otherwise both stream to our stderr.
	const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", 2, 2] });
	if (r.error || r.status !== 0) {
		if (allowFail) return null;
		const why = r.error ? r.error.message : (quiet && r.stderr?.trim()) || `exit ${r.status}`;
		fail(`${path.basename(cmd)} ${args.join(" ")}: ${why}`);
	}
	return quiet ? r.stdout.trim() : "";
}

// ---------------------------------------------------------------- version

const isNpmInstall = (/** @type {string} */ root, /** @type {{ name?: string }} */ pkg) => pkg.name === "boxery-vm" && path.basename(path.dirname(root)) === "node_modules";
/** @returns {VersionInfo} */
export function versionInfo(root = ROOT) {
	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	const git = existsSync(path.join(root, ".git"));
	/** @type {VersionInfo} */
	const info = { version: pkg.version, describe: null, commit: null, branch: null, install: git ? "git" : isNpmInstall(root, pkg) ? "npm" : "unknown", root };
	if (git) {
		const g = (/** @type {string[]} */ ...a) => sh("git", a, { cwd: root, allowFail: true }) || null;
		info.describe = g("describe", "--tags", "--always", "--dirty");
		info.commit = g("rev-parse", "HEAD");
		info.branch = g("symbolic-ref", "--short", "-q", "HEAD");
	}
	return info;
}
const label = (/** @type {VersionInfo} */ v) => (v.describe && v.describe !== v.version ? `${v.version} (${v.describe})` : v.version);

// ---------------------------------------------------------------- profiles (from the service files)

/**
 * Parse a boxery service file: systemd user unit (Linux) or launchd plist (macOS).
 * → {kind: "proxy"|"reaper", root, conf, node, path} or null for anything else (e.g. the vsock bridge).
 * @param {string} text @returns {Service | null}
 */
export function parseService(text) {
	let argv, /** @type {Record<string, string>} */ env = {};
	if (text.includes("<plist")) {
		const args = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
		argv = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
		const dict = text.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? "";
		for (const m of dict.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) env[m[1]] = m[2];
	} else {
		argv = (text.match(/^ExecStart=(.*)$/m)?.[1] ?? "").trim().split(/\s+/);
		for (const line of text.matchAll(/^Environment=(.*)$/gm)) {
			for (const kv of line[1].trim().split(/\s+/)) { const i = kv.indexOf("="); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1); }
		}
	}
	const conf = env.BOXERY_CONF ?? null;
	const proxy = argv.findIndex((a) => a.endsWith("/proxy/boxery-proxy.mjs"));
	if (proxy > 0) return { kind: "proxy", root: argv[proxy].slice(0, -"/proxy/boxery-proxy.mjs".length), conf, node: argv[0], path: env.PATH ?? null };
	if (argv[0]?.endsWith("/host/boxery-host") && argv[1] === "reap") return { kind: "reaper", root: argv[0].slice(0, -"/host/boxery-host".length), conf, node: null, path: env.PATH ?? null };
	return null;
}

function serviceFiles() {
	const darwin = process.platform === "darwin";
	const dir = darwin ? path.join(homedir(), "Library/LaunchAgents") : path.join(homedir(), ".config/systemd/user");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => (darwin ? /^dev\..*\.plist$/.test(f) : f.endsWith(".service"))).map((f) => path.join(dir, f));
}

/** Services of this install, grouped by profile (BOXERY_CONF); and services of other installs (reported, not touched).
 * @returns {{ profiles: Map<string, ProfileServices>, others: OtherService[] }} */
export function discover(root = ROOT, files = serviceFiles()) {
	const real = (/** @type {string} */ p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
	const mine = real(root), profiles = /** @type {Map<string, ProfileServices>} */ (new Map()), others = /** @type {OtherService[]} */ ([]);
	for (const file of files) {
		const s = parseService(readFileSync(file, "utf8"));
		if (!s) continue;
		const conf = path.resolve(s.conf ?? defaultConf());
		if (real(s.root) !== mine) { others.push({ file, root: s.root, conf }); continue; }
		if (!profiles.has(conf)) profiles.set(conf, {});
		/** @type {ProfileServices} */ (profiles.get(conf))[s.kind] = s;
	}
	// A default profile set up without services (BOXERY_NO_SERVICES) has nothing to discover; it is
	// this install's only if no other install's services use it.
	if (!profiles.size && existsSync(path.join(defaultConf(), "host.env")) && !others.some((o) => o.conf === defaultConf())) profiles.set(defaultConf(), {});
	return { profiles, others };
}

const readHostEnv = (/** @type {string} */ conf) => {
	/** @type {Record<string, string>} */
	const env = {};
	try { for (const line of readFileSync(path.join(conf, "host.env"), "utf8").split("\n")) { const i = line.indexOf("="); if (i > 0) env[line.slice(0, i)] = line.slice(i + 1); } }
	catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; }
	return env;
};

// The node the profile's services run now (resolved through wrappers), so an upgrade keeps it.
/** @param {string} conf @param {ProfileServices} services */
function serviceNode(conf, services) {
	const recorded = readHostEnv(conf).BOXERY_NODE;
	if (recorded && existsSync(recorded)) return recorded;
	if (services.proxy?.node) {
		const real = sh(services.proxy.node, ["-p", "process.execPath"], { allowFail: true });
		if (real) return real;
	}
	return process.execPath;
}

// The settings init persists in host.env come from that file, never from whoever runs the upgrade.
const PERSISTED = /^(BOXERY_(CONF|NODE|BACKEND|PROXY_PORT|PROXY_UNIT|REAPER_UNIT|POOL|POOL_DIR|BASE_VOL|DOMAIN_PREFIX|NET|LIMA_[A-Z_]+|CH_[A-Z_]+|EXE_[A-Z_]+|NO_SERVICES)|LIBVIRT_DEFAULT_URI|LIMA_HOME)$/;
/** @param {string} conf @param {ProfileServices} services @param {string} node */
function initEnv(conf, services, node) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !PERSISTED.test(k)));
	// init derives the services' PATH from this one. Keep what the services had: an upgrade over a
	// non-interactive ssh session may not see e.g. ~/.local/bin, where the backend's tools can live.
	// The current PATH keeps precedence; the services' directories are only appended.
	const dirs = [path.dirname(node), ...(process.env.PATH ?? "").split(":"), ...(services.reaper?.path ?? "").split(":")];
	env.PATH = [...new Set(dirs.filter((d) => d.startsWith("/")))].join(":");
	// init links ~/.local/bin/boxery{,-host} only for the default profile, i.e. when BOXERY_CONF is unset.
	if (conf !== defaultConf()) env.BOXERY_CONF = conf;
	env.BOXERY_NODE = node; // host/boxery-host runs init (and so records) this node
	if (!services.reaper && services.proxy) env.BOXERY_NO_SERVICES = "1"; // installed without a reaper
	return env;
}

// ---------------------------------------------------------------- sources

/** @param {UpgradeOptions} opts @returns {Source} */
function gitSource({ ref }) {
	const git = (/** @type {string[]} */ ...a) => /** @type {string} */ (sh("git", a));
	const tryGit = (/** @type {string[]} */ ...a) => sh("git", a, { allowFail: true });
	const rev = (/** @type {string} */ r) => tryGit("rev-parse", "--verify", "--quiet", `${r}^{commit}`);
	const describe = (/** @type {string} */ r) => tryGit("describe", "--tags", "--always", r) || r.slice(0, 12);
	const ancestor = (/** @type {string} */ a, /** @type {string} */ b) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: ROOT }).status === 0;
	return {
		plan() {
			const dirty = Boolean(git("status", "--porcelain", "--untracked-files=no"));
			const from = git("rev-parse", "HEAD");
			const branch = tryGit("symbolic-ref", "--short", "-q", "HEAD") || null;
			const remote = (branch && tryGit("config", `branch.${branch}.remote`)) || "origin";
			log(`fetching ${remote}`);
			git("fetch", "--quiet", "--tags", remote);
			let /** @type {string} */ to, /** @type {"ff" | "detach"} */ mode, /** @type {string} */ what;
			if (ref) {
				if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) fail(`invalid --ref ${ref}`);
				to = rev(`refs/tags/${ref}`) || rev(`${remote}/${ref}`) || rev(ref) || fail(`unknown ref ${ref} (after fetching ${remote})`);
				mode = "detach"; what = ref;
			} else if (branch) {
				const upstream = tryGit("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") || fail(`branch ${branch} has no upstream; pass --ref`);
				to = git("rev-parse", "@{u}"); mode = "ff"; what = upstream;
				if (!ancestor(from, to)) fail(`${branch} has commits that aren't on ${upstream}; update it by hand or pass --ref`);
			} else {
				// A detached checkout follows releases: the newest v* tag.
				const tag = git("tag", "--list", "v*", "--sort=-v:refname").split("\n")[0] || fail("no release tags (v*) to upgrade to; pass --ref");
				to = /** @type {string} */ (rev(`refs/tags/${tag}`)); mode = "detach"; what = tag;
				if (!ancestor(from, to)) { log(`HEAD is not behind the newest release (${tag}); pass --ref to move it`); to = from; }
			}
			return { from, to, mode, branch, dirty, upToDate: from === to, fromLabel: describe(from), toLabel: `${describe(to)}${what ? ` (${what})` : ""}` };
		},
		apply(p) { if (p.mode === "ff") git("merge", "--quiet", "--ff-only", p.to); else git("checkout", "--quiet", "--detach", p.to); },
		rollback(p) {
			if (p.mode === "ff") git("reset", "--quiet", "--keep", p.from);
			else if (p.branch) git("checkout", "--quiet", p.branch); // --ref detached HEAD; the branch itself never moved
			else git("checkout", "--quiet", "--detach", p.from);
		},
	};
}

const semver = (/** @type {unknown} */ v) => (String(v).match(/^(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
/** @param {unknown} a @param {unknown} b */
export function newer(a, b) { // a > b?
	const x = semver(a), y = semver(b);
	for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
	return false;
}

/** @param {UpgradeOptions} opts @param {VersionInfo} current @returns {Source} */
function npmSource({ ref }, current) {
	// The npm next to the node running this owns its global root; check it is the one with this install.
	const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` };
	const npm = (/** @type {string[]} */ args, quiet = true) => /** @type {string} */ (sh("npm", args, { env, cwd: homedir(), quiet }));
	const install = (/** @type {string} */ version) => { log(`npm install -g boxery-vm@${version}`); npm(["install", "-g", "--no-fund", "--no-audit", `boxery-vm@${version}`], false); };
	return {
		plan() {
			const root = npm(["root", "-g"]);
			if (realpathSync(root) !== realpathSync(path.dirname(ROOT))) fail(`${ROOT} is not in the global npm root of ${process.execPath} (${root}); run the upgrade with the node that installed it`);
			if (ref && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref)) fail(`invalid --ref ${ref}`);
			let to = /** @type {string} */ (npm(["view", `boxery-vm@${ref ?? "latest"}`, "version"]).split("\n").pop()).replace(/^.*'(.*)'$/, "$1").trim();
			if (!to) fail(`npm has no boxery-vm@${ref ?? "latest"}`);
			if (!ref && !newer(to, current.version)) to = current.version; // never downgrade unless asked to
			return { from: current.version, to, upToDate: to === current.version, fromLabel: current.version, toLabel: to };
		},
		apply: (p) => install(p.to),
		rollback: (p) => install(p.from),
	};
}

// ---------------------------------------------------------------- the pre-upgrade copy

// Each profile's state as it was before the code changed, taken under the host-wide lock, so no
// operation is running. A rollback restores it before init runs the old code again, since the new code
// may have migrated it. After a successful upgrade it stays (until the next one) for recovery by hand.
// Besides init, only locked operations write these files, so restoring them loses nothing. Each VM's
// records are rows in leases.db now; the release before that also copied vm-shapes/, vm-kind/, vm-os/,
// and since the copy is taken and restored by the release being upgraded from, that one still does.
export const PRE_UPGRADE = "pre-upgrade";
const STATE_FILES = ["tokens.json", "edge"];
const copy = (/** @type {string} */ from, /** @type {string} */ to) => cpSync(from, to, { recursive: true, preserveTimestamps: true });

/** @param {string} conf @param {Hold} hold */
function saveState(conf, hold) {
	const dir = path.join(conf, PRE_UPGRADE), tmp = `${dir}.tmp`;
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { mode: 0o700 });
	hold.snapshot(path.join(tmp, "leases.db"));
	for (const f of STATE_FILES) if (existsSync(path.join(conf, f))) copy(path.join(conf, f), path.join(tmp, f));
	rmSync(dir, { recursive: true, force: true });
	renameSync(tmp, dir);
	log(`${conf}: saved the lease store and state files in ${dir}`);
}

/** @param {string} conf @param {Hold} hold */
function restoreState(conf, hold) {
	const dir = path.join(conf, PRE_UPGRADE);
	hold.restore(path.join(dir, "leases.db")); // in place, through SQLite: see boxery-leases.mjs restore()
	for (const f of STATE_FILES) {
		const live = path.join(conf, f), saved = path.join(dir, f), tmp = `${live}.pre-upgrade.tmp`;
		rmSync(tmp, { recursive: true, force: true });
		if (!existsSync(saved)) { rmSync(live, { recursive: true, force: true }); continue; }
		copy(saved, tmp);
		if (statSync(saved).isDirectory()) rmSync(live, { recursive: true, force: true });
		renameSync(tmp, live); // a file is replaced atomically
	}
	log(`${conf}: restored the lease store and state files from ${dir}`);
}

// ---------------------------------------------------------------- init + verification

/** @param {string} conf @param {ProfileServices} services @param {string} node */
function init(conf, services, node) {
	log(`init ${conf}`);
	sh(HOST, ["init"], { env: initEnv(conf, services, node), quiet: false });
}

// After init: the profile's services must work as the services run them, not as this shell would.
/** @param {string} conf @param {string} node */
async function verify(conf, node) {
	const services = discover().profiles.get(conf) ?? {};
	/** @type {NodeJS.ProcessEnv} */
	const env = { ...initEnv(conf, services, node), BOXERY_CONF: conf };
	if (services.reaper?.path) env.PATH = services.reaper.path; // the reaper's PATH must find the backend's tools
	const out = sh(HOST, ["ls", "--json"], { env, allowFail: true });
	let vms = null;
	try { vms = JSON.parse(out ?? ""); } catch {}
	if (!Array.isArray(vms)) fail(`boxery-host ls (as the reaper runs it) failed for ${conf}`);
	// ls carries on without the lease store; the new code must be able to open (and so migrate) it.
	try { if (!Array.isArray(JSON.parse(/** @type {string} */ (sh(HOST, ["pool", "ls", "--json"], { env }))))) throw new Error("not a list"); }
	catch (e) { fail(`the lease store of ${conf} can't be read: ${/** @type {Error} */ (e).message}`); }
	if (!services.proxy) return;
	const port = readHostEnv(conf).BOXERY_PROXY_PORT ?? "8088";
	for (let i = 0; i < 40; i++) {
		try { if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) })).ok) { log(`${conf}: ${vms.length} VMs, proxy healthy on :${port}`); return; } }
		catch {}
		await sleep(250);
	}
	fail(`the LLM proxy for ${conf} isn't answering on 127.0.0.1:${port}`);
}

// ---------------------------------------------------------------- commands

const USAGE = "usage: boxery-host upgrade [--check] [--ref REF] [--wait SECONDS] [--reinit]";
/** @param {string[]} argv */
export function parseArgs(argv) {
	/** @type {UpgradeOptions} */
	const o = { check: false, reinit: false, ref: null, wait: 600 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--check") o.check = true;
		else if (a === "--reinit") o.reinit = true;
		else if (a === "--ref" || a === "--wait") {
			const v = argv[++i];
			if (v == null) fail(`${a} needs a value\n${USAGE}`);
			if (a === "--ref") o.ref = v;
			else if (/^\d+$/.test(v)) o.wait = Number(v);
			else fail("--wait must be a number of seconds");
		} else fail(`unknown argument ${a}\n${USAGE}`);
	}
	return o;
}

/** @param {string[]} argv */
async function upgrade(argv) {
	const opts = parseArgs(argv);
	const current = versionInfo();
	if (current.install === "unknown") fail(`${ROOT} is neither a git checkout nor a global npm install of boxery-vm; update it by hand, then re-run boxery-host init`);
	const { profiles, others } = discover();
	for (const o of others) log(`not touching ${o.file}: it runs another install (${o.root})`);
	if (!profiles.size) fail(`no services run ${ROOT}; nothing to upgrade (set it up with boxery-host init)`);
	const source = current.install === "git" ? gitSource(opts) : npmSource(opts, current);
	const plan = source.plan();
	const confs = [...profiles.keys()].sort();
	log(`${current.install} install at ${ROOT}`);
	log(plan.upToDate ? `up to date at ${plan.fromLabel}` : `${plan.fromLabel} → ${plan.toLabel}`);
	log(`profiles: ${confs.join(", ")}`);
	if (plan.dirty) log(`${ROOT} has uncommitted changes`);
	if (opts.check) return;
	if (plan.upToDate && !opts.reinit) return;
	if (plan.dirty && !plan.upToDate) fail(`${ROOT} has uncommitted changes; commit or stash them, then retry`);

	const { holdExclusive } = await import("./boxery-operations.mjs");
	const deadline = Date.now() + opts.wait * 1000, held = /** @type {Hold[]} */ ([]);
	// Recorded before init rewrites the service files: each profile keeps the node its services use.
	const nodes = new Map(confs.map((c) => [c, serviceNode(c, /** @type {ProfileServices} */ (profiles.get(c)))]));
	try {
		for (const conf of confs) {
			log(`waiting for in-flight operations in ${conf} (new ones wait for the upgrade)`);
			const h = await holdExclusive(conf, deadline);
			if (!h) fail(`timed out after ${opts.wait}s waiting for in-flight operations in ${conf}; nothing was changed (retry, or raise --wait)`, 75);
			held.push(h);
		}
		let applied = false;
		try {
			if (!plan.upToDate) {
				confs.forEach((conf, i) => saveState(conf, held[i]));
				source.apply(plan); applied = true;
			}
			for (const conf of confs) init(conf, /** @type {ProfileServices} */ (profiles.get(conf)), /** @type {string} */ (nodes.get(conf)));
			for (const conf of confs) await verify(conf, /** @type {string} */ (nodes.get(conf)));
		} catch (e) {
			if (!applied) throw e;
			log(`upgrade failed: ${/** @type {Error} */ (e).message}`);
			log(`rolling back to ${plan.fromLabel}`);
			try {
				source.rollback(plan);
				confs.forEach((conf, i) => restoreState(conf, held[i])); // after the code: nothing new migrates it again
				for (const conf of confs) init(conf, /** @type {ProfileServices} */ (profiles.get(conf)), /** @type {string} */ (nodes.get(conf)));
			} catch (r) {
				fail(`ROLLBACK FAILED (${/** @type {Error} */ (r).message}). ${ROOT} needs repair by hand: restore ${plan.fromLabel} and each profile's ${PRE_UPGRADE}/ copy (see Upgrading in docs/install.md), then run boxery-host init for ${confs.join(", ")}`);
			}
			fail(`upgrade to ${plan.toLabel} failed and was rolled back to ${plan.fromLabel}: ${/** @type {Error} */ (e).message}`);
		}
		if (applied) for (const conf of confs) log(`${conf}: kept the state from before the upgrade in ${path.join(conf, PRE_UPGRADE)}`);
	} finally {
		for (const h of held.reverse()) h.release();
	}
	log(`${ROOT} is at ${label(versionInfo())}`);
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (command === "version") {
		if (args.length > 1 || (args[0] && args[0] !== "--json")) fail("usage: boxery-host version [--json]");
		const v = versionInfo();
		process.stdout.write(args[0] ? `${JSON.stringify(v)}\n` : `${label(v)}  ${v.install}  ${v.root}\n`);
	} else if (command === "upgrade") await upgrade(args);
	else fail(`unknown command ${command}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
	main().catch((e) => { console.error(`boxery-host: ${e.message}`); process.exitCode = e.exitCode ?? 1; });
}
