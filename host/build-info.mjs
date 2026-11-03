// Build records: what a VM's guest software was built with (/etc/boxery/build-info, written by
// boxery-provision), kept on the host so `ls`, `snaps` and `images` can say what is outdated without
// reaching into guests. One JSON file per VM and per image in $CONF/build-info/ (NAME, NAME@LABEL): the
// guest's fields, plus reboot_required and checked_at. The host refreshes a VM's record whenever it
// reaches the guest anyway (new, fork, start, revert, patch) and on `ls --refresh`; an image gets its VM's
// record when it is captured, and a pool reset puts the clean image's back.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
/** @import { GuestEndpoint } from "./guest.mjs" */
/** @import { Runtime } from "./runtime.mjs" */

/** @typedef {{ built_at: string | null, layers: string[], layers_hash: string | null, kernel: string | null, chrome: string | null,
 *   playwright_core: string | null, reboot_required: boolean, checked_at: string }} BuildRecord */
/** What listings show (docs/cli.md, `guest`; times in epoch seconds). @typedef {{ status: "current" | "outdated" | "unknown", reasons: string[], built_at: number | null,
 *   age_days: number | null, kernel: string | null, chrome: string | null, playwright_core: string | null, reboot_required: boolean | null, checked_at: number | null }} GuestStatus */

export const LAYERS = ["plumbing", "devtools", "desktop", "github-runner"];
export const STALE_DAYS = 30; // default for BOXERY_STALE_DAYS
const READ = "cat /etc/boxery/build-info 2>/dev/null; test -e /var/run/reboot-required && echo reboot_required=1; true";
const DAY = 86_400_000;

/** The layers hash a VM built from this host's image/layers would have (lib.sh, layers_hash: the same
 *  manifest of per-file hashes). @param {string} root @param {string[]} layers */
export function layersHash(root, layers) {
	const dir = path.join(root, "image", "layers");
	const sha = (/** @type {string} */ f) => createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex");
	const lines = [`${sha("lib.sh")}  lib`, `${sha("provision.sh")}  provision`, ...LAYERS.filter((l) => layers.includes(l)).map((l) => `${sha(`${l}.sh`)}  ${l}`)];
	return createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex");
}

/** The guest's key=value lines → a record. A guest without /etc/boxery/build-info (built before boxery
 *  recorded it) gives a record with built_at null. @param {string} text @param {Date} [now] @returns {BuildRecord} */
export function parseBuildInfo(text, now = new Date()) {
	/** @type {Record<string, string>} */
	const kv = {};
	for (const line of text.split("\n")) {
		const m = line.match(/^([a-z_]+)=(.*)$/);
		if (m) kv[m[1]] = m[2].trim();
	}
	const v = (/** @type {string} */ k) => kv[k] || null;
	return { built_at: v("built_at"), layers: (kv.layers ?? "").split(" ").filter(Boolean), layers_hash: v("layers_hash"), kernel: v("kernel"),
		chrome: v("chrome"), playwright_core: v("playwright_core"), reboot_required: kv.reboot_required === "1", checked_at: `${now.toISOString().slice(0, 19)}Z` };
}

const dir = (/** @type {string} */ conf) => path.join(conf, "build-info");
/** NAME's (or image NAME@LABEL's) record, null if there is none. @param {string} conf @param {string} name @returns {BuildRecord | null} */
export function buildRecord(conf, name) {
	try { return JSON.parse(readFileSync(path.join(dir(conf), name), "utf8")); }
	catch { return null; } // missing or unreadable: not known
}
/** @param {string} conf @param {string} name @param {BuildRecord} rec */
export function setBuildRecord(conf, name, rec) {
	mkdirSync(dir(conf), { recursive: true });
	const f = path.join(dir(conf), name);
	writeFileSync(`${f}.tmp`, `${JSON.stringify(rec)}\n`);
	renameSync(`${f}.tmp`, f);
}
/** FROM's record becomes TO's (none if FROM has none): a capture (VM → image), a reset or revert (image → VM).
 *  @param {string} conf @param {string} from @param {string} to */
export function copyBuildRecord(conf, from, to) {
	const f = path.join(dir(conf), from), t = path.join(dir(conf), to);
	try { mkdirSync(dir(conf), { recursive: true }); copyFileSync(f, `${t}.tmp`); renameSync(`${t}.tmp`, t); }
	catch { rmSync(t, { force: true }); }
}
/** Remove NAME's record; with images, also those of NAME's images (NAME@…). @param {string} conf @param {string} name */
export function deleteBuildRecord(conf, name, images = false) {
	rmSync(path.join(dir(conf), name), { force: true });
	if (!images) return;
	let files = /** @type {string[]} */ ([]);
	try { files = readdirSync(dir(conf)); } catch { /* none */ }
	for (const f of files) if (f.startsWith(`${name}@`)) rmSync(path.join(dir(conf), f), { force: true });
}

/** Read running VM NAME's build-info and reboot flag over ssh, and keep it. Best effort: null (and the
 *  old record kept) if the guest can't be reached. @param {Runtime} rt @param {string} name @param {GuestEndpoint} ep */
export async function refreshBuild(rt, name, ep) {
	try {
		const { code, out } = await rt.guest.output(ep, READ);
		if (code !== 0) return null;
		const rec = parseBuildInfo(out);
		setBuildRecord(rt.conf, name, rec);
		return rec;
	} catch { return null; }
}

/** Epoch seconds of an ISO time, null if there is none. @param {string | null | undefined} t */
const epoch = (t) => { const ms = t ? Date.parse(t) : NaN; return Number.isNaN(ms) ? null : Math.floor(ms / 1000); };

/** Days since an ISO-ish time (backends print local "YYYY-MM-DDTHH:MM:SS"), null if it can't be read.
 *  @param {string | null | undefined} t @param {number} now */
export function ageDays(t, now = Date.now()) {
	const ms = t ? Date.parse(t) : NaN;
	return Number.isNaN(ms) ? null : Math.max(0, Math.floor((now - ms) / DAY));
}

/** Staleness rules for this host: a record is outdated when its layers hash isn't what this host's layers
 *  give, when it was built more than BOXERY_STALE_DAYS days ago (default 30), or (VMs only) when the
 *  guest asks for a reboot. No record, or a guest that predates build-info: unknown.
 *  @param {{ root: string, env: NodeJS.ProcessEnv }} cfg @param {number} [now] */
export function guestChecker({ root, env }, now = Date.now()) {
	const maxDays = Number(env.BOXERY_STALE_DAYS) > 0 ? Number(env.BOXERY_STALE_DAYS) : STALE_DAYS;
	/** @type {Map<string, string | null>} */
	const hashes = new Map();
	const hostHash = (/** @type {string[]} */ layers) => {
		const key = layers.join(" ");
		if (!hashes.has(key)) { try { hashes.set(key, layersHash(root, layers)); } catch { hashes.set(key, null); } }
		return hashes.get(key);
	};
	/** @param {BuildRecord | null} rec @param {{ image?: boolean }} [opts] @returns {GuestStatus} */
	return (rec, { image = false } = {}) => {
		if (!rec) return { status: "unknown", reasons: ["not checked"], built_at: null, age_days: null, kernel: null, chrome: null, playwright_core: null, reboot_required: null, checked_at: null };
		const reasons = [], age = ageDays(rec.built_at, now);
		if (!rec.built_at) reasons.push("no build record");
		else {
			const want = hostHash(rec.layers ?? []);
			if (want && rec.layers_hash !== want) reasons.push("layers changed");
			if (age != null && age > maxDays) reasons.push(`built ${age} days ago`);
		}
		if (!image && rec.reboot_required) reasons.push("reboot required");
		return { status: !rec.built_at ? "unknown" : reasons.length ? "outdated" : "current", reasons, built_at: epoch(rec.built_at), age_days: age,
			kernel: rec.kernel, chrome: rec.chrome, playwright_core: rec.playwright_core, reboot_required: image ? null : rec.reboot_required, checked_at: epoch(rec.checked_at) };
	};
}
