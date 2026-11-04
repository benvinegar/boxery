// boxery acquire | renew | release | leases: the CLI front-end of core/leases.mjs, which the MCP server
// and the pi extension call in-process. Output, --json and exit codes are those of the Bash commands this
// replaced (docs/cli.md). controller/boxery has already checked that the profile has a host.
// Run by controller/boxery as: node leases.mjs HOST PROFILE_DIR COMMAND ARG…, with the profile it selected.
import { execFileSync } from "node:child_process";
import { constants } from "node:os";
import * as core from "../core/boxery-core.mjs";
import { acquireLease, leaseRows, localLeases, releaseLease, renewLease } from "../core/leases.mjs";

const [host, dir, command, ...args] = process.argv.slice(2);
const log = (/** @type {string} */ s) => console.error(s);
const abort = new AbortController();
/** @type {import("../core/leases.mjs").LeaseOpts} */
const cli = { log, interactiveCommands: true, stderr: "inherit", timeout: 0, signal: abort.signal };
// Ctrl-C while acquire (or renew) waits on the host: stop that call and remove the half-made key before
// exiting. release and leases keep the default: they just stop.
if (command === "acquire" || command === "renew") for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
	process.once(sig, () => { process.exitCode = 128 + constants.signals[sig]; abort.abort(); });
}
/** Like `date`: the local format people read elsewhere in the CLI. @param {number} t unix seconds */
function localDate(t) {
	for (const args of [["-d", `@${t}`], ["-r", String(t)]]) {
		try { return execFileSync("date", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
	}
	return new Date(t * 1000).toString();
}

/** @param {string[]} a @param {Record<string, string>} flags flag → key @returns {Record<string, string>} */
function parse(a, flags) {
	/** @type {Record<string, string>} */
	const out = {};
	for (let i = 0; i < a.length; i += 2) {
		const key = flags[a[i]];
		if (!key) throw new Error(`unknown flag ${a[i]}`);
		out[key] = a[i + 1] ?? "";
	}
	return out;
}

async function run() {
	switch (command) {
		case "acquire": {
			const o = parse(args, { "--ttl": "ttl", "--wait": "wait", "--holder": "holder" });
			for (const f of ["ttl", "wait"]) if (f in o && !/^[0-9]+$/.test(o[f])) throw new Error(`--${f} must be a number`);
			const r = await acquireLease({ ttl: o.ttl ?? 1800, wait: o.wait ?? 0, ...(o.holder !== undefined ? { holder: o.holder } : {}) }, cli);
			log(`==> leased ${r.name} (lease ${r.id}, expires in ${r.expires - Math.floor(Date.now() / 1000)}s; renew with: boxery renew ${r.name})`);
			console.log(`${r.name} ${r.id}`);
			return;
		}
		case "renew": {
			const [ref, ...rest] = args;
			const ttl = rest[0] === "--ttl" ? rest[1] ?? null : null; // like before: anything else is ignored
			let r;
			try { r = await renewLease(ref ?? "", ttl, cli); }
			catch (e) {
				if (!(/** @type {{ fromHost?: boolean }} */ (e).fromHost)) throw e; // local problems: say what they are
				throw new Error("renew failed (lease expired or released?)");
			}
			console.log(`==> renewed ${r.name} until ${localDate(r.expires)}`);
			return;
		}
		case "release": {
			const r = await releaseLease(args[0] ?? "", cli);
			console.log(`==> released ${r.name}`);
			return;
		}
		case "leases": {
			const json = args[0] === "--json";
			if (args.length > 1 || (args.length === 1 && !json)) throw new Error("usage: boxery leases [--json]");
			if (json) {
				const rows = leaseRows().map((r) => JSON.stringify(r));
				console.log(rows.length ? `[\n${rows.join(",\n")}\n]` : "[]");
				return;
			}
			const now = Math.floor(Date.now() / 1000), all = localLeases();
			if (!all.length) return console.log("(no leases)");
			for (const r of all) console.log(`${r.name.padEnd(16)} ${(r.expires > now ? `${r.expires - now}s` : "expired").padEnd(10)} ${r.id}`);
			return;
		}
		default: throw new Error(`unknown lease command: ${command}`);
	}
}

try {
	await core.withHost(core.profileFromDirectory(host, dir), run);
} catch (e) {
	const err = /** @type {Error & { exitCode?: number, reported?: boolean }} */ (e);
	if (abort.signal.aborted) { /* interrupted: exit code set by the signal handler */ }
	// The host already explained a failed acquire on stderr; pass its exit status through, like before.
	else if (err.reported) process.exitCode = err.exitCode ?? 1;
	else { console.error(`boxery: ${err.message}`); process.exitCode = 1; }
}
