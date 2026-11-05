// boxery runners once: one GitHub Actions runner on a pool VM for one job, registered with this machine's gh
// login (docs/github-runners.md). The host leases the VM and runs the runner (boxery-host runners __once)
// but never gets a GitHub credential: only the runner's single-use JIT config, on its stdin (never argv or a
// file). Its stdin: that config, then a heartbeat every few seconds; closing it (Ctrl-C, or this process
// dying) makes the host stop the runner and release the VM, which resets it. Its stdout: `register VM NAME
// LABELS`, `started`, then the outcome (exited | stopped | lost | failed); EOF once the host is done.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { hostCommand } from "../core/profile.mjs";
import { CliError, VALID_VM, capture, die, note, warn } from "./lib.mjs";
/** @import { Selected } from "./lib.mjs" */

const USAGE = "usage: boxery runners once [--repo OWNER/REPO | --org ORG] [--vms NAME,...] [--labels L,...] [--group ID]";

/** gh ARGS, its stdout (stderr captured for errors). @param {string[]} args @param {string} [input] */
function gh(args, input) {
	return new Promise((resolve) => {
		const child = spawn("gh", args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		let out = "", err = "";
		child.stdout?.on("data", (d) => (out += d));
		child.stderr?.on("data", (d) => (err += d));
		child.on("error", (e) => resolve({ code: 127, out: "", err: e.message }));
		child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
		if (input !== undefined && child.stdin) { child.stdin.on("error", () => {}); child.stdin.end(input); }
	});
}
/** The first lines of gh's error, printable. @param {string} err */
const ghError = (err) => err.replace(/[\x00-\x08\x0b-\x1f]/g, "").split("\n").slice(0, 3).join(" ").slice(0, 300);

/** @param {Selected} s @param {string[]} args */
export async function runnersOnce(s, args) {
	let repo = "", org = "", vms = "", labels = "", group = "";
	for (let i = 0; i < args.length; i += 2) {
		const f = args[i], v = args[i + 1];
		if (["-h", "--help"].includes(f)) { process.stdout.write(`${USAGE}\n`); return; }
		if (!["--repo", "--org", "--vms", "--labels", "--group"].includes(f)) die(`unknown argument: ${f}\n${USAGE}`);
		if (!v) die(`${f} needs a value\n${USAGE}`);
		if (f === "--repo") repo = v; else if (f === "--org") org = v; else if (f === "--vms") vms = v; else if (f === "--labels") labels = v; else group = v;
	}
	if (repo && org) die("pass one of --repo OWNER/REPO or --org ORG");
	if (/[^A-Za-z0-9-]/.test(org)) die(`invalid organization: ${org}`);
	if (!group) group = "1";
	else if (!/^[1-9][0-9]*$/.test(group)) die("--group must be a runner group id (1 = Default)");
	else if (!org) die("--group is for --org (a repository's runners are in its Default group)");
	if (/[^A-Za-z0-9._,-]/.test(labels)) die(`invalid --labels: ${labels} (L,... with [A-Za-z0-9._-])`);
	for (const v of vms.split(",").filter(Boolean)) if (!VALID_VM.test(v)) die(`invalid VM name: ${v}`);
	if ((await capture("sh", ["-c", "command -v gh"])).code !== 0) die("local runners use the GitHub CLI: install gh (https://cli.github.com), then run: gh auth login");
	const ghHost = process.env.GH_HOST || "github.com";
	if ((await gh(["auth", "status", "--hostname", ghHost])).code !== 0) die(`gh is not logged in to ${ghHost}: run gh auth login (local runners use your gh login)`);
	if (!repo && !org) {
		const r = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
		repo = r.out.trim();
		if (r.code !== 0 || !repo) die("no GitHub repository here: run this in a clone of one, or pass --repo OWNER/REPO (or --org ORG)");
	}
	if (repo && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) die(`invalid repository: ${repo} (OWNER/REPO)`);
	const api = repo ? `repos/${repo}/actions/runners` : `orgs/${org}/actions/runners`;
	const scope = repo || `organization ${org}`;
	// Seconds between asking GitHub whether the runner has a job.
	const pollEnv = process.env.BOXERY_RUNNERS_BUSY_POLL ?? "";
	const poll = /^[1-9][0-9]*$/.test(pollEnv) ? Number(pollEnv) : 10;

	note(`==> local runner for ${scope}, with your gh login (nothing is stored on the host)`);
	const [cmd, argv] = hostCommand(s.host, s.config, ["runners", "__once", ...(vms ? ["--vms", vms] : []), ...(labels ? ["--labels", labels] : [])]);
	const host = spawn(cmd, argv, { stdio: ["pipe", "pipe", "inherit"], env: s.config.env });
	host.stdin.on("error", () => {});
	let open = true, stop = 0, id = "", name = "", vm = "", failed = "", outcome = "", busy = false, started = false, abandon = false;
	const lines = createInterface({ input: host.stdout });
	host.on("error", (e) => { warn(`cannot run ${cmd}: ${e.message}`); failed = "host"; lines.close(); });
	const closeHost = () => { if (open) { open = false; host.stdin.end(); } };
	const send = (/** @type {string} */ text) => { if (open) host.stdin.write(text); };

	// Delete the registration on every way out (gone already after a job: a JIT runner deregisters itself).
	const deleteRegistration = async () => {
		if (!id) return { gone: false };
		const r = await gh(["api", "-X", "DELETE", `${api}/${id}`]);
		const regName = name; id = "";
		if (r.code === 0) { if (outcome !== "exited") note(`==> deleted runner registration ${regName}`); return { gone: false }; }
		if (/HTTP 404/.test(r.err)) return { gone: true };
		warn(`could not delete runner ${regName} (${ghError(r.err)}); GitHub removes offline runners by itself`);
		return { gone: false };
	};
	const onSignal = () => {
		stop++;
		if (stop === 1) { closeHost(); note(`==> stopping the runner${vm ? ` and giving ${vm} back` : ""}`); }
		else { abandon = true; lines.close(); } // a second Ctrl-C: don't wait for the host (it cleans up anyway)
	};
	const signals = /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"]);
	for (const sig of signals) process.on(sig, onSignal);
	const heartbeat = setInterval(() => send("\n"), 5000);
	const busyPoll = setInterval(async () => {
		// Is it on a job yet? Until it is (the host can't ask: it has no GitHub credential).
		if (!started || busy || stop || !id) return;
		const r = await gh(["api", `${api}/${id}`, "--jq", ".busy"]);
		if (r.out.trim() === "true" && !busy) { busy = true; note(`==> ${name} is running a job`); }
	}, poll * 1000);

	/** register VM NAME LABELS: register the runner with gh and send "ID JITCONFIG" to the host. Without one,
	 *  close the host's stdin: it gives the VM back. @param {string} rest */
	const register = async (rest) => {
		const [v = "", n = "", l = ""] = rest.split(" ");
		if (!VALID_VM.test(v) || !n.startsWith("boxery-local-") || /[^A-Za-z0-9._,-]/.test(n + l) || !l) {
			warn(`unexpected answer from the host: register ${rest}`); failed = "host"; closeHost(); return;
		}
		vm = v;
		if (!open) return; // stopping already
		note(`==> ${v}: registering runner ${n} (labels ${l})`);
		const body = JSON.stringify({ name: n, runner_group_id: Number(group), labels: l.split(","), work_folder: "_work" });
		const r = await gh(["api", "-X", "POST", `${api}/generate-jitconfig`, "--input", "-", "--jq", '"\\(.runner.id) \\(.encoded_jit_config)"'], body);
		const [rid = "", jit = ""] = r.code === 0 ? r.out.trim().split(" ") : [];
		if (!/^[0-9]+$/.test(rid) || !/^[A-Za-z0-9+/=]+$/.test(jit)) {
			if (!stop) {
				warn(`GitHub didn't register the runner: ${ghError(r.err)}`);
				warn(`registering a runner needs admin rights on ${api.replace(/\/actions\/runners$/, "")}; for an organization's: gh auth refresh -s admin:org`);
			}
			failed = "register"; closeHost(); return;
		}
		id = rid; name = n; // registered: from here on, every way out deletes it
		send(`${rid} ${jit}\n`);
	};

	let rc = 1;
	try {
		/** @type {Promise<void>[]} */
		const pending = [];
		for await (const line of lines) {
			if (line.startsWith("register ")) pending.push(register(line.slice(9)));
			else if (line === "started") { started = true; note("==> ready: a job with runs-on: [self-hosted, boxery] gets it (Ctrl-C to stop)"); }
			else if (["exited", "stopped", "lost", "failed"].includes(line)) outcome = line;
		}
		await Promise.all(pending);
		if (!abandon && !failed) await new Promise((resolve) => { if (host.exitCode !== null || host.signalCode !== null) resolve(undefined); else host.once("close", resolve); });
		const { gone } = await deleteRegistration();
		if (stop) { note("==> stopped"); rc = 130; }
		else if (outcome === "exited" && (gone || busy)) { note(`==> done: ${name} ran its job; ${vm} is reset`); rc = 0; }
		else if (outcome === "exited") warn(`${name} exited without running a job (its registration is deleted)`);
		else if (!failed) warn(`the local runner ended early${outcome ? ` (${outcome})` : ""}; see above`);
	} finally {
		clearInterval(heartbeat); clearInterval(busyPoll);
		for (const sig of signals) process.off(sig, onSignal);
		closeHost();
		await deleteRegistration().catch(() => {});
		// Not waiting for the host any more (a second Ctrl-C): its pipes mustn't keep this process alive.
		if (abandon) { host.stdout.destroy(); host.unref(); }
	}
	if (rc) throw new CliError("", rc);
}
