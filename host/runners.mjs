// GitHub Actions self-hosted runners on pool VMs: every job runs in a freshly reset VM (docs/github-runners.md).
//
// A runner manager (`boxery-host runners run`, the systemd user service / launchd agent RUNNERS_UNIT that
// `runners start` turns on) keeps `count` runners waiting. Each slot loops:
//
//   lease a FREE runner VM (holder github-runner, `acquire --only` the configured VMs; renewed at a third of
//   the TTL for as long as the slot holds it) → generate a just-in-time (JIT) runner config with GitHub's REST
//   API → start the runner in the VM with it (boxery-runner, image/layers/github-runner.sh) → poll until the
//   runner process exits → delete its registration (gone already after a job) → release the lease, which
//   resets the VM to NAME@boxery-clean.
//
// A JIT runner takes exactly one job and deregisters itself, so a job never sees another job's VM. The
// GitHub token stays on the host, in $CONF/runners.env (0600, like proxy.env): only the single-use JIT
// config enters the guest, over ssh stdin (never argv or a log line), and the reset removes what the runner
// wrote to disk. The manager is an ordinary lease holder: it uses `boxery-host acquire/renew/release` (the
// pool's locks, fencing and resets) and takes no locks of its own beyond one manager per profile.
//
// Failure handling: no free VM → back off (5 s doubling to 60 s); GitHub API errors → keep the clean VM,
// back off (10 s doubling to 5 min, or as long as the rate limit says) and log the status, never the request;
// a runner that never gets a job → it waits, the lease is renewed; a job longer than the TTL → renewal keeps
// it; an unreachable VM → after a few polls the lease is released, and a reset that fails leaves it BROKEN
// for the admin (the pool's own rule). On start the manager finds its leases by holder: a VM whose runner
// still runs is adopted (its job goes on), any other is released. It then deletes offline registrations
// with its name prefix that no adopted runner owns (runners whose VM is gone). `runners stop` makes it give
// back idle runners and leave busy ones running for the next manager to adopt (their lease expires
// otherwise); any other SIGTERM is a restart (an upgrade's init) and leaves every lease as it is.
//
// Local runners (`boxery runners once` on the controller, `runners __once` here) are the same slot run
// once: one VM, one runner, one job. The controller registers the runner with its user's own gh login and
// sends only the JIT config, on stdin, so this side never sees a GitHub credential. Their leases have their
// own holder (LOCAL_HOLDER) and their runners their own name prefix (LOCAL_PREFIX), so a manager never
// adopts, releases or deregisters them.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import * as leases from "./boxery-leases.mjs";
import { reloadAgent, RUNNERS_TOKEN_TEMPLATE, serviceFiles } from "./setup.mjs";
import { fail, log, print, readFd, table, VALID_NAME } from "./util.mjs";
/** @import { Runtime } from "./runtime.mjs" */

export const HOLDER = "github-runner";
// Local runners (localRunner): never adopted (heldBy matches the holder exactly), never cleaned up by a manager.
export const LOCAL_HOLDER = "github-runner-local", LOCAL_PREFIX = "boxery-local";
const isLocalName = (/** @type {string} */ name) => name === LOCAL_PREFIX || name.startsWith(`${LOCAL_PREFIX}-`);
// GitHub's REST API version these calls were written against (docs.github.com/rest, "API versions").
export const API_VERSION = "2026-03-10";
export const CONFIG_FILE = "runners.json", TOKEN_FILE = "runners.env", STATE_FILE = "runners-state.json", LOCK_FILE = "runners.lock";
// Left by `runners stop` while it stops the service: this SIGTERM means "give back idle runners".
export const STOP_FILE = "runners.stopping";
// In the guest (image/layers/github-runner.sh).
const HELPER = "/usr/local/sbin/boxery-runner";

/** `runners.json`. One of repo ("OWNER/REPO") or org. vms: the pool VMs that carry the runner layer (the
 *  manager leases only these). count: runners kept waiting (≤ vms). prefix: every runner it registers is
 *  named PREFIX-VM-RANDOM, and only offline runners with this prefix are ever deleted.
 *  @typedef {{ repo?: string, org?: string, vms: string[], count: number, labels: string[], group: number, ttl: number, api: string, prefix: string }} RunnerConfig */
/** A slot's lease of a runner VM. @typedef {{ vm: string, lease: string, expires: number }} RunnerLease */
/** What the manager needs from the pool (production: `boxery-host acquire/renew/release`).
 *  @typedef {{ acquire(only: string[]): Promise<RunnerLease | null>, renew(lease: string): Promise<number>, release(lease: string): Promise<unknown>,
 *    held(): Array<{ name: string, state: string, lease_id: string | null, expires_at: number | null }> }} RunnerPool */
/** The guest side (boxery-runner over ssh). status: running | exited | none (never started) | missing (no
 *  runner layer) | unreachable. @typedef {"running" | "exited" | "none" | "missing" | "unreachable"} GuestStatus */
/** @typedef {{ status(vm: string): Promise<GuestStatus>, start(vm: string, jitConfig: string): Promise<unknown>, stop(vm: string): Promise<unknown> }} RunnerGuest */
/** A runner registration as the API returns it (the fields used). @typedef {{ id: number, name: string, status: string, busy: boolean }} GitHubRunner */
/** @typedef {ReturnType<typeof createGitHub>} GitHub */
/** A slot's state, for `runners status` (runners-state.json). @typedef {{ slot: number, vm: string | null, phase: string, runner: string | null, runner_id: number | null, since: number }} SlotState */

// ---------------------------------------------------------------- configuration and token
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, ORG = /^[A-Za-z0-9-]{1,39}$/;
const LABEL = /^[A-Za-z0-9._-]{1,64}$/, PREFIX = /^[a-z0-9][a-z0-9._-]{0,23}$/;
const API = /^(https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._/-]*)?|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?)$/;
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

/** The default runner name prefix: boxery-HOST(-PROFILE), lowercase, at most 24 characters. @param {string | null} profile */
export function defaultPrefix(profile, host = hostname()) {
	let h = host.split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "host";
	if (isLocalName(`boxery-${h}`)) h = `host-${h}`; // boxery-local-… names are local runners'
	return `boxery-${h}${profile ? `-${profile}` : ""}`.slice(0, 24).replace(/[-.]+$/, "");
}

/** A complete, checked configuration, or an error message. @param {Record<string, any>} c @returns {RunnerConfig | string} */
export function checkConfig(c) {
	if (!c.repo === !c.org) return "set one of --repo OWNER/REPO or --org ORG";
	if (c.repo && !REPO.test(c.repo)) return `invalid repository '${c.repo}' (OWNER/REPO)`;
	if (c.org && !ORG.test(c.org)) return `invalid organization '${c.org}'`;
	if (!Array.isArray(c.vms) || !c.vms.length || !c.vms.every((v) => VALID_NAME.test(v))) return "set the runner VMs: --vms NAME,… (pool VMs made with --layers github-runner)";
	const vms = [...new Set(/** @type {string[]} */ (c.vms))];
	const count = c.count ?? vms.length;
	if (!Number.isInteger(count) || count < 1 || count > vms.length) return `--count must be 1..${vms.length} (one runner per VM at a time)`;
	const labels = c.labels ?? [];
	if (!Array.isArray(labels) || labels.length > 90 || !labels.every((l) => typeof l === "string" && LABEL.test(l))) return "labels are [A-Za-z0-9._-], at most 64 characters each";
	const group = c.group ?? 1;
	if (!Number.isInteger(group) || group < 1) return "--group must be a runner group id (1 = Default)";
	const ttl = c.ttl ?? 1800;
	if (!Number.isInteger(ttl) || ttl < leases.TTL_MIN || ttl > leases.TTL_MAX) return `--ttl must be ${leases.TTL_MIN}..${leases.TTL_MAX} seconds`;
	const api = String(c.api ?? "https://api.github.com").replace(/\/+$/, "");
	if (!API.test(api)) return `invalid --api '${api}' (https://…, or http:// on loopback)`;
	if (typeof c.prefix !== "string" || !PREFIX.test(c.prefix)) return "invalid --prefix ([a-z0-9][a-z0-9._-], at most 24 characters)";
	if (isLocalName(c.prefix)) return `--prefix ${c.prefix} is taken: ${LOCAL_PREFIX}-… names are local runners' (boxery runners once)`;
	return { ...(c.repo ? { repo: c.repo } : { org: c.org }), vms, count, labels, group, ttl, api, prefix: c.prefix };
}

/** The saved configuration (unchecked), or null. @param {string} conf @returns {Record<string, any> | null} */
function readConfig(conf) {
	try { return JSON.parse(readFileSync(path.join(conf, CONFIG_FILE), "utf8")); }
	catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null; throw e; }
}
/** The configuration, checked; fails if there is none or it is invalid. @param {string} conf */
export function loadRunnerConfig(conf) {
	const raw = readConfig(conf);
	if (!raw) return fail("runners are not configured (boxery-host runners config --repo OWNER/REPO --vms NAME,…)");
	const c = checkConfig(raw);
	return typeof c === "string" ? fail(`${path.join(conf, CONFIG_FILE)}: ${c}`) : c;
}

/** @param {string} file @param {string} text */
function writePrivate(file, text) {
	const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
	renameSync(tmp, file);
}

/** The token from runners.env, or null if none is set. Refuses a file others can read.
 *  @param {string} conf @returns {string | null} */
export function readGithubToken(conf) {
	const file = path.join(conf, TOKEN_FILE);
	let text;
	try {
		if (statSync(file).mode & 0o077) throw new Error(`${file} is readable by other users; chmod 600 it`);
		text = readFileSync(file, "utf8");
	} catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null; throw e; }
	const line = text.split("\n").find((l) => l.startsWith("GITHUB_TOKEN="));
	const token = line?.slice("GITHUB_TOKEN=".length).trim();
	return token || null;
}
/** Store TEXT's first line as the token (0600, atomic). @param {string} conf @param {string} text */
export function writeGithubToken(conf, text) {
	const token = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
	if (!TOKEN.test(token)) fail("expected a GitHub token on stdin (one line: ghp_…, github_pat_…)");
	mkdirSync(conf, { recursive: true });
	writePrivate(path.join(conf, TOKEN_FILE), `${RUNNERS_TOKEN_TEMPLATE.replace("#GITHUB_TOKEN=\n", "")}GITHUB_TOKEN=${token}\n`);
}

// ---------------------------------------------------------------- GitHub REST API
export class GitHubError extends Error {
	/** @param {string} message @param {{ status?: number, retryAfter?: number | null }} [opts] */
	constructor(message, { status = 0, retryAfter = null } = {}) {
		super(message);
		this.status = status; this.retryAfter = retryAfter;
	}
}

/** Seconds to wait before retrying, from a response's rate-limit headers (null: nothing said).
 *  @param {Headers} h @param {number} nowSecs */
export function retryAfter(h, nowSecs) {
	const ra = h.get("retry-after");
	if (ra && /^\d+$/.test(ra)) return Number(ra);
	const reset = h.get("x-ratelimit-reset");
	if (h.get("x-ratelimit-remaining") === "0" && reset && /^\d+$/.test(reset)) return Math.max(1, Number(reset) - nowSecs);
	return null;
}

/** The runners endpoint of a repository or organization. token() is read per request (rotation needs no
 * restart); it goes only into the Authorization header, and no error message carries it or a request body.
 * @param {{ api: string, repo?: string, org?: string, token: () => string | null, fetch?: typeof globalThis.fetch, now?: () => number }} opts */
export function createGitHub({ api, repo, org, token, fetch = globalThis.fetch, now = Date.now }) {
	const base = `${api}${repo ? `/repos/${repo}` : `/orgs/${org}`}/actions/runners`;
	/** @param {string} method @param {string} sub @param {unknown} [body] @returns {Promise<any>} */
	async function request(method, sub, body) {
		const what = `${method} ${repo ? `repos/${repo}` : `orgs/${org}`}/actions/runners${sub.replace(/\?.*/, "")}`;
		let t;
		try { t = token(); } catch (e) { throw new GitHubError(/** @type {Error} */ (e).message); }
		if (!t) throw new GitHubError("no GitHub token (boxery-host runners token < FILE)");
		let res;
		try {
			res = await fetch(`${base}${sub}`, {
				method,
				headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${t}`, "X-GitHub-Api-Version": API_VERSION, "User-Agent": "boxery-runners",
					...(body ? { "Content-Type": "application/json" } : {}) },
				...(body ? { body: JSON.stringify(body) } : {}),
				signal: AbortSignal.timeout(30000),
			});
		} catch (e) {
			const err = /** @type {Error & { cause?: { code?: string } }} */ (e);
			throw new GitHubError(`${what}: ${err.name === "TimeoutError" ? "timed out" : `unreachable (${err.cause?.code ?? err.name})`}`);
		}
		if (res.ok) return res.status === 204 ? null : res.json();
		let message = "";
		try { message = String((await res.json())?.message ?? ""); } catch { /* not JSON */ }
		message = message.replace(/[\0-\x1f\x7f]+/g, " ").slice(0, 200);
		throw new GitHubError(`${what}: ${res.status}${message ? ` ${message}` : ""}`, { status: res.status, retryAfter: retryAfter(res.headers, Math.floor(now() / 1000)) });
	}
	return {
		/** A single-use runner registration. @param {{ name: string, labels: string[], group: number, vm?: string }} opts (vm: unused here)
		 *  @returns {Promise<{ id: number, name: string, encoded: string }>} */
		async generateJitConfig({ name, labels, group }) {
			const r = await request("POST", "/generate-jitconfig", { name, runner_group_id: group, labels, work_folder: "_work" });
			if (!Number.isInteger(r?.runner?.id) || typeof r?.encoded_jit_config !== "string" || !r.encoded_jit_config) throw new GitHubError("generate-jitconfig: unexpected response");
			return { id: r.runner.id, name: String(r.runner.name ?? name), encoded: r.encoded_jit_config };
		},
		/** Every registered runner (all pages). @returns {Promise<GitHubRunner[]>} */
		async list() {
			/** @type {GitHubRunner[]} */
			const out = [];
			for (let page = 1; page <= 50; page++) {
				const r = await request("GET", `?per_page=100&page=${page}`);
				const runners = Array.isArray(r?.runners) ? r.runners : [];
				out.push(...runners);
				if (runners.length < 100 || out.length >= Number(r?.total_count ?? 0)) break;
			}
			return out;
		},
		/** @param {number} id @returns {Promise<GitHubRunner | null>} null: no such runner */
		async get(id) {
			try { return await request("GET", `/${id}`); } catch (e) { if (e instanceof GitHubError && e.status === 404) return null; throw e; }
		},
		/** @param {number} id @returns {Promise<boolean>} false: it was gone already */
		async remove(id) {
			try { await request("DELETE", `/${id}`); return true; } catch (e) { if (e instanceof GitHubError && e.status === 404) return false; throw e; }
		},
	};
}

/** The JIT config with the runner's self-update turned off. The runner takes no --disableupdate when it is
 * started with --jitconfig: it writes the config's files (.runner, .credentials, …) and runs with the
 * settings in .runner, so DisableUpdate is set there. The image is the source of truth for the runner's
 * version (image/layers/github-runner.sh), and an update would be lost with the next reset anyway. A config
 * in a shape this doesn't know is passed on unchanged. @param {string} encoded @returns {{ encoded: string, patched: boolean }} */
export function disableUpdates(encoded) {
	try {
		const files = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
		if (typeof files?.[".runner"] !== "string") return { encoded, patched: false };
		const settings = JSON.parse(Buffer.from(files[".runner"], "base64").toString("utf8").replace(/^﻿/, ""));
		if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return { encoded, patched: false };
		for (const k of Object.keys(settings)) if (k.toLowerCase() === "disableupdate") delete settings[k];
		settings.DisableUpdate = true;
		files[".runner"] = Buffer.from(JSON.stringify(settings)).toString("base64");
		return { encoded: Buffer.from(JSON.stringify(files)).toString("base64"), patched: true };
	} catch { return { encoded, patched: false }; }
}

/** The labels every runner gets: self-hosted, linux, the VM's architecture, boxery, then the configured
 *  ones (case-insensitively unique, like GitHub's). @param {string[]} extra @param {string} arch */
export function runnerLabels(extra, arch) {
	const out = /** @type {string[]} */ ([]);
	for (const l of ["self-hosted", "linux", arch, "boxery", ...extra]) if (!out.some((o) => o.toLowerCase() === l.toLowerCase())) out.push(l);
	return out;
}
/** GitHub's name for the VMs' architecture: the host's, or Lima's emulated one (BOXERY_LIMA_ARCH). @param {NodeJS.ProcessEnv} env */
export function guestArch(env, arch = process.arch) {
	const lima = env.BOXERY_BACKEND === "lima" ? env.BOXERY_LIMA_ARCH : "";
	if (lima) return /^(aarch64|arm64)$/.test(lima) ? "arm64" : "x64";
	return arch === "arm64" ? "arm64" : "x64";
}

// ---------------------------------------------------------------- the manager
/** @param {number} ms @param {AbortSignal} [signal] @returns {Promise<void>} resolves early when signal aborts */
const realSleep = (ms, signal) => new Promise((resolve) => {
	if (signal?.aborted) return resolve();
	const done = () => { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); };
	const t = setTimeout(done, ms);
	signal?.addEventListener("abort", done, { once: true });
});

/** @typedef {RunnerLease & { adopted: boolean, runnerId: number | null, runner: string | null, lost: boolean, exited: boolean }} Slot */
/** Delays (ms). @typedef {{ poll: number, noVm: [number, number], api: [number, number], retry: number, unreachable: number }} RunnerTiming */
export const TIMING = /** @type {RunnerTiming} */ ({ poll: 15000, noVm: [5000, 60000], api: [10000, 300000], retry: 30000, unreachable: 8 });

export class RunnerManager {
	/** @param {{ config: RunnerConfig, github: GitHub, pool: RunnerPool, guest: RunnerGuest, arch: string, log?: (m: string) => unknown,
	 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>, now?: () => number, random?: () => string,
	 *   saveState?: (slots: SlotState[]) => unknown, savedRunners?: Record<string, { runner_id: number | null, runner: string | null }>, timing?: Partial<RunnerTiming>,
	 *   once?: boolean }} deps once: a local runner (runOnce()): no back-off, no busy check, its own log lines */
	constructor({ config, github, pool, guest, arch, log: logFn = log, sleep = realSleep, now = Date.now, random = () => randomBytes(3).toString("hex"),
		saveState = () => {}, savedRunners = {}, timing = {}, once = false }) {
		this.config = config; this.github = github; this.pool = pool; this.guest = guest;
		this.labels = runnerLabels(config.labels, arch);
		this.once = once;
		this.log = once ? logFn : (/** @type {string} */ m) => logFn(`runners: ${m}`);
		this.sleep = sleep; this.now = now; this.random = random; this.saveState = saveState; this.savedRunners = savedRunners;
		this.timing = { ...TIMING, ...timing };
		this.stopping = new AbortController();
		/** VMs found without the runner layer: not leased again by this manager. @type {Set<string>} */
		this.unusable = new Set();
		/** @type {Map<number, SlotState>} */
		this.slots = new Map();
		this.exhausted = false; // "no free VM" logged once per spell
		this.releaseOnStop = true;
	}

	/** release: give back what is idle (`runners stop`); without it (a restart: an upgrade runs init, which
	 *  restarts the service, under the host-wide lock that releases would wait for) every lease is left as it
	 *  is, and the next manager adopts or releases it. @param {{ release?: boolean }} [opts] */
	stop({ release = true } = {}) { this.releaseOnStop = release; this.stopping.abort(); }
	get stopped() { return this.stopping.signal.aborted; }

	/** @param {number} slot @param {Partial<SlotState>} patch */
	phase(slot, patch) {
		const s = { slot, vm: null, phase: "idle", runner: null, runner_id: null, ...this.slots.get(slot), ...patch, since: Math.floor(this.now() / 1000) };
		this.slots.set(slot, s);
		try { this.saveState([...this.slots.values()]); } catch (e) { this.log(`could not save state: ${/** @type {Error} */ (e).message}`); }
	}

	async run() {
		const scope = this.config.repo ? `repo ${this.config.repo}` : `org ${this.config.org}`;
		this.log(`serving ${scope}: ${this.config.count} runner(s) on ${this.config.vms.join(", ")} (labels ${this.labels.join(",")})`);
		const adopted = await this.recover();
		await this.cleanRegistrations(adopted);
		const n = Math.max(this.config.count, adopted.length);
		await Promise.all(Array.from({ length: n }, (_, i) => this.loop(i, adopted[i])));
		this.log("stopped");
	}

	/** Leases this holder still has from a previous manager: adopt the VMs whose runner still runs, release
	 *  the rest. @returns {Promise<Slot[]>} */
	async recover() {
		/** @type {Slot[]} */
		const adopted = [];
		for (const row of this.pool.held()) {
			if (row.state !== "LEASED" || !row.lease_id) continue; // ACQUIRING/RESETTING rows: the pool's own recovery
			const status = await this.guest.status(row.name);
			if (status === "running") {
				const saved = this.savedRunners[row.name] ?? { runner_id: null, runner: null };
				this.log(`${row.name}: adopting its running runner${saved.runner ? ` ${saved.runner}` : ""}`);
				adopted.push({ vm: row.name, lease: row.lease_id, expires: row.expires_at ?? 0, adopted: true, runnerId: saved.runner_id, runner: saved.runner, lost: false, exited: false });
			} else {
				this.log(`${row.name}: releasing a lease left by an earlier manager (runner ${status})`);
				await this.pool.release(row.lease_id).catch((e) => this.log(`${row.name}: release failed: ${e.message}`));
			}
		}
		return adopted;
	}

	/** Delete registrations of ours that nothing runs (offline, idle, not adopted). @param {Slot[]} adopted */
	async cleanRegistrations(adopted) {
		const keep = new Set(adopted.map((s) => s.runnerId));
		let runners;
		try { runners = await this.github.list(); }
		catch (e) { this.log(`could not list runners to clean up: ${/** @type {Error} */ (e).message}`); return; }
		for (const r of runners) {
			// Never a local runner's, whatever the prefix: its controller deletes it (checkConfig keeps prefixes apart too).
			if (!String(r.name).startsWith(`${this.config.prefix}-`) || isLocalName(String(r.name)) || r.status !== "offline" || r.busy || keep.has(r.id)) continue;
			try { if (await this.github.remove(r.id)) this.log(`deleted stale runner registration ${r.name}`); }
			catch (e) { this.log(`could not delete ${r.name}: ${/** @type {Error} */ (e).message}`); }
		}
	}

	/** Slot I: serve FIRST (an adopted VM), then lease, serve and release until stopped. Slots past `count`
	 *  (adopted beyond a lowered count) end after their job. @param {number} i @param {Slot} [first] */
	async loop(i, first) {
		const delay = { noVm: this.timing.noVm[0] };
		this.phase(i, { phase: "idle" });
		for (let next = first; !this.stopped;) {
			const slot = next ?? await this.claim(i, delay);
			next = undefined;
			if (slot) {
				// Effects report their own failures; anything else (a host command that can't even spawn) must
				// not take the other slots down with it.
				try { await this.serve(i, slot); }
				catch (e) { this.log(`slot ${i}: ${/** @type {Error} */ (e).message}`); await this.sleep(this.timing.retry, this.stopping.signal); }
			}
			if (slot && i >= this.config.count) break;
		}
		this.slots.delete(i);
		try { this.saveState([...this.slots.values()]); } catch { /* best effort */ }
	}

	/** @param {number} i @param {{ noVm: number }} delay @returns {Promise<Slot | null>} */
	async claim(i, delay) {
		const only = this.config.vms.filter((v) => !this.unusable.has(v));
		if (!only.length) {
			this.phase(i, { phase: "no runner VMs", vm: null });
			await this.sleep(this.timing.noVm[1], this.stopping.signal);
			return null;
		}
		let lease;
		try { lease = await this.pool.acquire(only); }
		catch (e) {
			this.log(`slot ${i}: acquire failed: ${/** @type {Error} */ (e).message}`);
			await this.sleep(this.timing.retry, this.stopping.signal);
			return null;
		}
		if (!lease) {
			if (!this.exhausted) this.log(`no free runner VM (${only.join(", ")}); waiting`);
			this.exhausted = true;
			this.phase(i, { phase: "waiting for a VM", vm: null });
			await this.sleep(delay.noVm, this.stopping.signal);
			delay.noVm = Math.min(delay.noVm * 2, this.timing.noVm[1]);
			return null;
		}
		this.exhausted = false;
		delay.noVm = this.timing.noVm[0];
		return { ...lease, adopted: false, runnerId: null, runner: null, lost: false, exited: false };
	}

	/** Renew S's lease at a third of the TTL until DONE aborts; S.lost once it can't be renewed before it
	 *  expires. @param {Slot} s @param {AbortSignal} done */
	async keepAlive(s, done) {
		const every = this.config.ttl * 1000 / 3;
		let wait = every;
		while (!done.aborted) {
			await this.sleep(wait, done);
			if (done.aborted) return;
			try { s.expires = await this.pool.renew(s.lease); wait = every; }
			catch (e) {
				if (this.now() / 1000 >= s.expires) { s.lost = true; this.log(`${s.vm}: lease lost (${/** @type {Error} */ (e).message})`); return; }
				this.log(`${s.vm}: renew failed, retrying: ${/** @type {Error} */ (e).message}`);
				wait = Math.min(this.timing.retry, every);
			}
		}
	}

	/** One lease: register, start, wait, clean up. @param {number} i @param {Slot} s */
	async serve(i, s) {
		const done = new AbortController();
		const renewing = this.keepAlive(s, done.signal);
		let keep = false;
		try {
			if (!s.adopted && !await this.startRunner(i, s)) return;
			this.phase(i, { vm: s.vm, phase: "running", runner: s.runner, runner_id: s.runnerId });
			let misses = 0;
			while (!this.stopped && !s.lost) {
				const status = await this.guest.status(s.vm);
				if (status === "running") misses = 0;
				else if (status === "unreachable") {
					if (++misses >= this.timing.unreachable) { this.log(`${s.vm}: unreachable for ${misses} polls; giving the VM back`); break; }
				} else { s.exited = true; this.log(`${s.vm}: runner ${s.runner ?? ""} finished`.replace("  ", " ")); break; }
				await this.sleep(this.timing.poll, this.stopping.signal);
			}
			// A local runner always gives its VM back: nobody would adopt it.
			if (!this.once && this.stopped && this.releaseOnStop && !s.exited && !s.lost) keep = await this.busy(s);
		} finally {
			done.abort();
			await renewing;
			const until = `lease until ${new Date(s.expires * 1000).toISOString()}`;
			if (keep) this.log(`${s.vm}: its runner is running a job; leaving it for the next manager (${until})`);
			else if (this.stopped && !this.releaseOnStop && !s.lost) this.log(`${s.vm}: restarting; left for the next manager (${until})`);
			else await this.giveBack(i, s);
		}
	}

	/** Lease S is new: check the VM, get a JIT config (retrying API errors with the clean VM held), start
	 *  the runner. False when the slot gave up. @param {number} i @param {Slot} s */
	async startRunner(i, s) {
		this.phase(i, { vm: s.vm, phase: "checking", runner: null, runner_id: null });
		const status = await this.guest.status(s.vm);
		if (status === "missing") {
			this.unusable.add(s.vm);
			this.log(`${s.vm}: has no GitHub runner (make runner VMs with: boxery new NAME --headless --layers github-runner); not using it`);
			return false;
		}
		if (status !== "none") { this.log(`${s.vm}: not ready for a runner (${status})`); return false; }
		this.phase(i, { phase: "registering" });
		let backoff = this.timing.api[0];
		/** @type {{ id: number, name: string, encoded: string } | null} */
		let jit = null;
		while (!jit && !this.stopped && !s.lost) {
			try { jit = await this.github.generateJitConfig({ vm: s.vm, name: `${this.config.prefix}-${s.vm}-${this.random()}`, labels: this.labels, group: this.config.group }); }
			catch (e) {
				const err = /** @type {GitHubError} */ (e);
				// A local runner's controller registers it, and retrying is its call: give up, on every VM.
				if (this.once) { this.log(`${s.vm}: ${err.message}`); this.stop(); break; }
				const wait = err.retryAfter != null ? Math.min(err.retryAfter * 1000, 3600000) : backoff;
				this.log(`${s.vm}: GitHub API error, retrying in ${Math.round(wait / 1000)}s: ${err.message}`);
				this.phase(i, { phase: `GitHub API error (${err.status || "network"})` });
				await this.sleep(wait, this.stopping.signal);
				backoff = Math.min(backoff * 2, this.timing.api[1]);
			}
		}
		if (!jit) return false;
		s.runnerId = jit.id; s.runner = jit.name;
		this.phase(i, { phase: "starting", runner: jit.name, runner_id: jit.id });
		try { await this.guest.start(s.vm, disableUpdates(jit.encoded).encoded); }
		catch (e) { this.log(`${s.vm}: could not start runner ${jit.name}: ${/** @type {Error} */ (e).message}`); return false; }
		this.log(`${s.vm}: runner ${jit.name} waiting for a job`);
		return true;
	}

	/** A local runner (`runners __once`): one slot, served once. Leases a free VM among config.vms (one
	 *  without the runner layer, or not fresh, is given back and the next one tried), registers and starts
	 *  the runner, waits for it to exit (or stop()), gives the VM back. Never waits for a VM.
	 *  @returns {Promise<{ outcome: "exited" | "stopped" | "lost" | "failed" | "busy" | "unusable", vm: string | null }>}
	 *  busy: no free VM; unusable: none of them can run a runner */
	async runOnce() {
		for (;;) {
			const only = this.config.vms.filter((v) => !this.unusable.has(v));
			if (this.stopped) return { outcome: "stopped", vm: null };
			if (!only.length) return { outcome: "unusable", vm: null };
			const lease = await this.pool.acquire(only);
			if (!lease) return { outcome: "busy", vm: null };
			/** @type {Slot} */
			const s = { ...lease, adopted: false, runnerId: null, runner: null, lost: false, exited: false };
			try { await this.serve(0, s); }
			catch (e) { this.log(`${s.vm}: ${/** @type {Error} */ (e).message}`); return { outcome: "failed", vm: s.vm }; }
			if (s.exited) return { outcome: "exited", vm: s.vm };
			if (s.lost) return { outcome: "lost", vm: s.vm };
			if (this.stopped) return { outcome: "stopped", vm: s.vm };
			if (s.runner) return { outcome: "failed", vm: s.vm }; // registered but didn't start, or stopped answering
			this.unusable.add(s.vm); // no runner layer, or not fresh: try another
		}
	}

	/** On shutdown: is S's runner on a job? Then it keeps its VM. Unknown (API down) counts as busy.
	 *  @param {Slot} s */
	async busy(s) {
		if (s.runnerId == null) return true; // adopted without a record: can't tell, don't cut a job short
		try { return Boolean((await this.github.get(s.runnerId))?.busy); }
		catch (e) { this.log(`${s.vm}: can't tell whether ${s.runner} is busy (${/** @type {Error} */ (e).message}); leaving it`); return true; }
	}

	/** Stop the runner if it still runs, delete its registration (normally gone already: a JIT runner
	 *  deregisters after its job), release the lease (unless lost): the pool resets the VM. @param {number} i @param {Slot} s */
	async giveBack(i, s) {
		this.phase(i, { phase: "releasing" });
		if (!s.exited && s.runner) await this.guest.stop(s.vm).catch(() => {});
		if (s.runnerId != null) {
			try { await this.github.remove(s.runnerId); }
			catch (e) { this.log(`${s.vm}: could not delete runner ${s.runner}: ${/** @type {Error} */ (e).message} (cleaned up on the next start)`); }
		}
		if (!s.lost) await this.pool.release(s.lease).catch((e) => this.log(`${s.vm}: release failed (the reaper resets it when the lease expires): ${e.message}`));
		this.phase(i, { vm: null, phase: "idle", runner: null, runner_id: null });
	}
}

// ---------------------------------------------------------------- host bindings
/** Run boxery-host ARGS (this profile: BOXERY_CONF/BOXERY_PROFILE are inherited). stderr is passed on
 *  unless QUIET says which exit codes to keep quiet. @param {Runtime} rt @param {string[]} args @param {{ input?: string, quiet?: number[] }} [opts]
 *  @returns {Promise<{ code: number, out: string, err: string }>} */
function boxeryHost(rt, args, { input = "", quiet = [] } = {}) {
	return new Promise((resolve) => {
		const child = spawn(path.join(rt.root, "host/boxery-host"), args, { stdio: ["pipe", "pipe", "pipe"] });
		let out = "", err = "";
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", (d) => { err += d; });
		child.stdin.on("error", () => {});
		child.stdin.end(input);
		child.on("error", (e) => resolve({ code: -1, out, err: e.message }));
		child.on("close", (code) => {
			if (!quiet.includes(code ?? -1)) process.stderr.write(err);
			resolve({ code: code ?? -1, out, err });
		});
	});
}
/** acquire/renew --json → {name, lease_id, expires_at}, or null if it isn't one. @param {string} out */
function leaseReply(out) {
	try {
		const r = JSON.parse(out);
		return VALID_NAME.test(r?.name ?? "") && /^l-[0-9a-f]{32}$/.test(r?.lease_id ?? "") && Number.isSafeInteger(r?.expires_at) ? /** @type {{ name: string, lease_id: string, expires_at: number }} */ (r) : null;
	} catch { return null; }
}
const lastLine = (/** @type {string} */ s) => s.trim().split("\n").at(-1)?.replace(/^boxery-host: /, "") ?? "";

/** @param {Runtime} rt @param {number} ttl @param {string} [holder] @returns {RunnerPool} */
export function hostPool(rt, ttl, holder = HOLDER) {
	return {
		async acquire(only) {
			// The lease key is the host's own management key: it is in every pool VM anyway, and nobody but
			// the host needs to log in to a runner VM.
			const r = await boxeryHost(rt, ["acquire", "--holder", holder, "--ttl", String(ttl), "--only", only.join(","), "--json"],
				{ input: `${rt.guest.hostPubkey()}\n`, quiet: [4] });
			if (r.code === 4) return null;
			const reply = r.code === 0 ? leaseReply(r.out) : null;
			if (!reply) throw new Error(lastLine(r.err) || `acquire exited ${r.code}`);
			return { vm: reply.name, lease: reply.lease_id, expires: reply.expires_at };
		},
		async renew(lease) {
			const r = await boxeryHost(rt, ["renew", lease, "--ttl", String(ttl), "--json"], { quiet: [1] });
			const reply = r.code === 0 ? leaseReply(r.out) : null;
			if (!reply) throw new Error(lastLine(r.err) || `renew exited ${r.code}`);
			return reply.expires_at;
		},
		async release(lease) {
			const r = await boxeryHost(rt, ["release", lease]);
			if (r.code !== 0) throw new Error(lastLine(r.err) || `release exited ${r.code}`);
		},
		held: () => leases.heldBy(rt.db(), holder),
	};
}

/** boxery-runner in the guest, over the host's ssh. The JIT config goes over ssh's stdin, never argv.
 *  @param {Runtime} rt @returns {RunnerGuest} */
export function hostGuest(rt) {
	const ep = (/** @type {string} */ vm) => rt.vms.sshEndpoint(vm, { quiet: true });
	return {
		async status(vm) {
			let e;
			try { e = await ep(vm); } catch { return "unreachable"; }
			const code = await rt.guest.run(e, `${HELPER} status`, { quiet: true });
			return code === 0 ? "running" : code === 1 ? "exited" : code === 2 ? "none" : code === 127 ? "missing" : "unreachable";
		},
		async start(vm, jitConfig) {
			const code = await rt.guest.run(await ep(vm), `${HELPER} start`, { input: jitConfig });
			if (code !== 0) throw new Error(`boxery-runner start exited ${code}`);
		},
		async stop(vm) { await rt.guest.run(await ep(vm), `${HELPER} stop`, { quiet: true }); },
	};
}

/** @param {string} conf @returns {Record<string, { runner_id: number | null, runner: string | null }>} */
function savedRunners(conf) {
	try {
		const { slots = [] } = JSON.parse(readFileSync(path.join(conf, STATE_FILE), "utf8"));
		return Object.fromEntries(/** @type {SlotState[]} */ (slots).filter((s) => s.vm).map((s) => [s.vm, { runner_id: s.runner_id, runner: s.runner }]));
	} catch { return {}; }
}

/** One manager per profile: $CONF/runners.lock holds its pid and process identity.
 *  @param {string} conf @returns {() => void} unlock */
function lockManager(conf) {
	const file = path.join(conf, LOCK_FILE);
	const me = `${process.pid} ${leases.identity(process.pid)}\n`;
	for (let i = 0; i < 2; i++) {
		try { writeFileSync(file, me, { flag: "wx", mode: 0o600 }); return () => { try { if (readFileSync(file, "utf8") === me) unlinkSync(file); } catch { /* gone */ } }; }
		catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e; }
		const [pid, ...start] = readFileSync(file, "utf8").trim().split(" ");
		if (/^\d+$/.test(pid) && leases.identity(Number(pid)) === start.join(" ")) fail(`a runner manager is already running (pid ${pid})`);
		rmSync(file, { force: true }); // its process is gone
	}
	return fail("could not take the runner manager lock");
}

/** `runners run`: the manager, in the foreground until SIGTERM/SIGINT. BOXERY_RUNNERS_POLL (seconds) sets
 *  how often a runner is checked (default 15). @param {Runtime} rt */
async function runManager(rt) {
	const config = loadRunnerConfig(rt.conf);
	if (!readGithubToken(rt.conf)) fail(`no GitHub token in ${path.join(rt.conf, TOKEN_FILE)} (boxery-host runners token < FILE)`);
	const unlock = lockManager(rt.conf);
	const stopFile = path.join(rt.conf, STOP_FILE);
	rmSync(stopFile, { force: true }); // from a `runners stop` that didn't finish
	const poll = Number(rt.env.BOXERY_RUNNERS_POLL);
	const manager = new RunnerManager({
		config, arch: guestArch(rt.env),
		github: createGitHub({ api: config.api, repo: config.repo, org: config.org, token: () => readGithubToken(rt.conf) }),
		pool: hostPool(rt, config.ttl), guest: hostGuest(rt),
		saveState: (slots) => writePrivate(path.join(rt.conf, STATE_FILE), `${JSON.stringify({ pid: process.pid, updated: Math.floor(Date.now() / 1000), slots })}\n`),
		savedRunners: savedRunners(rt.conf),
		timing: poll > 0 ? { poll: poll * 1000 } : {},
	});
	// SIGTERM from `runners stop` (it leaves STOP_FILE first) or Ctrl-C: give back idle runners. Any other
	// SIGTERM is a restart (an upgrade's init, systemctl restart): leave every lease for the next manager.
	const term = () => manager.stop({ release: existsSync(stopFile) }), int = () => manager.stop();
	process.on("SIGTERM", term); process.on("SIGINT", int);
	try { await manager.run(); }
	finally { process.off("SIGTERM", term); process.off("SIGINT", int); unlock(); }
}

// ---------------------------------------------------------------- local runners (runners __once)
// A local runner's lease TTL: renewed at a third of it while this process runs, so a host process that
// dies mid-job holds the VM for at most this long before the reaper resets it.
export const ONCE_TTL = 300;
// No word from the controller for this long (it sends a heartbeat every few seconds): it is gone.
export const HEARTBEAT = 120000;

/** The controller's side of `runners __once`, on INPUT (stdin): its first non-empty line is "ID JITCONFIG"
 * (the runner's id and its encoded JIT config), every later line a heartbeat. EOF, an error, or silence for
 * HEARTBEAT ms means the controller is gone (Ctrl-C, a closed laptop, a dropped connection): GONE is called
 * once with the reason. @param {NodeJS.ReadableStream} input @param {number} heartbeat @param {(why: string) => void} gone */
export function controllerLink(input, heartbeat, gone) {
	let buf = "", ended = false, first = true;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let timer;
	/** @type {(line: string) => void} */
	let resolve = () => {};
	/** @type {(e: Error) => void} */
	let reject = () => {};
	/** @type {Promise<string>} */
	const jit = new Promise((res, rej) => { resolve = res; reject = rej; });
	jit.catch(() => {}); // nobody may be waiting for it
	const end = (/** @type {string} */ why) => {
		if (ended) return;
		ended = true; clearTimeout(timer);
		reject(new Error(why)); gone(why);
	};
	const arm = () => { clearTimeout(timer); timer = setTimeout(() => end(`no word from the controller for ${Math.round(heartbeat / 1000)}s`), heartbeat); };
	arm();
	input.setEncoding("utf8");
	input.on("data", (/** @type {string} */ d) => {
		if (ended) return;
		arm();
		buf += d;
		for (let i; (i = buf.indexOf("\n")) >= 0;) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			if (line && first) { first = false; resolve(line); }
		}
		if (buf.length > 65536) end("the controller sent too long a line");
	});
	input.on("end", () => end("the controller is gone"));
	input.on("error", () => end("the controller is gone"));
	return {
		/** Resolves with the first line; rejects once the controller is gone. */
		jit,
		close() { ended = true; clearTimeout(timer); /** @type {any} */ (input).destroy?.(); },
	};
}

/** `runners __once [--vms A,B] [--labels L,…]`: one local runner (`boxery runners once`, docs/github-runners.md).
 * Leases a pool VM as LOCAL_HOLDER (default VMs: the host runners' configured ones, else the whole pool),
 * then talks to the controller, which registers the runner with its own gh login:
 *   stdout: `register VM NAME LABEL,…` (answer: "ID JITCONFIG" on stdin), `started` once the runner waits
 *   for a job, and last the outcome: exited | stopped | lost | failed. Exit 0 only for exited; 4: no free VM.
 *   stdin: that answer, then heartbeats; EOF or silence (controllerLink) stops the runner and gives the VM back.
 * The JIT config is kept in memory and goes to the VM over ssh stdin, as for host runners.
 * @param {Runtime} rt @param {string[]} args */
async function localRunner(rt, args) {
	const opts = { vms: "", labels: "" };
	for (let i = 0; i < args.length; i += 2) {
		const k = args[i] === "--vms" ? "vms" : args[i] === "--labels" ? "labels" : null;
		if (!k || args[i + 1] == null) fail("usage: runners __once [--vms NAME,…] [--labels L,…] (boxery runners once runs it)");
		opts[k] = args[i + 1];
	}
	const labels = opts.labels.split(",").filter(Boolean);
	if (labels.length > 90 || !labels.every((l) => LABEL.test(l))) fail("labels are [A-Za-z0-9._-], at most 64 characters each");
	const db = rt.db();
	const pool = leases.list(db);
	if (!pool.length) fail("the pool is empty: make runner VMs (boxery new NAME --headless --layers github-runner) and add them (boxery pool add NAME)");
	const configured = readConfig(rt.conf)?.vms;
	/** @type {string[]} */
	const vms = [...new Set(opts.vms ? opts.vms.split(",").filter(Boolean)
		: Array.isArray(configured) && configured.length ? configured.map(String) : pool.map((r) => r.name))];
	const outside = vms.filter((v) => !pool.some((r) => r.name === v));
	if (outside.length) fail(`not pool VMs: ${outside.join(", ")} (boxery pool add NAME)`);
	const guest = hostGuest(rt);
	// Skip free VMs without the runner (an agent's pool VM): leasing one only to give it back would reset it.
	const missing = new Set((await Promise.all(pool.filter((r) => vms.includes(r.name) && r.state === "FREE")
		.map(async (r) => ((await guest.status(r.name)) === "missing" ? r.name : null)))).filter(Boolean));
	const emit = (/** @type {string} */ line) => { try { process.stdout.write(`${line}\n`); } catch { /* gone: stdin says so too */ } };

	/** @type {RunnerManager | undefined} */
	let manager;
	const link = controllerLink(process.stdin, Number(rt.env.BOXERY_RUNNERS_HEARTBEAT) * 1000 || HEARTBEAT, (why) => {
		if (manager && !manager.stopped) { log(`${why}: stopping the runner`); manager.stop(); }
	});
	/** @type {GitHub} the controller is this runner's GitHub: it registers the runner and deletes it */
	const github = {
		async generateJitConfig({ vm, name, labels: l }) {
			emit(`register ${vm} ${name} ${l.join(",")}`);
			const m = /^(\d{1,20}) ([A-Za-z0-9+/=]{1,60000})$/.exec(await link.jit);
			if (!m) throw new GitHubError("the controller sent no runner configuration");
			return { id: Number(m[1]), name, encoded: m[2] };
		},
		list: async () => [], get: async () => null, remove: async () => false,
	};
	let started = false;
	const poll = Number(rt.env.BOXERY_RUNNERS_POLL);
	const m = new RunnerManager({
		config: { vms: vms.filter((v) => !missing.has(v)), count: 1, labels, group: 1, ttl: ONCE_TTL, api: "", prefix: LOCAL_PREFIX },
		github, pool: hostPool(rt, ONCE_TTL, LOCAL_HOLDER), guest, arch: guestArch(rt.env), once: true,
		saveState: (slots) => { if (!started && slots[0]?.phase === "running") { started = true; emit("started"); } },
		timing: poll > 0 ? { poll: poll * 1000 } : {},
	});
	manager = m;
	// A controller that went away mid-write: stop, don't die (dying would leave the runner and the lease).
	const quit = () => m.stop();
	const signals = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);
	process.stdout.on("error", quit); process.stderr.on("error", () => {});
	for (const sig of signals) process.on(sig, quit);
	let result;
	try { result = await m.runOnce(); }
	finally { link.close(); for (const sig of signals) process.off(sig, quit); }
	if (result.outcome === "busy" || result.outcome === "unusable") {
		const rows = leases.list(db).filter((r) => vms.includes(r.name));
		const why = rows.map((r) => `${r.name}: ${missing.has(r.name) || m.unusable.has(r.name) ? "no runner" : r.state === "LEASED" ? `leased to ${r.holder}` : r.state.toLowerCase()}`).join(", ");
		const hint = rows.some((r) => r.holder === HOLDER) ? "; host runners keep their VMs while they run (boxery runners stop frees them)" : "";
		return fail(result.outcome === "busy"
			? `no free runner VM (${why})${hint}. Try again when one is free, or pass --vms NAME,… with other pool VMs`
			: `no pool VM here can run a runner (${why}). Make runner VMs: boxery new NAME --headless --layers github-runner, then boxery pool add NAME`, 4);
	}
	emit(result.outcome);
	if (result.outcome !== "exited") process.exitCode = 1;
}

// ---------------------------------------------------------------- service and CLI
/** @param {string} cmd @param {string[]} args @returns {Promise<{ code: number, out: string }>} */
function exec(cmd, args) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (d) => { out += d; });
		child.on("error", () => resolve({ code: -1, out }));
		child.on("close", (code) => resolve({ code: code ?? -1, out }));
	});
}
/** @param {string} cmd @param {string[]} args */
async function must(cmd, args) {
	const r = await exec(cmd, args);
	if (r.code !== 0) fail(`${cmd} ${args.join(" ")} failed`);
}
/** The runner manager's service file: [path, text]. @param {Runtime} rt */
function unitFile(rt) {
	const files = serviceFiles(rt, { node: process.execPath, bind: "127.0.0.1" });
	const entry = Object.entries(files).find(([f]) => path.basename(f).startsWith(process.platform === "darwin" ? `dev.${rt.runnersUnit}.` : `${rt.runnersUnit}.`));
	return entry ?? fail("no runner manager service for this platform");
}
/** active | inactive | failed | … (systemd), loaded | not loaded (launchd). @param {Runtime} rt */
async function serviceState(rt) {
	if (process.platform === "darwin") {
		const uid = /** @type {() => number} */ (process.getuid)();
		return (await exec("launchctl", ["print", `gui/${uid}/dev.${rt.runnersUnit}`])).code === 0 ? "loaded" : "not loaded";
	}
	return (await exec("systemctl", ["--user", "is-active", `${rt.runnersUnit}.service`])).out.trim() || "unknown";
}

/** @param {Runtime} rt @param {"start" | "stop"} action */
async function service(rt, action) {
	if (action === "start") {
		loadRunnerConfig(rt.conf);
		if (!readGithubToken(rt.conf)) fail(`no GitHub token yet: boxery-host runners token < FILE`);
	}
	const [file, text] = unitFile(rt);
	// A stop gives back idle runners: the manager reads this file when SIGTERM comes (runManager).
	const stopFile = path.join(rt.conf, STOP_FILE);
	if (action === "stop") writePrivate(stopFile, "stop\n");
	try {
		if (process.platform === "darwin") {
			const uid = /** @type {() => number} */ (process.getuid)();
			if (action === "start") {
				mkdirSync(path.dirname(file), { recursive: true }); mkdirSync(path.join(homedir(), "Library/Logs"), { recursive: true });
				writeFileSync(file, text);
				await reloadAgent(`gui/${uid}`, `dev.${rt.runnersUnit}`, file); // waits out a job launchd is still removing (#132)
			} else {
				await exec("launchctl", ["bootout", `gui/${uid}/dev.${rt.runnersUnit}`]); // not loaded is fine
				rmSync(file, { force: true });
			}
		} else if (action === "start") {
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, text);
			await must("systemctl", ["--user", "daemon-reload"]);
			await must("systemctl", ["--user", "enable", "--now", `${rt.runnersUnit}.service`]);
		} else {
			// Waits for the manager to exit. A unit that was never started: nothing to stop.
			await exec("systemctl", ["--user", "disable", "--now", `${rt.runnersUnit}.service`]);
		}
	} finally { rmSync(stopFile, { force: true }); }
	log(`runner manager ${action === "start" ? "started" : "stopped"} (${rt.runnersUnit}; logs: ${process.platform === "darwin" ? `~/Library/Logs/${rt.runnersUnit}.log` : `journalctl --user -u ${rt.runnersUnit}`})`);
}

const USAGE = `usage: runners status [--json] | start | stop | token < FILE | run
       runners config [--repo OWNER/REPO | --org ORG] [--vms NAME,…] [--count N] [--labels L,…] [--group ID] [--ttl S] [--api URL] [--prefix P]`;

/** runners config FLAGS: change and save the configuration (no flags: print it). @param {Runtime} rt @param {string[]} args */
function configure(rt, args) {
	const c = { ...(readConfig(rt.conf) ?? {}) };
	/** @type {Record<string, (v: string) => void>} */
	const set = {
		"--repo": (v) => { c.repo = v; delete c.org; },
		"--org": (v) => { c.org = v; delete c.repo; },
		"--vms": (v) => { c.vms = v.split(",").filter(Boolean); if (c.count > c.vms.length) delete c.count; },
		"--labels": (v) => { c.labels = v.split(",").filter(Boolean); },
		"--api": (v) => { c.api = v; },
		"--prefix": (v) => { c.prefix = v; },
		"--count": (v) => { c.count = /^\d+$/.test(v) ? Number(v) : NaN; },
		"--group": (v) => { c.group = /^\d+$/.test(v) ? Number(v) : NaN; },
		"--ttl": (v) => { c.ttl = /^\d+$/.test(v) ? Number(v) : NaN; },
	};
	for (let i = 0; i < args.length; i += 2) {
		if (!Object.hasOwn(set, args[i])) fail(`unknown flag ${args[i]}\n${USAGE}`);
		if (args[i + 1] == null) fail(`${args[i]} needs a value`);
		set[args[i]](args[i + 1]);
	}
	c.prefix ??= defaultPrefix(rt.profile);
	const checked = checkConfig(c);
	if (typeof checked === "string") fail(checked);
	/** @type {string[]} */
	let outside = [];
	try { outside = checked.vms.filter((v) => !leases.get(rt.db(), v)); } catch { /* no lease store yet */ }
	if (outside.length) log(`warning: not in the pool yet: ${outside.join(", ")} (the manager leases pool VMs only: boxery pool add NAME)`);
	if (args.length) {
		mkdirSync(rt.conf, { recursive: true });
		writePrivate(path.join(rt.conf, CONFIG_FILE), `${JSON.stringify(checked, null, 2)}\n`);
		log(`runner configuration saved${existsSync(path.join(rt.conf, STATE_FILE)) ? ` (a running manager picks it up when restarted: boxery-host runners stop && boxery-host runners start)` : ""}`);
	}
	print(JSON.stringify(checked, null, 2));
}

/** runners status [--json] @param {Runtime} rt @param {string | undefined} arg */
async function status(rt, arg) {
	if (arg && arg !== "--json") fail(USAGE);
	const raw = readConfig(rt.conf), checked = raw ? checkConfig(raw) : null;
	let token = false, tokenProblem = null;
	try { token = Boolean(readGithubToken(rt.conf)); } catch (e) { tokenProblem = /** @type {Error} */ (e).message; }
	/** @type {Record<string, SlotState>} */
	let state = {};
	try { state = Object.fromEntries(JSON.parse(readFileSync(path.join(rt.conf, STATE_FILE), "utf8")).slots.filter((/** @type {SlotState} */ s) => s.vm).map((/** @type {SlotState} */ s) => [s.vm, s])); }
	catch { /* no manager has run */ }
	const t = leases.now();
	let held = /** @type {ReturnType<typeof leases.heldBy>} */ ([]), local = held;
	try { held = leases.heldBy(rt.db(), HOLDER); local = leases.heldBy(rt.db(), LOCAL_HOLDER); } catch { fail("lease store error"); }
	const vms = held.map((r) => ({ name: r.name, lease: r.state.toLowerCase(), expires_in: r.state === "LEASED" && r.expires_at ? r.expires_at - t : null,
		runner: state[r.name]?.runner ?? null, runner_id: state[r.name]?.runner_id ?? null, phase: state[r.name]?.phase ?? null }));
	const out = {
		configured: typeof checked === "object" && checked !== null,
		...(typeof checked === "string" ? { error: checked } : {}),
		...(typeof checked === "object" && checked ? checked : {}),
		token, ...(tokenProblem ? { token_error: tokenProblem } : {}),
		service: { unit: rt.runnersUnit, state: await serviceState(rt) },
		vms_leased: vms,
		// Local runners (boxery runners once): their controllers know the rest.
		local_runners: local.map((r) => ({ name: r.name, lease: r.state.toLowerCase(), expires_in: r.state === "LEASED" && r.expires_at ? r.expires_at - t : null })),
	};
	if (arg === "--json") return print(JSON.stringify(out));
	const c = typeof checked === "object" && checked ? checked : null;
	print(table([10], [
		["config", c ? `${c.repo ? `repo ${c.repo}` : `org ${c.org}`}, ${c.count} runner(s) on ${c.vms.join(" ")}` : typeof checked === "string" ? `invalid: ${checked}` : "not configured (boxery-host runners config …)"],
		...(c ? [["labels", runnerLabels(c.labels, guestArch(rt.env)).join(" ")], ["names", `${c.prefix}-VM-…, group ${c.group}, lease ttl ${c.ttl}s, ${c.api}`]] : []),
		["token", tokenProblem ?? (token ? `set (${path.join(rt.conf, TOKEN_FILE)})` : "not set (boxery-host runners token < FILE)")],
		["service", `${rt.runnersUnit}: ${out.service.state}`],
	]));
	if (vms.length || local.length) {
		print("");
		print(table([16, 10, 10, 34], [["NAME", "LEASE", "EXPIRES", "RUNNER", "PHASE"],
			...vms.map((v) => [v.name, v.lease, v.expires_in == null ? "-" : `${v.expires_in}s`, v.runner ?? "-", v.phase ?? "-"]),
			...out.local_runners.map((v) => [v.name, v.lease, v.expires_in == null ? "-" : `${v.expires_in}s`, `${LOCAL_PREFIX}-${v.name}-…`, "local runner (boxery runners once)"])]));
	}
}

/** boxery-host runners … @param {Runtime} rt @param {string[]} args */
export async function runners(rt, [sub = "status", ...args]) {
	switch (sub) {
		case "status": return status(rt, args[0]);
		case "config": return configure(rt, args);
		case "token":
			if (args.length) fail(USAGE);
			writeGithubToken(rt.conf, readFd(0, { limit: 4096 }));
			return log(`GitHub token saved in ${path.join(rt.conf, TOKEN_FILE)} (0600)`);
		case "start": case "stop":
			if (args.length) fail(USAGE);
			return service(rt, sub);
		case "run":
			if (args.length) fail(USAGE);
			return runManager(rt);
		case "__once": return localRunner(rt, args); // a local runner: `boxery runners once` on the controller
		default: return fail(USAGE);
	}
}
