// Offline boxery-host for in-process controller operations (grants, leases, lifecycle, listings): only
// host/VM SSH effects are faked. The stub host records each call as "PROFILE_DIR: ARGS" in ROOT/host.calls
// (hostCalls), answers lease commands for pool-1 in JSON, as a current host does (renew fails while
// ROOT/renew-fails exists), lists canned VMs/shapes/snaps/images/capabilities/version as JSON, and
// answers any other command with "stub host ARGS" (stdout) plus "==> ARGS" (stderr).
// `ls --json` prints ROOT/host.ls.json (LS_JSON unless a test writes another).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LEASE_ID = "l-0123456789abcdef0123456789abcdef";
export const LS_JSON = '[\n{"name":"fakevm","state":"running","ssh_addr":"10.0.0.2:22","disk_size":40,"disk_used":1.5,"tunnel":null,"lease":null,"shape":"standard","cpus":4,"mem":8192}\n]';

/** @param {string} root @param {string[]} profiles */
export function hostTransport(root, profiles) {
	const hostbin = path.join(root, "grant-host");
	const j = (/** @type {string} */ f) => JSON.stringify(path.join(root, f));
	writeFileSync(hostbin, `#!/bin/sh
printf '%s: %s\\n' "$BOXERY_STUB_PROFILE" "$*" >> ${j("host.calls")}
json=; for a; do [ "$a" != --json ] || json=1; done
case "$*" in
help) echo '  renew LEASE [--ttl S] [--json] | release LEASE'; echo '  known-hosts NAME' ;;
edge-set*) cat > /dev/null ;;
acquire*) cat > /dev/null; e=$(( $(date +%s) + 600 ))
  if [ -n "$json" ]; then printf '{"name":"pool-1","lease_id":"%s","expires_at":%s}\\n' ${LEASE_ID} "$e"; else echo "pool-1 ${LEASE_ID} $e"; fi ;;
renew*) [ ! -f ${j("renew-fails")} ] || { echo "lease expired" >&2; exit 1; }
  if [ -n "$json" ]; then echo '{"name":"pool-1","lease_id":"${LEASE_ID}","expires_at":9999999999}'; else echo "pool-1 9999999999"; fi ;;
"release "*) : ;;
"ls --json"*) cat ${j("host.ls.json")} ;;
"ls"*) printf 'NAME STATE\\nfakevm running\\n' ;;
"shapes --json") echo '{"default":"standard","shapes":{"standard":{"cpus":4,"mem":8192,"disk":40},"large":{"cpus":8,"mem":16384,"disk":80}}}' ;;
"capabilities --json") echo '{"schemaVersion":1,"backend":{"id":"boat"},"platform":{"supported":true,"tested":false},"capabilities":{"headless":{"availability":"unavailable"},"diskSnapshots":{"availability":"unknown"}}}' ;;
"images --json") echo '[{"image":"fakevm@s1","created":"2026-10-01T00:00:00Z","size":"1.2G"}]' ;;
"snaps "*" --json") echo '[{"name":"s1","created":"2026-10-01T00:00:00Z","size":"1.2G"}]' ;;
"version --json") echo '{"version":"0.7.0","describe":null,"install":"npm"}' ;;
"new slow"*) echo "==> creating slow" >&2; sleep 1.2; echo "==> slow is ready" >&2 ;;
"new fail"*) echo "boxery-host: it broke" >&2; exit 3 ;;
*) echo "stub host $*"; echo "==> $*" >&2 ;;
esac
`);
	chmodSync(hostbin, 0o755);
	if (!existsSync(path.join(root, "host.ls.json"))) writeFileSync(path.join(root, "host.ls.json"), `${LS_JSON}\n`);
	for (const dir of profiles) {
		mkdirSync(path.join(dir, "grants"), { recursive: true });
		const q = (/** @type {string} */ s) => `'${s.replaceAll("'", "'\\''")}'`;
		writeFileSync(path.join(dir, "config"), `HOST=local\nHOST_BIN=${q(hostbin)}\nexport BOXERY_STUB_PROFILE=${q(dir)}\n`);
		writeFileSync(path.join(dir, "host-pins-keys"), "");
	}
}

/** The stub host's calls so far, as "PROFILE_DIR: ARGS" lines. @param {string} root */
export const hostCalls = (root) => {
	const f = path.join(root, "host.calls");
	return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : [];
};
/** The stub host's calls, without the PROFILE_DIR prefix or the feature probes (help). @param {string} root */
export const hostArgs = (root) => hostCalls(root).map((l) => l.slice(l.indexOf(": ") + 2)).filter((c) => c !== "help");
