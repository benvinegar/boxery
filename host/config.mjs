// Host configuration: where state lives, which backend runs VMs, and the settings `init` persists in
// $BOXERY_CONF/host.env. Explicit environment variables win over the file; an empty one counts as unset.
// No dependencies beyond node: builtins, so it loads on every supported Node version.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Settings `init` persists in host.env and later commands read from it (host/backend.sh reads the same
// list): the proxy's and the backends' (host/backends/README.md).
export const HOST_ENV = ["BOXERY_BACKEND", "BOXERY_PROXY_PORT", "BOXERY_PROXY_UNIT", "BOXERY_POOL", "BOXERY_POOL_DIR", "BOXERY_BASE_VOL",
	"BOXERY_DOMAIN_PREFIX", "BOXERY_NET", "LIBVIRT_DEFAULT_URI", "LIMA_HOME", "BOXERY_LIMA_PREFIX", "BOXERY_LIMA_GATEWAY", "BOXERY_LIMA_VMTYPE",
	"BOXERY_LIMA_ARCH", "BOXERY_CH_DIR", "BOXERY_CH_NET", "BOXERY_CH_DNS", "BOXERY_CH_FIRMWARE", "BOXERY_CH_SUDO", "BOXERY_EXE_DIR",
	"BOXERY_EXE_PREFIX", "BOXERY_EXE_KEY", "BOXERY_EXE_PORT_BASE", "BOXERY_EXE_GUEST_PORT", "BOXERY_EXE_EGRESS", "BOXERY_EXE_POOL",
	"BOXERY_EXE_MAX_CPUS", "BOXERY_EXE_MAX_MEM"];

// Backend routing settings an operation journals, so recovery replays it in the same backend namespace.
// Never arbitrary environment variables or credentials.
export const SETTINGS = ["BOXERY_BACKEND", "BOXERY_POOL", "BOXERY_POOL_DIR", "BOXERY_BASE_VOL", "BOXERY_DOMAIN_PREFIX", "BOXERY_NET",
	"LIBVIRT_DEFAULT_URI", "LIMA_HOME", "BOXERY_LIMA_PREFIX", "BOXERY_LIMA_GATEWAY", "BOXERY_LIMA_VMTYPE", "BOXERY_LIMA_ARCH",
	"BOXERY_CH_DIR", "BOXERY_CH_NET", "BOXERY_CH_DNS", "BOXERY_CH_FIRMWARE", "BOXERY_CH_SUDO", "BOXERY_FAKE_DIR", "BOXERY_PROXY_PORT"];

export function loadConfig(env = process.env) {
	const conf = path.resolve(env.BOXERY_CONF || path.join(homedir(), ".config/boxery"));
	const merged = { ...env };
	let text = "";
	try { text = readFileSync(path.join(conf, "host.env"), "utf8"); }
	catch (e) { if (e.code !== "ENOENT") throw e; }
	for (const line of text.split("\n")) {
		const i = line.indexOf("=");
		const [k, v] = i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
		if (HOST_ENV.includes(k) && !merged[k]) merged[k] = v;
	}
	const proxyUnit = merged.BOXERY_PROXY_UNIT || "boxery-proxy";
	return {
		conf,
		root: ROOT,
		env: merged,
		backend: merged.BOXERY_BACKEND || "libvirt",
		proxyPort: merged.BOXERY_PROXY_PORT || "8088",
		proxyUnit,
		reaperUnit: merged.BOXERY_REAPER_UNIT || proxyUnit.replace("proxy", "reaper"),
		cache: merged.BOXERY_CACHE || path.join(homedir(), ".cache/boxery"),
	};
}
