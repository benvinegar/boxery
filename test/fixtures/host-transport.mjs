// Offline host transport for in-process grant and lease operations: only host/VM SSH effects are faked.
// The stub host records each call as "PROFILE_DIR: ARGS" in ROOT/host.calls (hostCalls), answers lease
// commands for pool-1 in JSON, as a current host does (renew fails while ROOT/renew-fails exists), and
// swallows edge-set input.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LEASE_ID = "l-0123456789abcdef0123456789abcdef";

/** @param {string} root @param {string[]} profiles */
export function hostTransport(root, profiles) {
	const hostbin = path.join(root, "grant-host");
	const calls = JSON.stringify(path.join(root, "host.calls")), fail = JSON.stringify(path.join(root, "renew-fails"));
	writeFileSync(hostbin, `#!/bin/sh
printf '%s: %s\\n' "$BOXERY_STUB_PROFILE" "$*" >> ${calls}
json=; for a; do [ "$a" != --json ] || json=1; done
case "$1" in
help) echo '  renew LEASE [--ttl S] [--json] | release LEASE' ;;
edge-set) cat > /dev/null ;;
acquire) cat > /dev/null; e=$(( $(date +%s) + 600 ))
  if [ -n "$json" ]; then printf '{"name":"pool-1","lease_id":"%s","expires_at":%s}\n' ${LEASE_ID} "$e"; else echo "pool-1 ${LEASE_ID} $e"; fi ;;
renew) [ ! -f ${fail} ] || { echo "lease expired" >&2; exit 1; }
  if [ -n "$json" ]; then echo '{"name":"pool-1","lease_id":"${LEASE_ID}","expires_at":9999999999}'; else echo "pool-1 9999999999"; fi ;;
esac
`);
	chmodSync(hostbin, 0o755);
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
