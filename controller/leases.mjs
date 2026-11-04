// boxery acquire | renew | release | leases: the CLI front-end of core/leases.mjs, which the MCP server
// and the pi extension call in-process. Output and --json are unchanged from the Bash commands (docs/cli.md).
// Run by controller/boxery as: node leases.mjs HOST PROFILE_DIR COMMAND ARG…, with the profile it selected.
import * as core from "../core/boxery-core.mjs";
import { acquireLease, leaseRows, localLeases, releaseLease, renewLease } from "../core/leases.mjs";
import { profileRun } from "../core/profile.mjs";

const [host, dir, command, ...args] = process.argv.slice(2);
const log = (/** @type {string} */ s) => console.error(s);
/** @type {import("../core/leases.mjs").LeaseOpts} */
const cli = { log, interactiveCommands: true, stderr: "inherit", timeout: 0 };
class Usage extends Error {}

/** @param {string[]} a @param {Record<string, string>} flags flag → key @returns {Record<string, string>} */
function parse(a, flags) {
	/** @type {Record<string, string>} */
	const out = {};
	for (let i = 0; i < a.length; i += 2) {
		const key = flags[a[i]];
		if (!key) throw new Usage(`unknown flag ${a[i]}`);
		out[key] = a[i + 1] ?? "";
	}
	return out;
}

async function run() {
	if (command !== "leases") await profileRun("need", [], { stderr: "inherit" }).catch(() => { throw Object.assign(new Error(""), { exitCode: 1, reported: true }); });
	switch (command) {
		case "acquire": {
			const o = parse(args, { "--ttl": "ttl", "--wait": "wait", "--holder": "holder" });
			for (const f of ["ttl", "wait"]) if (f in o && !/^[0-9]+$/.test(o[f])) throw new Usage(`--${f} must be a number`);
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
				const m = /** @type {Error} */ (e).message;
				if (/^(no local lease|--ttl)/.test(m)) throw e;
				throw new Error("renew failed (lease expired or released?)");
			}
			console.log(`==> renewed ${r.name} until ${new Date(r.expires * 1000).toString()}`);
			return;
		}
		case "release": {
			const r = await releaseLease(args[0] ?? "", cli);
			console.log(`==> released ${r.name}`);
			return;
		}
		case "leases": {
			const json = args[0] === "--json";
			if (args.length > 1 || (args.length === 1 && !json)) throw new Usage("usage: boxery leases [--json]");
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
		default: throw new Usage(`unknown lease command: ${command}`);
	}
}

try {
	await core.withHost(core.profileFromDirectory(host, dir), run);
} catch (e) {
	const err = /** @type {Error & { exitCode?: number, reported?: boolean }} */ (e);
	// The host already explained a failed acquire on stderr; pass its exit status through, like before.
	if (err.reported) process.exitCode = err.exitCode ?? 1;
	else if (command === "acquire" && err.exitCode && !(err instanceof Usage)) process.exitCode = err.exitCode;
	else { console.error(`boxery: ${err.message}`); process.exitCode = 1; }
}
