// Backend-owned names, not a portable image format. Resolve aliases BEFORE lifecycle supervision;
// workers receive ordinary --from/--headless args and retain existing source locks and validation.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";
import { vmKind } from "./kinds.mjs";
import { fail, log, print, table } from "./util.mjs";

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const IMAGE = /^[a-z][a-z0-9-]{0,30}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function read(file, fallback) {
	let text;
	try { text = readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
	if (Buffer.byteLength(text) > 1024 * 1024) fail(`template definitions too large: ${file}`);
	try { return JSON.parse(text); } catch { fail(`invalid template JSON: ${file}`); }
}
function fields(value, allowed, where) {
	if (!record(value) || Object.keys(value).some((k) => !allowed.includes(k))) fail(`invalid template ${where}`);
}

export function definitions({ conf, backend, root = ROOT }) {
	if (!NAME.test(backend)) fail("invalid template backend");
	const driver = read(path.join(root, "host/backends", `${backend}.templates.json`), { version: 1, builtins: {}, imageTemplates: false });
	fields(driver, ["version", "builtins", "imageTemplates"], "backend declaration");
	if (driver.version !== 1 || !record(driver.builtins) || typeof driver.imageTemplates !== "boolean") fail("invalid template backend declaration");
	const result = new Map();
	for (const [name, spec] of Object.entries(driver.builtins)) {
		fields(spec, ["kind", "source"], name);
		if (!NAME.test(name) || !((spec.kind === "desktop" && spec.source === "base") || (spec.kind === "headless" && spec.source === "stock"))) fail(`invalid built-in template ${name}`);
		result.set(name, { name, kind: spec.kind, source: spec.source, origin: "backend" });
	}
	const config = read(path.join(conf, "templates.json"), { version: 1, backends: {} });
	fields(config, ["version", "backends"], "configuration");
	if (config.version !== 1 || !record(config.backends)) fail("invalid template configuration version/backends");
	for (const [key, templates] of Object.entries(config.backends)) {
		if (!NAME.test(key) || !record(templates)) fail("invalid template backend definitions");
		for (const [name, spec] of Object.entries(templates)) {
			fields(spec, ["image", "description"], name);
			if (!NAME.test(name) || !IMAGE.test(spec.image ?? "") || (spec.description !== undefined &&
				(typeof spec.description !== "string" || spec.description.length > 500 || /[\x00-\x1f\x7f]/.test(spec.description)))) fail(`invalid template definition ${name}`);
			const label = spec.image.split("@")[1];
			if (label === "boxery-clean" || label.startsWith("fork-")) fail(`template ${name} cannot reference a transient lifecycle image`);
			if (key !== backend) continue;
			if (!driver.imageTemplates) fail(`${backend} does not declare disk-image template support`);
			if (result.has(name)) fail(`template ${name} is reserved by backend ${backend}`);
			result.set(name, { name, source: "image", image: spec.image, description: spec.description ?? "", origin: "profile" });
		}
	}
	return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function status(rt, spec, images) {
	if (spec.source === "image") return images.some((i) => i.image === spec.image) ? "ready" : "missing";
	return rt.vms.templateStatus(spec.source);
}
export async function listTemplates(rt) {
	const defs = definitions(rt);
	const images = defs.some((d) => d.source === "image") ? await rt.vms.images() : [];
	const templates = [];
	for (const spec of defs) {
		const state = await status(rt, spec, images);
		templates.push({ ...spec, kind: spec.kind ?? (state === "ready" ? vmKind(rt.conf, spec.image.split("@")[0]) : null), supported: true, ready: state === "ready", status: state });
	}
	return { backend: rt.backend, templates };
}
export async function templatesCommand(rt, args) {
	if (args.length > 1 || (args.length && args[0] !== "--json")) fail("usage: templates [--json]");
	const result = await listTemplates(rt);
	if (args[0] === "--json") return print(JSON.stringify(result));
	print(`Templates on ${result.backend} (this host profile)`);
	print(table([["NAME", "KIND", "STATUS", "SOURCE"], ...result.templates.map((t) => [t.name, t.kind ?? "unknown", t.status, t.image ?? t.source])]));
}

export function extractTemplate(args) {
	const out = []; let name = "";
	for (let i = 0; i < args.length; i++) {
		if (["--from", "--shape", "--cpus", "--mem", "--disk"].includes(args[i])) {
			out.push(args[i]); if (i + 1 < args.length) out.push(args[++i]); continue;
		}
		if (args[i] !== "--template") { out.push(args[i]); continue; }
		if (name) fail("--template may be specified only once");
		name = args[++i];
		if (!NAME.test(name ?? "")) fail("--template needs a valid template name");
	}
	return { name, args: out };
}
export async function applyTemplate(rt, name, options, args) {
	if (options.from || options.headless) fail("--template cannot be combined with --from or --headless");
	const spec = definitions(rt).find((t) => t.name === name);
	if (!spec) fail(`unsupported template ${name} on ${rt.backend} (boxery-host templates)`);
	const state = await status(rt, spec, spec.source === "image" ? await rt.vms.images() : []);
	if (!["ready", "on-demand"].includes(state)) fail(`template ${name} is ${state}; prepare its source first (no fallback)`);
	log(`template ${name} on ${rt.backend}: ${spec.image ?? spec.source} (${state})`);
	if (spec.source === "image") return [...args, "--from", spec.image];
	if (spec.source === "stock") return [...args, "--headless"];
	return args;
}

// Admin file edits are not transactional registration. Recheck in workers holding image/source locks.
export function assertUnreferenced(rt, matches) {
	if (!existsSync(path.join(rt.conf, "templates.json"))) return;
	const refs = definitions(rt).filter((t) => t.image && matches(t.image));
	if (refs.length) fail(`image referenced by template(s) ${refs.map((t) => t.name).join(", ")}; remove those definitions from templates.json first`);
}
