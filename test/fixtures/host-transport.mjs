// Offline host transport for in-process grant and lease operations: only host/VM SSH effects are faked.
// The stub host records each call as "PROFILE_DIR: ARGS" in ROOT/host.calls (hostCalls), answers lease
// commands for pool-1 (renew fails while ROOT/renew-fails exists) and swallows edge-set input.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LEASE_ID = "l-0123456789abcdef0123456789abcdef";

/** @param {string} root @param {string[]} profiles */
export function hostTransport(root, profiles) {
	const hostbin = path.join(root, "grant-host");
	const calls = JSON.stringify(path.join(root, "host.calls")), fail = JSON.stringify(path.join(root, "renew-fails"));
	writeFileSync(hostbin, `#!/bin/sh
printf '%s: %s\\n' "$BOXERY_STUB_PROFILE" "$*" >> ${calls}
case "$1" in
edge-set) cat > /dev/null ;;
acquire) cat > /dev/null; echo "pool-1 ${LEASE_ID} $(( $(date +%s) + 600 ))" ;;
renew) [ ! -f ${fail} ] || { echo "lease expired" >&2; exit 1; }; echo "pool-1 9999999999" ;;
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
