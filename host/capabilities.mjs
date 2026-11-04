// Read-only discovery and early setup validation. Local probes only: never source a backend, create
// directories, contact a provider, start services, or infer account entitlements from credentials.
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { BACKENDS, backendMetadata, capabilityStatus, matchesPlatform, platformStatus } from "../core/backend-metadata.mjs";
import { fail, log, print } from "./util.mjs";
/** @import { Configuration, Requirement } from "../core/backend-metadata.mjs" */
/** @import { Runtime } from "./runtime.mjs" */

/** @param {Requirement} requirement @param {NodeJS.ProcessEnv} env */
function probe(requirement, env) {
	const accessible = (/** @type {string} */ file, /** @type {number} */ mode) => {
		try { accessSync(file, mode); return true; } catch { return false; }
	};
	// Backend helpers use the host's pinned Node, not whichever node happens to be on PATH.
	if (requirement.kind === "tool" && requirement.id === "node") return accessible(env.BOXERY_NODE || process.execPath, constants.X_OK);
	if (requirement.kind === "tool") return (env.PATH ?? "").split(path.delimiter).some((dir) => accessible(path.join(dir || ".", requirement.id), constants.X_OK));
	if (requirement.kind === "device") return accessible(requirement.id, constants.R_OK | constants.W_OK);
	return undefined;
}

/** @param {string} backend @param {{ env?: NodeJS.ProcessEnv, configuration?: Configuration, facts?: Record<string, boolean | undefined>, probeRequirement?: typeof probe }} [opts] */
export function assessBackend(backend, { env = process.env, configuration, facts = {}, probeRequirement = probe } = {}) {
	const metadata = backendMetadata(backend);
	const runtime = metadata.runtime.default === "platform" ? (env.BOXERY_LIMA_VMTYPE || (process.platform === "darwin" ? "vz" : "qemu")) : metadata.runtime.default;
	configuration ??= { host: { os: process.platform, arch: process.arch }, runtime };
	const platform = platformStatus(metadata, configuration);
	const requirements = metadata.requirements.map((r) => {
		const applicable = !r.when || matchesPlatform(r.when, configuration.host);
		const value = Object.hasOwn(facts, r.id) ? facts[r.id] : applicable && platform.supported ? probeRequirement(r, env) : undefined;
		return { ...r, status: !applicable ? "not-applicable" : value === undefined ? "unknown" : value ? "met" : "missing" };
	});
	const known = { ...facts, ...Object.fromEntries(requirements.map((r) => [r.id, r.status === "met" ? true : r.status === "missing" ? false : undefined])) };
	return { schemaVersion: 1, backend: metadata, configuration, platform, requirements,
		capabilities: Object.fromEntries(Object.entries(metadata.capabilities).map(([id, c]) => [id, capabilityStatus(c, known)])) };
}

/** Fail before changes, while still explaining configurations not validated by Boxery.
 * @param {string} backend @param {Parameters<typeof assessBackend>[1]} [opts] */
export function checkBackend(backend, opts) {
	if (backend === "fake") return; // internal test fixture, not a user-facing backend
	const report = assessBackend(backend, opts);
	const { configuration: { host, runtime }, platform, requirements } = report;
	if (!platform.supported) fail(`${backend} does not support boxery-host configuration ${host.os}/${host.arch} with ${runtime}. Supported host platforms: ${report.backend.supported.map((p) => `${p.os}/${p.arch}`).join(", ")}. Run boxery-host on a supported machine (a remote host is fine; the controller OS does not constrain it).`);
	if (!report.backend.runtime.options.includes(runtime)) fail(`${backend}: unsupported runtime '${runtime}'; use ${report.backend.runtime.options.join(" or ")}`);
	if (!platform.tested) log(`warning: ${backend} on ${host.os}/${host.arch} with ${runtime} is supported but not recorded as Boxery-tested`);
	if (report.backend.stability !== "stable") log(`warning: ${backend} is ${report.backend.stability}`);
	const missing = requirements.filter((r) => r.setup && r.status === "missing");
	if (missing.length) fail(`${backend} requirements not met:\n${missing.map((r) => `  ${r.id}: ${r.description}`).join("\n")}`);
	for (const r of requirements.filter((r) => r.status === "unknown")) log(`verify ${backend}: ${r.description}`);
}

/** @param {Runtime} rt @param {string[]} args */
export function capabilities(rt, args) {
	if (args.length === 1 && args[0] === "--check") return checkBackend(rt.backend, { env: rt.env });
	if (args.some((a) => a !== "--json") || args.length > 1) fail("usage: capabilities [--json | --check]");
	const report = assessBackend(rt.backend, { env: rt.env });
	if (args.includes("--json")) return print(JSON.stringify(report));
	print(`${rt.backend}: ${report.backend.stability}; boxery-host ${report.configuration.host.os}/${report.configuration.host.arch}; runtime ${report.configuration.runtime} (${report.backend.runtime.location})\nsupported: ${report.platform.supported}; tested: ${report.platform.tested}`);
	for (const [id, c] of Object.entries(report.capabilities)) print(`${id}: ${c.availability}${c.note ? ` — ${c.note}` : ""}${c.requires.length ? `; requires: ${c.requires.join(", ")}` : ""}`);
	for (const r of report.requirements) print(`${r.id}: ${r.status} — ${r.description}`);
}
/** @param {Runtime} _rt @param {string[]} args */
export function backends(_rt, args) {
	if (args.some((a) => a !== "--json") || args.length > 1) fail("usage: backends [--json]");
	if (args.includes("--json")) return print(JSON.stringify({ schemaVersion: 1, backends: Object.values(BACKENDS) }));
	for (const m of Object.values(BACKENDS)) print(`${m.id}\t${m.stability}\t${m.supported.map((p) => `${p.os}/${p.arch}`).join(", ")}\t${m.runtime.location} compute`);
}

/** Reject known-unavailable operations before supervision opens a journal or takes locks. Unknown
 * provider entitlements remain advisory; the provider is authoritative at execution time.
 * @param {string} backend @param {string} command @param {string[]} args */
export function checkOperation(backend, command, args) {
	if (backend === "fake") return;
	const metadata = backendMetadata(backend);
	const feature = command === "new" ? (args.includes("--headless") ? "headless" : "desktop")
		: ({ snap: "diskSnapshots", "snap-rm": "diskSnapshots", fork: "fork", revert: "restore", resize: "resize", acquire: "leases", "build-base": "desktop" })[command]
		?? (command === "pool" && args[0] === "add" ? "pools" : null);
	if (!feature) return;
	const c = metadata.capabilities[feature];
	if (c.status === "unsupported") fail(`${backend}: ${feature} is unavailable. ${c.note}. Discover alternatives with boxery backends --json.`);
}
