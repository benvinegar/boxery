// boxery run --bg | jobs | logs | wait | kill. The logic runs in the VM: core/boxery-jobs.ts is piped over
// ssh on every call and run by the VM's Node (type stripping), so a VM never runs an old copy. See that file
// for the protocol and layout. The remote command is fixed except for args, which are validated (ids,
// numbers) or base64.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeMaster } from "../core/profile.mjs";
import { CliError, die, duration, needVm, note, num, quit, rawBytes, say, vmSsh, vmSshCapture, warn } from "./lib.mjs";
/** @import { Selected } from "./lib.mjs" */

// Probe for type stripping instead of matching versions (it arrived in 22.18 and 23.6, not 23.0).
const JOBS_NODE = `T="--experimental-strip-types --disable-warning=ExperimentalWarning --input-type=module-typescript"
node $T -e "" >/dev/null 2>&1 || { echo "boxery jobs: need Node >= 22.18 in the VM (found: $(node -v 2>/dev/null || echo none))" >&2; exit 1; }
BOXERY_CALLER=$PPID exec node $T -`;

/** core/boxery-jobs.ts next to this controller (BOXERY_JOBS_TS overrides). */
function jobsTs() {
	const f = process.env.BOXERY_JOBS_TS || fileURLToPath(new URL("../core/boxery-jobs.ts", import.meta.url));
	if (!existsSync(f)) die(`jobs need core/boxery-jobs.ts next to the controller (${f}); run boxery from its checkout or package`);
	return f;
}
function jobsRunner() {
	const r = path.join(path.dirname(jobsTs()), "boxery-job-runner.sh");
	if (!existsSync(r)) die(`missing ${r}`);
	return r;
}

/** ssh arguments for the helper in VM NAME: ACTION ARGS. own: a connection of its own (a long-lived call: if
 *  this client dies, the VM side sees it at once). @param {string} name @param {string[]} args @param {boolean} [own] */
const helper = (name, args, own = false) => ["-T", ...(own ? ["-o", "ControlMaster=no", "-o", "ControlPath=none"] : []), `${needVm(name)}.boxery`, `${JOBS_NODE} ${args.join(" ")}`];
/** The helper, sharing this terminal: its exit status. @param {Selected} s @param {string} name @param {string[]} args @param {{ own?: boolean }} [o] */
const jobsVm = (s, name, args, { own = false } = {}) => vmSsh(s, helper(name, args, own), { input: readFileSync(jobsTs()) });
/** The helper, its output captured. @param {Selected} s @param {string} name @param {string[]} args */
const jobsVmCapture = (s, name, args) => vmSshCapture(s, helper(name, args), readFileSync(jobsTs()));
/** @param {number} rc */
const exit = (rc) => { if (rc) throw new CliError("", rc); };

const VALID_JOB = /^job-[a-z0-9-]+$/;
/** @param {string | undefined} id */
const needJob = (id) => (VALID_JOB.test(id ?? "") && /** @type {string} */ (id).length <= 40 ? /** @type {string} */ (id) : die(`invalid job id: ${id ?? ""} (see: boxery jobs NAME)`));

/** run --bg: start ARGV in the VM as a job; its id. @param {Selected} s @param {string} name @param {string[]} argv @param {string} cwd */
export async function startJob(s, name, argv, cwd) {
	// argv as NUL-terminated words, base64: survives ssh's re-parsing with no quoting at all.
	const words = Buffer.concat(argv.flatMap((a) => [rawBytes(a), Buffer.from([0])]));
	const cwdb = cwd ? rawBytes(cwd).toString("base64") : "-";
	const runner = readFileSync(jobsRunner()).toString("base64");
	const r = await jobsVmCapture(s, name, ["start", words.toString("base64"), cwdb, runner, "--text"]);
	if (r.code !== 0) quit(r.code);
	return r.stdout.trim();
}

/** jobs NAME [--json] | NAME --prune [--older-than DURATION] [--json] @param {Selected} s @param {string[]} args */
export async function jobs(s, [vm, ...rest]) {
	const name = needVm(vm);
	let json = false, prune = false, older = 0;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--json") json = true;
		else if (rest[i] === "--prune") prune = true;
		else if (rest[i] === "--older-than") older = duration("--older-than", rest[++i]);
		else die("usage: boxery jobs NAME [--json] | jobs NAME --prune [--older-than 7d] [--json]");
	}
	if (prune) return exit(await jobsVm(s, name, ["prune", "--older-than", String(older), ...(json ? [] : ["--text"])]));
	if (older) die("--older-than goes with --prune");
	exit(await jobsVm(s, name, ["list", ...(json ? [] : ["--text"])]));
}

/** logs NAME JOB [-f] [--lines N] [--bytes N] [--strip-ansi] @param {Selected} s @param {string[]} args */
export async function logs(s, [vm, job, ...rest]) {
	const name = needVm(vm), id = needJob(job);
	/** @type {string[]} */
	const a = [];
	let own = false, lines = false;
	for (let i = 0; i < rest.length; i++) {
		const f = rest[i];
		if (f === "-f" || f === "--follow") { a.push("--follow"); own = true; }
		else if (["-n", "--lines", "--tail"].includes(f)) { a.push("--lines", String(num("--lines", rest[++i]))); lines = true; }
		else if (f === "--bytes") a.push("--bytes", String(num("--bytes", rest[++i], 1)));
		else if (f === "--strip-ansi") a.push("--strip-ansi");
		else die("usage: boxery logs NAME JOB [-f] [--lines N] [--bytes N] [--strip-ansi]");
	}
	if (!lines) a.push("--lines", "200");
	exit(await jobsVm(s, name, ["logs", id, ...a], { own }));
}

/**
 * wait NAME JOB [--timeout S] [--json]: exits with the job's exit code, 124 if --timeout passed, 125 if the
 * job is lost. Those (and the helper's own errors: 1 no node, 2 usage, 3 unknown job) can't be told apart from
 * a job that exits with the same code; --json prints the job (state, exit_code, timed_out) whenever the VM answered.
 * @param {Selected} s @param {string[]} args
 */
export async function waitJob(s, [vm, job, ...rest]) {
	const name = needVm(vm), id = needJob(job);
	let deadline = null, json = false, drops = 0, reached = false;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--timeout") deadline = Math.floor(Date.now() / 1000) + num("--timeout", rest[++i]);
		else if (rest[i] === "--json") json = true;
		else die("usage: boxery wait NAME JOB [--timeout S] [--json]");
	}
	for (;;) {
		const limit = deadline == null ? -1 : Math.max(0, deadline - Math.floor(Date.now() / 1000));
		// --exit0: the helper exits 0 whenever it answers, so ssh's own 255 can't be confused with a job's.
		const r = await jobsVmCapture(s, name, ["wait", id, "--timeout", String(limit), "--exit0"]);
		if (r.stdout) reached = true;
		const out = r.stdout.split("\n").filter((l) => l !== "").join("\n"); // newlines sent while waiting (heartbeat)
		if (r.code !== 0 || !out) {
			if (r.code !== 255) quit(r.code);
			// Unreachable from the start: say so now (the job may not exist). A connection that drops while
			// waiting doesn't affect the job (tmux in the VM): reconnect and keep waiting, within --timeout.
			if (!reached) die(`cannot reach ${name}`);
			if (deadline != null && Date.now() / 1000 >= deadline) { warn(`cannot reach ${name}; --timeout passed (the job may still be running)`); quit(124); }
			if (++drops > 60) die(`cannot reach ${name}; giving up (the job may still be running: boxery jobs ${name})`);
			warn(`lost the connection to ${name}; reconnecting (the job keeps running)`);
			await closeMaster(name);
			await new Promise((res) => setTimeout(res, 5000));
			continue;
		}
		if (json) say(out);
		/** @type {{ state?: string, exit_code?: number }} */
		let rec = {};
		try { rec = JSON.parse(out.split("\n")[0]); } catch { die(`unexpected reply from ${name}: ${out}`); }
		if (rec.state === "exited") { if (!json) note(`boxery: ${id} exited ${rec.exit_code}`); quit(Number(rec.exit_code) || 0); }
		if (rec.state === "running") { if (!json) warn(`${id} is still running`); quit(124); }
		if (rec.state === "lost") { if (!json) warn(`${id} was lost: it stopped without recording an exit code (the VM restarted, or it was killed outside boxery)`); quit(125); }
		die(`unexpected reply from ${name}: ${out}`);
	}
}

/** kill NAME JOB [--grace S] [--json] @param {Selected} s @param {string[]} args */
export async function kill(s, [vm, job, ...rest]) {
	const name = needVm(vm), id = needJob(job);
	let text = true;
	/** @type {string[]} */
	const a = [];
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--grace") a.push("--grace", String(num("--grace", rest[++i])));
		else if (rest[i] === "--json") text = false;
		else die("usage: boxery kill NAME JOB [--grace S] [--json]");
	}
	exit(await jobsVm(s, name, ["kill", id, ...(text ? ["--text"] : []), ...a]));
}
