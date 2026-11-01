#!/usr/bin/env node
// Runtime adapter for lease-workflows.mjs. Owns CLI parsing, SQLite/journal bindings and the
// private shell-backend bridge. Hypervisor commands still live in host/backends/*.sh.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import * as leases from "./boxery-leases.mjs";
import { recordIntent, completeIntent } from "./boxery-operations.mjs";
import { LeaseWorkflows } from "./lease-workflows.mjs";

const SELF = fileURLToPath(import.meta.url);
const HOST = fileURLToPath(new URL("./boxery-host", import.meta.url));
const OPERATIONS = fileURLToPath(new URL("./boxery-operations.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const nameOf = (name) => {
	if (!leases.VALID_NAME.test(name ?? "")) throw new Error(`invalid name '${name ?? ""}' (use [a-z][a-z0-9-]*)`);
	return name;
};
const leaseOf = (id) => {
	if (!/^l-[0-9a-f]{32}$/.test(id ?? "")) throw new Error("invalid lease id");
	return id;
};

export function parseOptions(args, defaults, flags) {
	const result = { ...defaults };
	for (let i = 0; i < args.length; i++) {
		if (!Object.hasOwn(flags, args[i])) throw new Error(`unknown flag ${args[i]}`);
		const key = flags[args[i]];
		const value = args[++i];
		if (value == null) throw new Error(`${args[i - 1]} needs a value`);
		if (key !== "holder" && !/^\d+$/.test(value)) throw new Error(`${args[i - 1]} must be a number`);
		result[key] = key === "holder" ? value : Number(value);
	}
	return result;
}

// Keep every subprocess in the supervisor's worker group (never detached). stdout is metadata;
// diagnostics stay on stderr, and failed calls retain their exit status for the CLI.
function run(file, args, { quiet = false, env = process.env } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args.map(String), { env, stdio: ["inherit", "pipe", quiet ? "ignore" : "inherit"] });
		const chunks = []; let bytes = 0;
		child.stdout.on("data", (d) => {
			bytes += d.length;
			if (bytes > 16 * 1024 * 1024) child.kill();
			else chunks.push(d);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (bytes > 16 * 1024 * 1024) return reject(new Error("backend metadata exceeded 16 MiB"));
			if (code !== 0) return reject(Object.assign(new Error(`${args[1] ?? file} failed`), { exitCode: code ?? 1 }));
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
	});
}
function publicKey() {
	return new Promise((resolve, reject) => {
		const input = createInterface({ input: process.stdin, terminal: false });
		input.once("error", reject);
		input.once("line", (line) => {
			resolve(line); input.close();
			// readline.close() leaves the underlying pipe open. We consumed the only input
			// this command needs; a client retaining its write end must not keep Node alive.
			process.stdin.pause();
			process.stdin.unref?.();
		});
		input.once("close", () => resolve(""));
	});
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	const conf = path.resolve(process.env.BOXERY_CONF ?? path.join(homedir(), ".config/boxery"));
	const db = leases.open(path.join(conf, "leases.db"));
	const operationId = process.env.BOXERY_OPERATION_ID;
	const bridge = (action, argv = [], options) => run(HOST, ["__backend", action, ...argv], options);
	const requireLock = (name) => {
		nameOf(name);
		if (!process.env.BOXERY_LOCKS?.includes(`:${name}:`)) throw new Error(`lifecycle lock required for ${name}`);
	};
	const lock = (name, callback, argv) => run(process.execPath, ["--disable-warning=ExperimentalWarning", OPERATIONS, "run", conf, nameOf(name), HOST, callback, ...argv]);
	const store = Object.fromEntries(["get", "find", "claim", "commit", "beginReset", "finish", "candidates", "due", "renew"]
		.map((method) => [method, (...argv) => leases[method](db, ...argv)]));
	const log = (message) => process.stderr.write(`==> ${message}\n`);
	const backend = {
		clearEdge: async (name) => rmSync(path.join(conf, "edge", `${nameOf(name)}.json`), { force: true }),
		restore: (name, label) => bridge("restore", [name, label], { quiet: true }),
		waitReady: (name) => bridge("wait-ready", [name], {
			quiet: true, env: { ...process.env, BOXERY_SSH_WAIT_TRIES: process.env.BOXERY_SSH_WAIT_TRIES ?? "45" },
		}),
		stepClock: (name) => bridge("guest", [name, `sudo date -u -s @${now()} >/dev/null 2>&1; true`]),
		setKeys: (name, pubkey) => bridge("lease-keys", [name, ...(pubkey ? [pubkey] : [])]),
	};
	const journal = {
		intent: (kind, data) => recordIntent(db, operationId, kind, data),
		done: (id) => completeIntent(db, operationId, id),
	};
	let flows;
	const reclaim = async () => {
		await run(process.execPath, ["--disable-warning=ExperimentalWarning", OPERATIONS, "reconcile", conf, HOST]);
		await flows.reapCandidates();
		await bridge("drift");
	};
	flows = new LeaseWorkflows({ store, backend, journal, lock, reclaim, now, sleep, log });
	try {
		switch (command) {
			case "acquire": {
				const options = parseOptions(args, { holder: "", ttl: 1800, wait: 0 }, { "--holder": "holder", "--ttl": "ttl", "--wait": "wait" });
				const claim = await flows.acquire({ ...options, pubkey: await publicKey() });
				process.stdout.write(`${claim.name} ${claim.lease_id} ${claim.expires_at}\n`);
				break;
			}
			case "renew": {
				const id = leaseOf(args[0]);
				const { ttl } = parseOptions(args.slice(1), { ttl: 1800 }, { "--ttl": "ttl" });
				const row = store.renew(id, ttl);
				process.stdout.write(`${row.name} ${row.expires_at}\n`);
				break;
			}
			case "release": await flows.release(leaseOf(args[0])); break;
			case "reap": case "reconcile": await reclaim(); break;
			case "reset": // compatibility for the existing recovery dispatcher / private entry point
				await lock(nameOf(args[0]), "_lease_reset", args); break;
			case "install-held":
				requireLock(args[0]); await flows.install(...args); break;
			case "release-held": {
				const row = store.find(leaseOf(args[0]));
				if (!row) throw Object.assign(new Error("unknown or inactive lease"), { exitCode: 2 });
				requireLock(row.name); await flows.releaseHeld(args[0]); break;
			}
			case "reset-held":
				requireLock(args[0]); await flows.reset(...args); break;
			case "reap-held":
				requireLock(args[0]); await flows.reapHeld(...args); break;
			default: throw new Error(`unknown lifecycle command: ${command}`);
		}
	} finally { db.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
	main().catch((e) => { console.error(`boxery-host: ${e.message}`); process.exitCode = e.exitCode ?? 1; });
}
