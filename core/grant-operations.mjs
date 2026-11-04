// Grant operations shared by the CLI, MCP and pi. No confirmation decisions here.
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { currentHost, assertName, deniedDirs, isWithin, REMOTE_HOME } from "./boxery-core.mjs";
import { parseGrantSpec } from "./grants.mjs";
import { q } from "./shell.mjs";
/** @import { Grant, GrantSpec, HostProfile } from "./boxery-core.mjs" */
/** CLI env-command helpers may use the original stdin and show prompts on stderr. Agent calls remain headless.
 * @typedef {{ signal?: AbortSignal, interactiveCommands?: boolean, commandStdin?: number }} GrantOptions
 */

const profileLib = fileURLToPath(new URL("../controller/profile.sh", import.meta.url));
/** Shared existing Bash profile plumbing: trusted config sourcing, host transport, SSH config rendering.
 * This is not the CLI, and contains no grant mutation or confirmation implementation.
 * @param {string} action @param {string[]} args @param {{ input?: string, signal?: AbortSignal, host?: HostProfile }} [opts]
 */
export function profileRun(action, args = [], { input, signal, host = currentHost() } = {}) {
	const script = 'set -eu; source "$1"; select_profile "$2" "$3"; shift 3; action=$1; shift; case $action in host) h "$@" ;; config) write_ssh_config ;; close) drop_master "$1" ;; *) exit 2 ;; esac';
	return new Promise((resolve, reject) => {
		const child = execFile("bash", ["-c", script, "boxery-profile", profileLib, host.name, host.dir, action, ...args], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024, signal }, (e, stdout, stderr) => {
			if (e) reject(new Error((stderr || e.message).trim()));
			else resolve(stdout.trim());
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
	});
}
const storeDir = () => path.join(currentHost().dir, "grants");
const storeFile = (/** @type {string} */ vm) => path.join(storeDir(), assertName(vm));
/** @param {string} f */
const read = (f) => existsSync(f) ? readFileSync(f, "utf8") : "";
/** @param {string} f */
const remove = (f) => { try { unlinkSync(f); } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e; } };
/** @param {string} vm @returns {Grant[]} */
export function listGrants(vm) {
	return read(storeFile(vm)).split("\n").filter(Boolean).map((line) => {
		const [kind, a, b = ""] = line.split("\t");
		switch (kind) {
			case "ssh-agent": return { kind };
			case "env": return { kind, var: a, cmd: b || null };
			case "file": return { kind, local: a, remote: `${REMOTE_HOME}/${b.startsWith(`${REMOTE_HOME}/`) ? b.slice(REMOTE_HOME.length + 1) : b}` };
			case "llm": return { kind, provider: a };
			case "http": {
				const first = b.indexOf(";"), second = b.indexOf(";", first + 1);
				return { kind, host: a, auth: b.slice(0, first), readonly: b.slice(first + 1, second) === "ro", cmd: b.slice(second + 1) };
			}
			default: throw new Error(`unknown stored grant kind: ${kind}`);
		}
	});
}
/** @param {string} vm @param {(rows: string[][]) => string[][]} change */
async function editStore(vm, change) {
	const dir = storeDir(), file = storeFile(vm), lock = path.join(dir, `.${vm}.lock`);
	mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
	let fd;
	for (let i = 0; ; i++) {
		try { fd = openSync(lock, "wx", 0o600); break; }
		catch (e) {
			if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST" || i >= 300) throw e;
			await delay(100);
		}
	}
	try {
		const rows = change(read(file).split("\n").filter(Boolean).map((l) => l.split("\t")));
		if (!rows.length) remove(file);
		else {
			const tmp = `${file}.tmp.${process.pid}`;
			writeFileSync(tmp, rows.map((r) => r.join("\t")).join("\n") + "\n", { mode: 0o600 });
			renameSync(tmp, file);
		}
	} finally { closeSync(fd); remove(lock); }
}
/** @param {GrantSpec} g @returns {string[][]} */
function rowsFor(g) {
	switch (g.kind) {
		case "github": return [rowsFor({ ...g, kind: "http", host: "github.com", auth: "basic:x-access-token", cmd: g.cmd ?? "gh auth token" })[0], rowsFor({ ...g, kind: "http", host: "api.github.com", auth: "bearer", cmd: g.cmd ?? "gh auth token" })[0]];
		case "http": return [["http", g.host ?? "", `${g.auth};${g.readonly ? "ro" : ""};${g.cmd}`]];
		case "env": return [["env", g.var ?? "", g.cmd ?? ""]];
		case "file": return [["file", g.local ?? "", g.remote ?? ""]];
		case "llm": return [["llm", g.provider ?? "", ""]];
		case "ssh-agent": return [["ssh-agent", "", ""]];
	}
}
/** Save a validated, approved batch, then reconcile. Revalidate before any writes.
 * @param {string} vm @param {GrantSpec[]} specs @param {GrantOptions} [opts]
 */
export async function addGrants(vm, specs, opts = {}) {
	assertName(vm); opts.signal?.throwIfAborted();
	const grants = specs.map((g) => {
		const checked = parseGrantSpec(g, { cli: true });
		if (g.kind === "file" && checked.local !== g.local) throw new Error(`grant file:${g.local}: path changed since approval; ask again`);
		return checked;
	});
	await editStore(vm, (rows) => {
		opts.signal?.throwIfAborted(); // Cancellation while waiting for the lock still changes nothing.
		for (const g of grants) for (const row of rowsFor(g)) rows = [...rows.filter((r) => r[0] !== row[0] || r[1] !== row[1]), row];
		return rows;
	});
	return grants.map((g) => `==> granted ${g.spec} to ${vm}`).join("\n") + "\n" + await grantsChanged(vm, opts);
}
/** @param {string} vm @param {string[]} specs @param {GrantOptions} [opts] */
export async function revokeGrants(vm, specs, opts = {}) {
	if (!specs.length) throw new Error("revoke needs a grant or all");
	const selectors = specs.map((s) => {
		if (s === "all" || s === "ssh-agent" || s === "github") return [[s, ""]];
		const i = s.indexOf(":"), kind = s.slice(0, i); let key = s.slice(i + 1);
		if (!["env", "file", "llm", "http"].includes(kind)) throw new Error(`unknown grant '${s}'`);
		if (kind === "file") {
			// Match old path-spelled grants as well as new canonical ones.
			const abs = path.resolve(key.replace(/^~(?=\/|$)/, process.env.HOME ?? ""));
			key = existsSync(abs) ? realpathSync(abs) : key;
		}
		return [[kind, key], ...(kind === "file" ? [[kind, path.resolve(s.slice(i + 1).replace(/^~(?=\/|$)/, process.env.HOME ?? ""))]] : [])];
	});
	/** @type {string[]} */
	const messages = [];
	await editStore(vm, (rows) => {
		for (let i = 0; i < specs.length; i++) {
			const before = rows.length;
			rows = rows.filter(([kind, key, extra]) => !selectors[i].some(([k, a]) => k === "all" || (k === "github" ? kind === "http" && ["github.com", "api.github.com"].includes(key) : kind === k && (k === "ssh-agent" || key === a || extra === a))));
			messages.push(rows.length < before || specs[i] === "all" ? `==> revoked ${specs[i]}` : `boxery: no grant ${specs[i]}`);
		}
		return rows;
	});
	return messages.join("\n") + "\n" + await grantsChanged(vm, opts);
}
/** @param {string} command @param {boolean} env @param {GrantOptions} opts @returns {Promise<string>} */
function commandValue(command, env, opts) {
	return new Promise((resolve, reject) => {
		const interactive = !!opts.interactiveCommands;
		const child = spawn("sh", ["-c", command], {
			stdio: [interactive && env ? opts.commandStdin ?? 0 : "ignore", "pipe", interactive ? "inherit" : "ignore"],
			timeout: interactive && env ? undefined : 30_000, signal: opts.signal,
		});
		let size = 0;
		/** @type {Buffer[]} */
		const chunks = [];
		child.stdout?.on("data", (d) => {
			size += d.length;
			if (size > 2 * 1024 * 1024) { child.kill(); reject(new Error("grant command output exceeds 2 MiB")); }
			else chunks.push(d);
		});
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks).toString().replace(/\n+$/, "")) : reject(new Error(`grant command exited ${code}`)));
	});
}
const guestTemplate = readFileSync(new URL("./grants-guest.sh", import.meta.url), "utf8");
/** @param {string} vm @param {GrantOptions} [opts] */
export async function applyGrants(vm, opts = {}) {
	const grants = listGrants(vm), hosts = {}, llm = [], cache = new Map();
	/** @type {string[]} */
	const values = [];
	/** @type {string[]} */
	const warnings = [];
	const warn = (/** @type {string} */ s) => warnings.push(`boxery: ${s}`);
	const deny = deniedDirs([currentHost().dir]);
	for (const g of grants) {
		if (g.kind === "env" || g.kind === "http") {
			let value;
			try {
				if (g.cmd) {
					const key = `${g.kind}\0${g.cmd}`;
					if (!cache.has(key)) cache.set(key, await commandValue(g.cmd, g.kind === "env", opts));
					value = cache.get(key);
				} else value = process.env[g.var ?? ""];
			} catch { warn(`grant ${g.kind}:${g.host ?? g.var}: command failed: ${g.cmd}; skipped`); continue; }
			if (!value) { warn(`grant ${g.kind}:${g.host ?? g.var}: no value on this machine; skipped`); continue; }
			if (g.kind === "env") values.push(`put_env ${q(g.var ?? "")} ${q(Buffer.from(value).toString("base64"))}`);
			else {
				value = value.replace(/[\r\n]/g, "");
				if (/[\x00-\x1f\x7f]/.test(value)) { warn(`grant http:${g.host}: value has control characters; skipped`); continue; }
				const auth = g.auth ?? "bearer", name = auth.startsWith("header:") ? auth.slice(7) : "Authorization";
				const header = auth === "bearer" ? `Bearer ${value}` : auth.startsWith("basic:") ? `Basic ${Buffer.from(`${auth.slice(6)}:${value}`).toString("base64")}` : value;
				/** @type {Record<string, unknown>} */ (hosts)[g.host ?? ""] = { headers: { [name]: header }, readonly: !!g.readonly };
			}
		} else if (g.kind === "file") {
			const local = g.local ?? "";
			try {
				const real = realpathSync(local);
				// Legacy stores may contain symlinks; never follow a later retarget into credentials.
				if (real !== local && deny.some((d) => isWithin(real, d.dir)) && !deny.some((d) => isWithin(local, d.dir))) {
					warn(`grant file:${local}: now leads through a symlink to ${real}, where keys or boxery's own state live; skipped`); continue;
				}
				values.push(`put_file ${q((g.remote ?? "").replace(/^\/home\/agent\//, ""))} ${q(readFileSync(real).toString("base64"))}`);
			} catch { warn(`grant file:${local}: not readable; skipped`); }
		} else if (g.kind === "llm") llm.push(g.provider);
	}
	const marker = path.join(storeDir(), `.${vm}.edge`);
	if (grants.some((g) => g.kind === "http" || g.kind === "llm") || existsSync(marker)) {
		const leases = path.join(currentHost().dir, "leases");
		// Lease records are locally owned data; bind edge writes to the current lease.
		const { readdirSync } = await import("node:fs");
		const record = existsSync(leases) ? readdirSync(leases).filter((f) => f.endsWith(".lease")).map((f) => read(path.join(leases, f))).find((s) => s.split("\n").includes(`name=${vm}`)) : undefined;
		const id = record?.match(/^id=(.+)$/m)?.[1];
		const routes = llm.length ? { hosts, llm } : hosts;
		try {
			await profileRun("host", ["edge-set", vm, ...(id ? ["--lease", id] : [])], { ...opts, input: JSON.stringify(routes) });
			if (grants.some((g) => g.kind === "http" || g.kind === "llm")) writeFileSync(marker, "", { mode: 0o600 }); else remove(marker);
		} catch { warn(`could not set edge routes for ${vm} on the host`); }
	}
	// Include HTTP URL setup even if a credential command failed, as the previous reconciler did.
	for (const g of grants) if (g.kind === "http") values.push(`put_edge ${q(g.host ?? "")}`);
	const script = guestTemplate.replace("# BOXERY_GRANT_VALUES", () => values.join("\n"));
	const output = await new Promise((resolve, reject) => {
		const child = execFile("ssh", ["-F", currentHost().sshConf, `${assertName(vm)}.boxery`, "bash -s"], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024, signal: opts.signal }, (e, stdout, stderr) => e ? reject(new Error(`could not apply grants to ${vm}: ${stderr || e.message}`)) : resolve(`${stdout}${stderr}`.trim()));
		child.stdin?.on("error", () => {}); child.stdin?.end(script);
	});
	return [...warnings, `==> ${output}`].join("\n");
}
/** Complete a committed change even if the requesting tool is cancelled after the store write.
 * Cancellation before commit still aborts without mutation. Report any post-commit failure as saved,
 * not as a failed/no-op request. @param {string} vm @param {GrantOptions} [opts]
 */
export async function grantsChanged(vm, opts = {}) {
	const finish = { ...opts, signal: undefined };
	let stage = "refreshing SSH configuration";
	try {
		await profileRun("config", [], finish);
		stage = "closing existing SSH connections";
		await profileRun("close", [vm], finish);
		stage = "applying grants";
		return await applyGrants(vm, finish);
	} catch (e) {
		return `boxery: grants for ${vm} are saved, but the change is not fully applied (${stage}: ${/** @type {Error} */ (e).message}). Fix the error and retry the grant/revoke command.`;
	}
}
/** Used by fork: resolve and validate every source grant before confirmation and creation.
 * @param {string} vm @returns {GrantSpec[]}
 */
export function storedSpecs(vm) {
	return listGrants(vm).map((g) => parseGrantSpec({ ...g, cmd: g.cmd ?? undefined, spec: g.kind === "file" ? `file:${g.local}=${g.remote}` : g.kind === "env" ? `env:${g.var}` : g.kind === "http" ? `http:${g.host}` : g.kind === "llm" ? `llm:${g.provider}` : g.kind }, { cli: true }));
}
