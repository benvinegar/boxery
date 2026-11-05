// boxery acquire | renew | release | leases: the CLI front-end of core/leases.mjs, which the MCP server
// and the pi extension call in-process. Output, --json and exit codes: docs/cli.md.
import { execFileSync } from "node:child_process";
import { constants } from "node:os";
import { acquireLease, leaseRows, localLeases, releaseLease, renewLease } from "../core/leases.mjs";
import { CliError, die, note, quit, say } from "./lib.mjs";
/** @import { Selected } from "./lib.mjs" */

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
		if (!key) die(`unknown flag ${a[i]}`);
		out[key] = a[i + 1] ?? "";
	}
	return out;
}

/** A lease operation's failure, as the CLI reports it. @param {unknown} e @returns {never} */
function failed(e) {
	const err = /** @type {Error & { exitCode?: number, reported?: boolean }} */ (e);
	if (err instanceof CliError) throw err;
	// The host already explained a failed acquire on stderr; pass its exit status through.
	if (err.reported) quit(err.exitCode ?? 1);
	return die(err.message);
}

/** @param {Selected} _s @param {"acquire" | "renew" | "release" | "leases"} command @param {string[]} args */
export async function leaseCommand(_s, command, args) {
	const abort = new AbortController();
	/** @type {import("../core/leases.mjs").LeaseOpts} */
	const cli = { log: note, interactiveCommands: true, stderr: "inherit", timeout: 0, signal: abort.signal };
	switch (command) {
		case "acquire": {
			const o = parse(args, { "--ttl": "ttl", "--wait": "wait", "--holder": "holder" });
			for (const f of ["ttl", "wait"]) if (f in o && !/^[0-9]+$/.test(o[f])) die(`--${f} must be a number`);
			// Ctrl-C while the host waits: stop that call and remove the half-made key before exiting. Once the
			// host has granted the lease it is held and recorded, so acquire reports it and exits 0.
			let interrupted = 0;
			const signals = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);
			const handlers = signals.map((sig) => /** @type {[NodeJS.Signals, () => void]} */ ([sig, () => { interrupted = 128 + constants.signals[sig]; abort.abort(); }]));
			for (const [sig, h] of handlers) process.once(sig, h);
			let r;
			try { r = await acquireLease({ ttl: o.ttl ?? 1800, wait: o.wait ?? 0, ...(o.holder !== undefined ? { holder: o.holder } : {}) }, cli); }
			catch (e) { if (interrupted && /** @type {Error} */ (e).name === "AbortError") quit(interrupted); failed(e); }
			finally { for (const [sig, h] of handlers) process.off(sig, h); }
			note(`==> leased ${r.name} (lease ${r.id}, expires in ${r.expires - Math.floor(Date.now() / 1000)}s; renew with: boxery renew ${r.name})`);
			return say(`${r.name} ${r.id}`);
		}
		case "renew": {
			const [ref, ...rest] = args;
			const ttl = rest[0] === "--ttl" ? rest[1] ?? null : null; // anything else is ignored
			let r;
			try { r = await renewLease(ref ?? "", ttl, cli); }
			catch (e) {
				if (!(/** @type {{ fromHost?: boolean }} */ (e).fromHost)) failed(e); // local problems: say what they are
				die("renew failed (lease expired or released?)");
			}
			return say(`==> renewed ${r.name} until ${localDate(r.expires)}`);
		}
		case "release": {
			let r;
			try { r = await releaseLease(args[0] ?? "", cli); } catch (e) { failed(e); }
			return say(`==> released ${r.name}`);
		}
		case "leases": {
			const json = args[0] === "--json";
			if (args.length > 1 || (args.length === 1 && !json)) die("usage: boxery leases [--json]");
			if (json) {
				const rows = leaseRows().map((r) => JSON.stringify(r));
				return say(rows.length ? `[\n${rows.join(",\n")}\n]` : "[]");
			}
			const now = Math.floor(Date.now() / 1000), all = localLeases();
			if (!all.length) return say("(no leases)");
			for (const r of all) say(`${r.name.padEnd(16)} ${(r.expires > now ? `${r.expires - now}s` : "expired").padEnd(10)} ${r.id}`);
		}
	}
}
