// Offline grant transport. Operations still run in-process; only host/VM SSH effects are faked.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
/** @param {string} root @param {string[]} profiles */
export function grantTransport(root, profiles) {
	const hostbin = path.join(root, "grant-host");
	writeFileSync(hostbin, '#!/bin/sh\ncase "$1" in edge-set) cat > /dev/null ;; esac\n');
	chmodSync(hostbin, 0o755);
	for (const dir of profiles) {
		mkdirSync(path.join(dir, "grants"), { recursive: true });
		writeFileSync(path.join(dir, "config"), `HOST=local\nHOST_BIN='${hostbin.replaceAll("'", "'\\''")}'\n`);
		writeFileSync(path.join(dir, "host-pins-keys"), "");
	}
}
