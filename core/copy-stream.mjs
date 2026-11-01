// Streaming tar transfers. Endpoints are already resolved/pinned by the caller:
// {path, vm?, sshConf?, label}. No host registry or ambient "current VM" reads here.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { q } from "./shell.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const aborted = () => Object.assign(new Error("copy aborted"), { name: "AbortError" });
const sshArgs = (endpoint, script) => ["-F", endpoint.sshConf, "-o", "BatchMode=yes", "-o", "ControlMaster=no", `${endpoint.vm}.boxery`, `bash -c ${q(script)}`];

function groupMembers(group) {
	const result = spawnSync("ps", ["-eo", "pid=,pgid=,stat=,lstart="], {
		encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 5000,
		env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
	});
	if (result.status !== 0) return null;
	return result.stdout.split("\n").flatMap((line) => {
		const [pid, pgid, state, ...started] = line.trim().split(/\s+/);
		return Number(pgid) === group && state && !/^[ZX]/.test(state)
			? [{ pid: Number(pid), started: started.join(" ") }] : [];
	});
}
function ownedMembers(worker, { initial = false, exiting = false } = {}) {
	if (!worker.child.pid || worker.groupFinished) return [];
	const members = groupMembers(worker.child.pid);
	if (!members) { if (!initial) worker.stopError = new Error("cannot inspect owned process group"); return []; }
	const leader = members.find((m) => m.pid === worker.child.pid);
	if (initial) worker.leaderStart = leader?.started;
	else if (leader && leader.started !== worker.leaderStart) {
		worker.groupFinished = true; return []; // PID/PGID has been reused, never signal its new owner
	}
	// Snapshot surviving members at leader exit, before losing our witness to the group.
	// Later signals need either the original leader or a previously observed member identity.
	if (initial || exiting || leader || members.some((m) => worker.members.get(m.pid) === m.started)) {
		for (const m of members) worker.members.set(m.pid, m.started);
		return members;
	}
	if (!members.length) worker.groupFinished = true;
	else worker.stopError = new Error("cannot verify remaining process-group ownership");
	return [];
}
function childProcess(file, args, { input = false, output = false, env = process.env, label = file } = {}) {
	const child = spawn(file, args, { env, detached: true, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
	const worker = { child, running: !!child.pid, members: new Map(), stderr: Buffer.alloc(0), label };
	ownedMembers(worker, { initial: true });
	child.on("exit", (code, signal) => {
		worker.exitCode = code; worker.exitSignal = signal;
		ownedMembers(worker, { exiting: true });
	});
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
	const members = ownedMembers(worker);
	if (!members.length) return false;
	try { process.kill(-worker.child.pid, signal); }
	catch (e) {
		if (e.code === "EPERM") {
			// Darwin can reject killpg during teardown even when owned members are signalable.
			for (const member of members) {
				try { process.kill(member.pid, signal); }
				catch (error) { if (error.code !== "ESRCH") worker.stopError = error; }
			}
		} else if (e.code !== "ESRCH") worker.stopError = e;
	}
	return true;
}
async function terminate(workers) {
	// Group lifetime is independent of child/stdio close. A closed leader may still have
	// TERM-ignoring descendants with no inherited descriptors; those need KILL as well.
	const live = workers.filter((w) => kill(w, "SIGTERM"));
	if (live.length) await delay(200);
	for (const w of live) kill(w, "SIGKILL");
	// Do not wait for stdio close yet: a remote job (or ProxyCommand descendant) can
	// still hold a descriptor. Fence remote groups first, then reap the local clients.
}

// Metadata calls are bounded, but not interrupted mid-prepare by the user's signal: wait for
// directory creation to finish before cleanup. The payload workers ARE immediately cancellable.
function releaseDescriptors(worker) {
	worker.child.stdin?.destroy(); worker.child.stdout.destroy(); worker.child.stderr.destroy();
	worker.child.unref();
}
async function metadata(endpoint, script, label, timeout = 30_000) {
	const worker = childProcess("ssh", sshArgs(endpoint, script), { label, output: true });
	const chunks = []; let bytes = 0, timer, error;
	worker.child.stdout.on("data", (chunk) => {
		bytes += chunk.length;
		if (bytes <= 64 * 1024) chunks.push(chunk);
		else kill(worker, "SIGKILL");
	});
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(Object.assign(new Error(`${label}: timed out; remote completion unverified`), { remoteUnverified: true })), timeout);
	});
	try {
		await Promise.race([worker.done, deadline]);
		if (bytes > 64 * 1024) throw new Error(`${label}: metadata output exceeded 64 KiB`);
	} catch (e) {
		error = e;
		if (worker.exitCode === 255 || worker.exitSignal) error.remoteUnverified = true;
	} finally {
		clearTimeout(timer);
		await terminate([worker]);
		// A detached helper may retain these pipes after SSH itself exits. Never wait for
		// close indefinitely; the independent deadline must bound completion, not just signal.
		releaseDescriptors(worker);
	}
	if (worker.stopError) {
		error ??= new Error(`${label}: metadata process cleanup failed`);
		error.remoteUnverified = true;
		error.message += ` (${worker.stopError.message})`;
	}
	if (error) throw error;
	return Buffer.concat(chunks).toString("utf8");
}

function remoteWorker(endpoint, control, command, options) {
	// Publish the process-group identity atomically BEFORE touching the archive. Cleanup renames
	// the control directory first. A late starter then cannot publish and must exit without work.
	// Keep one identity snapshot per worker (extract and publish use different groups).
	// EXIT also records descriptor-free descendants before the leader disappears. Retrying
	// against the tomb lets a terminating worker publish its final witnesses after fencing.
	const snapshot = `LC_ALL=C TZ=UTC ps -eo pid=,pgid=,stat=,lstart= | awk -v g="$$" ${q('$2 == g { $1=$1; print }')}`;
	const inner = `set -e -o pipefail; c=${q(control)}; ` +
		`publish() { ${snapshot} >"$1/pgid.$$.tmp" && mv "$1/pgid.$$.tmp" "$1/pgid.$$"; }; ` +
		`publish "$c"; trap 'rc=$?; publish "$c" 2>/dev/null || publish "$c.cleanup" 2>/dev/null || true; exit "$rc"' EXIT; ${command}`;
	const script = `setsid -w bash -c ${q(inner)}`;
	return childProcess("ssh", sshArgs(endpoint, script), options);
}
async function cleanRemote(stage, timeout = 15_000) {
	const c = q(stage.control), tomb = q(`${stage.control}.cleanup`);
	const live = '$2 == g && $3 !~ /^[ZX]/ { found=1 } END { exit !found }';
	const matches = `function born(s,i) { for(i=4;i<=NF;i++) s=s (i>4?" ":"") $i; return s }
		FILENAME != ARGV[ARGC-1] { if($2==g && $3 !~ /^[ZX]/) known[$1 SUBSEP born()]=1; next }
		$2==g && $3 !~ /^[ZX]/ && (($1 SUBSEP born()) in known) { found=1 }
		END { exit !found }`;
	// Keep cleanup's observations separate from EXIT updates: signal/trap timing must not
	// erase the live-member identities needed for escalation after a parent terminates.
	const script = `set -e; c=${c}; t=${tomb}; failed=0; ` +
		`if [ -d "$c" ]; then mv "$c" "$t"; fi; if [ -d "$t" ]; then ` +
		`owns() { LC_ALL=C TZ=UTC ps -eo pid=,pgid=,stat=,lstart= >"$t/current" || exit 1; ` +
		`local rc=0; awk -v g="$g" ${q(matches)} "$record" "$t/witness.$g" "$t/current" || rc=$?; [ "$rc" -le 1 ] || exit "$rc"; return "$rc"; }; ` +
		`remember() { awk -v g="$g" ${q('$2 == g { $1=$1; print }')} "$t/current" >"$t/witness.$g"; }; ` +
		`for record in "$t"/pgid.*; do case "$record" in *.tmp) continue ;; esac; [ -f "$record" ] || continue; ` +
		'g=${record##*.}; case "$g" in \'\'|*[!0-9]*) continue ;; esac; [ "$g" -gt 1 ] || continue; ' +
		`: >"$t/witness.$g"; if owns; then remember; kill -TERM -- -"$g" 2>/dev/null || true; sleep 0.2; ` +
		`if owns; then remember; kill -KILL -- -"$g" 2>/dev/null || true; fi; ` +
		`for attempt in 1 2 3 4 5 6 7 8 9 10; do if owns; then sleep 0.05; else break; fi; done; fi; ` +
		`if awk -v g="$g" ${q(live)} "$t/current"; then echo "cannot stop or verify copy group $g" >&2; failed=1; fi; done; ` +
		`if ! rm -rf "$t"; then find -P "$t" -type d -exec chmod u+rwx '{}' ';'; rm -rf "$t"; fi; ` +
		`[ "$failed" -eq 0 ]; fi`;
	await metadata(stage.endpoint, script, `cleanup ${stage.endpoint.label}`, timeout);
}
async function cleanLocal(control) {
	try { await rm(control, { recursive: true, force: true }); }
	catch (error) {
		if (!["EACCES", "EPERM"].includes(error.code)) throw error;
		// tar restores directory modes. Make only our staged directories traversable/writable,
		// before descending; do not chmod files/hardlinks or follow archived symlinks.
		const writableDirectories = async (directory) => {
			let info;
			try { info = await lstat(directory); }
			catch (e) { if (e.code === "ENOENT") return; throw e; }
			if (!info.isDirectory()) return;
			await chmod(directory, 0o700);
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (entry.isDirectory()) await writableDirectories(path.join(directory, entry.name));
			}
		};
		await writableDirectories(control);
		await rm(control, { recursive: true, force: true });
	}
}

// tar may finish after its two EOF blocks, before the producer's final record padding.
// Drain that padding on SUCCESS so an otherwise valid transfer cannot fail with EPIPE.
const extractScript = (data) => `if (cd ${q(data)} && tar -xf -); then cat >/dev/null; else exit $?; fi`;
const commitScript = (destination, data, basename) =>
	`set -e; d=${q(destination)}; t=${q(data)}; ` +
	`if [ -d "$d" ]; then cp -a "$t"/${q(basename)} "$d"/; ` +
	`else mkdir -p "$(dirname "$d")"; mv "$t"/${q(basename)} "$d"; fi`;

export async function streamCopy(source, destination, { signal, metadataTimeoutMs = 30_000, cleanupTimeoutMs = 15_000 } = {}) {
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
	const prepare = async (endpoint, script, pending) => {
		try { return await metadata(endpoint, script, `prepare ${endpoint.label}`, metadataTimeoutMs); }
		catch (error) {
			// A lost SSH client/status cannot prove that a remote mkdir stopped. Even an
			// absent directory during cleanup does not rule out a late queued preparation.
			if (error.remoteUnverified) for (const stage of pending) stage.preparationUnverified = true;
			throw error;
		}
	};
	try {
		let sourceControl;
		if (source.vm) {
			sourceControl = `/tmp/.boxery-copy-${id}-source`;
			const stage = { endpoint: source, control: sourceControl };
			stages.push(stage);
			await prepare(source, `mkdir -m 700 ${q(sourceControl)}`, [stage]);
			check();
		}
		let destinationControl;
		if (destination.vm) {
			const name = `.boxery-copy-${id}-destination`;
			const parent = path.posix.dirname(destination.path);
			const candidates = [...new Set([path.posix.join(destination.path, name), path.posix.join(parent, name)])];
			// Track both possible locations until the remote reply arrives. A lost reply after
			// mkdir must not lose ownership of the directory that needs cleanup.
			const pending = candidates.map((control) => ({ endpoint: destination, control }));
			stages.push(...pending);
			const script = `set -e; d=${q(destination.path)}; if [ -d "$d" ]; then c=${q(candidates[0])}; location=inside; ` +
				`else mkdir -p ${q(parent)}; c=${q(path.posix.join(parent, name))}; location=parent; fi; ` +
				`mkdir -m 700 "$c"; mkdir "$c/data"; printf '%s' "$location"`;
			const location = await prepare(destination, script, pending);
			if (!["inside", "parent"].includes(location)) throw new Error(`prepare ${destination.label}: unexpected staging response`);
			destinationControl = location === "inside" ? candidates[0] : path.posix.join(parent, name);
			for (const stage of pending) if (stage.control !== destinationControl) stages.splice(stages.indexOf(stage), 1);
		} else {
			let directory = false;
			try { directory = (await stat(destination.path)).isDirectory(); }
			catch (e) { if (!["ENOENT", "ENOTDIR"].includes(e.code)) throw e; }
			const parent = directory ? destination.path : path.dirname(destination.path);
			await mkdir(parent, { recursive: true });
			destinationControl = await mkdtemp(path.join(parent, ".boxery-copy-"));
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
		const cleanupErrors = workers.filter((w) => w.stopError).map((w) => `${w.label}: ${w.stopError.message}`);
		for (const stage of stages.reverse()) {
			try {
				if (stage.endpoint) await cleanRemote(stage, cleanupTimeoutMs);
				else await cleanLocal(stage.control);
			} catch (e) { cleanupErrors.push(e.message); }
			if (stage.preparationUnverified) cleanupErrors.push(`prepare ${stage.endpoint.label}: completion unverified; late staging may remain`);
		}
		// Cleanup above terminates remote groups even if their SSH clients were killed first.
		// Release local descriptors as well when a failed cleanup cannot reach a remote peer.
		for (const w of workers) releaseDescriptors(w);
		let reapTimer;
		const reaped = await Promise.race([
			Promise.allSettled(workers.map((w) => w.done)).then(() => true),
			new Promise((resolve) => { reapTimer = setTimeout(() => resolve(false), 2000); }),
		]);
		clearTimeout(reapTimer);
		if (!reaped) cleanupErrors.push("local worker completion unverified after termination");
		if (signal?.aborted) failure = aborted();
		if (failure) {
			const diagnostics = workers.map((w) => w.stderr.toString().trim()).filter(Boolean);
			if (diagnostics.length) failure.message += `\n${diagnostics.join("\n")}`;
		}
		if (cleanupErrors.length) {
			failure ??= new Error("copy cleanup failed");
			failure.message += `\nCleanup incomplete: ${[...new Set(cleanupErrors)].join("; ")}`;
		}
	}
	if (failure) throw failure;
	return bytes;
}
