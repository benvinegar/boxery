// Streaming tar transfers. Endpoints are already resolved/pinned by the caller:
// {path, vm?, sshConf?, label}. No host registry or ambient "current VM" reads here.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { q } from "./shell.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const aborted = () => Object.assign(new Error("copy aborted"), { name: "AbortError" });
const sshArgs = (endpoint, script) => ["-F", endpoint.sshConf, "-o", "BatchMode=yes", "-o", "ControlMaster=no", `${endpoint.vm}.boxery`, `bash -c ${q(script)}`];

function childProcess(file, args, { input = false, output = false, env = process.env, label = file } = {}) {
	const child = spawn(file, args, { env, detached: true, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
	const worker = { child, running: !!child.pid, stderr: Buffer.alloc(0), label };
	child.stdin?.on("error", () => {}); // pipeline/process status reports EPIPE
	child.stderr.on("data", (chunk) => {
		worker.stderr = Buffer.concat([worker.stderr, chunk]).subarray(-64 * 1024);
	});
	if (!output) child.stdout.resume();
	worker.done = new Promise((resolve, reject) => {
		child.on("error", (e) => { worker.failure = new Error(`${label}: ${e.message}`); reject(worker.failure); });
		child.on("close", (code, signal) => {
			worker.running = false;
			if (code === 0) return resolve();
			worker.failure ??= new Error(`${label}: ${worker.stderr.toString().trim() || `exit ${code ?? signal}`}`);
			reject(worker.failure);
		});
	});
	worker.done.catch(() => {}); // a peer may fail before Promise.all attaches
	return worker;
}
function kill(worker, signal) {
	if (!worker.running || !worker.child.pid) return;
	try { process.kill(-worker.child.pid, signal); }
	catch (e) { if (e.code !== "ESRCH") throw e; }
}
async function terminate(workers) {
	const live = workers.filter((w) => w.running);
	for (const w of live) kill(w, "SIGTERM");
	if (live.length) await delay(200);
	for (const w of live) kill(w, "SIGKILL");
	// Do not wait for stdio close yet: a remote job (or ProxyCommand descendant) can
	// still hold a descriptor. Fence remote groups first, then reap the local clients.
}

// Metadata calls are bounded, but not interrupted mid-prepare by the user's signal: wait for
// directory creation to finish before cleanup. The payload workers ARE immediately cancellable.
async function metadata(endpoint, script, label, timeout = 30_000) {
	const worker = childProcess("ssh", sshArgs(endpoint, script), { label });
	const timer = setTimeout(() => kill(worker, "SIGTERM"), timeout);
	const hardTimer = setTimeout(() => kill(worker, "SIGKILL"), timeout + 200);
	try { await worker.done; }
	finally { clearTimeout(timer); clearTimeout(hardTimer); }
}

function remoteWorker(endpoint, control, command, options) {
	// Publish the process-group identity atomically BEFORE touching the archive. Cleanup renames
	// the control directory first. A late starter then cannot publish and must exit without work.
	const inner = `set -e; c=${q(control)}; start=$(LC_ALL=C TZ=UTC ps -p $$ -o lstart=); ` +
		`printf '%s\\n%s\\n' "$$" "$start" >"$c/pgid.$$"; mv "$c/pgid.$$" "$c/pgid"; ${command}`;
	const script = `setsid -w bash -c ${q(inner)}; rc=$?; rm -f ${q(`${control}/pgid`)}; exit "$rc"`;
	return childProcess("ssh", sshArgs(endpoint, script), options);
}
async function cleanRemote(stage) {
	const c = q(stage.control), tomb = q(`${stage.control}.cleanup`);
	const script = `set -e; c=${c}; t=${tomb}; ` +
		`if [ -d "$c" ]; then mv "$c" "$t"; fi; ` +
		`if [ -d "$t" ]; then ` +
		`if [ -f "$t/pgid" ]; then { IFS= read -r g; IFS= read -r expected; } <"$t/pgid"; ` +
		`case "$g" in ''|*[!0-9]*) g=0 ;; esac; ` +
		`if [ "$g" -gt 1 ]; then actual=$(LC_ALL=C TZ=UTC ps -p "$g" -o lstart= 2>/dev/null || true); ` +
		`if [ -z "$actual" ] || [ "$actual" = "$expected" ]; then ` +
		`kill -TERM -- -"$g" 2>/dev/null || true; sleep 0.2; kill -KILL -- -"$g" 2>/dev/null || true; fi; fi; fi; ` +
		`rm -rf "$t"; fi`;
	await metadata(stage.endpoint, script, `cleanup ${stage.endpoint.label}`, 15_000);
}
// tar may finish after its two EOF blocks, before the producer's final record padding.
// Drain that padding on SUCCESS so an otherwise valid transfer cannot fail with EPIPE.
const extractScript = (data) => `if (cd ${q(data)} && tar -xf -); then cat >/dev/null; else exit $?; fi`;
const commitScript = (destination, data, basename) =>
	`set -e; d=${q(destination)}; t=${q(data)}; ` +
	`if [ -d "$d" ]; then cp -a "$t"/${q(basename)} "$d"/; ` +
	`else mkdir -p "$(dirname "$d")"; mv "$t"/${q(basename)} "$d"; fi`;

export async function streamCopy(source, destination, { signal } = {}) {
	if (signal?.aborted) throw aborted();
	const basename = path.posix.basename(source.path);
	if (!basename) throw new Error("cannot copy the filesystem root");
	const id = randomBytes(12).toString("hex");
	const stages = [], workers = [];
	const transfer = new AbortController();
	let bytes = 0, failure;
	const onAbort = () => {
		transfer.abort();
		for (const w of workers) kill(w, "SIGTERM");
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	const check = () => { if (signal?.aborted) throw aborted(); };
	try {
		let sourceControl;
		if (source.vm) {
			sourceControl = `/tmp/.boxery-copy-${id}-source`;
			stages.push({ endpoint: source, control: sourceControl });
			await metadata(source, `mkdir -m 700 ${q(sourceControl)}`, `prepare ${source.label}`);
			check();
		}
		let destinationControl;
		if (destination.vm) {
			destinationControl = path.posix.join(path.posix.dirname(destination.path), `.boxery-copy-${id}-destination`);
			stages.push({ endpoint: destination, control: destinationControl });
			await metadata(destination, `mkdir -p ${q(path.posix.dirname(destination.path))} && mkdir -m 700 ${q(destinationControl)} && mkdir ${q(`${destinationControl}/data`)}`, `prepare ${destination.label}`);
		} else {
			await mkdir(path.dirname(destination.path), { recursive: true });
			destinationControl = await mkdtemp(path.join(path.dirname(destination.path), ".boxery-copy-"));
			stages.push({ control: destinationControl });
			await mkdir(path.join(destinationControl, "data"));
		}
		check();
		const data = `${destinationControl}/data`;
		// A staging directory may be inside the source (copying a directory into itself). Never
		// archive our own growing extraction tree, even through two aliases of the same VM host.
		const excludes = stages.map((s) => `--exclude=${path.posix.basename(s.control)}`);
		// NUL-delimited -T input is literal on GNU AND BSD tar. GNU tar otherwise unquotes
		// backslashes even in argv filenames; GNU-only --no-unquote would break macOS.
		const sourceArgs = ["-cf", "-", ...excludes, "--null", "-T", "-"];
		// cd in the shell too: GNU tar also unquotes its -C argument.
		const sourceScript = `export COPYFILE_DISABLE=1; cd ${q(path.posix.dirname(source.path))} && printf '%s\\000' ${q(basename)} | tar ${sourceArgs.map(q).join(" ")}`;
		const producer = source.vm
			? remoteWorker(source, sourceControl, sourceScript, { output: true, label: `read ${source.label}` })
			: childProcess("sh", ["-c", sourceScript], { output: true, label: `read ${source.path}`, env: { ...process.env, COPYFILE_DISABLE: "1" } });
		workers.push(producer);
		const consumer = destination.vm
			? remoteWorker(destination, destinationControl, extractScript(data), { input: true, label: `extract ${destination.label}` })
			: childProcess("sh", ["-c", extractScript(data)], { input: true, label: `extract ${destination.path}` });
		workers.push(consumer);
		const counter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(null, chunk); } });
		const pump = pipeline(producer.child.stdout, counter, consumer.child.stdin, { signal: transfer.signal });
		await Promise.all([producer.done, consumer.done, pump]);
		check();
		// EOF alone is not success: a producer can emit a valid tar and STILL exit nonzero.
		// Commit only after BOTH process statuses and the stream pipeline have succeeded.
		const script = commitScript(destination.path, data, basename);
		const commit = destination.vm
			? remoteWorker(destination, destinationControl, script, { label: `commit ${destination.label}` })
			: childProcess("sh", ["-c", script], { label: `commit ${destination.path}` });
		workers.push(commit);
		await commit.done;
		check();
	} catch (e) {
		failure = e;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		transfer.abort();
		await terminate(workers);
		const cleanupErrors = [];
		for (const stage of stages.reverse()) {
			try {
				if (stage.endpoint) await cleanRemote(stage);
				else await rm(stage.control, { recursive: true, force: true });
			} catch (e) { cleanupErrors.push(e.message); }
		}
		// Cleanup above terminates remote groups even if their SSH clients were killed first.
		// Release local descriptors as well when a failed cleanup cannot reach a remote peer.
		for (const w of workers) {
			w.child.stdin?.destroy(); w.child.stdout.destroy(); w.child.stderr.destroy();
		}
		await Promise.allSettled(workers.map((w) => w.done));
		if (signal?.aborted) failure = aborted();
		if (failure) {
			const diagnostics = workers.map((w) => w.stderr.toString().trim()).filter(Boolean);
			if (diagnostics.length) failure.message += `\n${diagnostics.join("\n")}`;
		}
		if (cleanupErrors.length) {
			failure ??= new Error("copy cleanup failed");
			failure.message += `\nCleanup incomplete: ${cleanupErrors.join("; ")}`;
		}
	}
	if (failure) throw failure;
	return bytes;
}
