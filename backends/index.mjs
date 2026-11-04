// Backend declarations are data, not probes. Platforms here describe the machine running boxery-host,
// never the controller or (for hosted backends) the provider's compute. No services/API calls on import.
// No imports: host/, controller/ and core/ all load it, and the host never depends on core/.
/** @typedef {{ os: string, arch: string }} Platform */
/** @typedef {{ host: Platform, runtime: string }} Configuration */
/** @typedef {{ id: string, kind: "tool" | "device" | "manual", description: string, setup: boolean, when?: Platform }} Requirement */
/** @typedef {{ status: "supported" | "conditional" | "unsupported", requires: string[], note: string }} Capability */
/** @typedef {{ id: string, stability: string, supported: Platform[], tested: Configuration[], runtime: { location: string, default: string, options: string[], platforms?: Record<string, Platform[]> }, requirements: Requirement[], capabilities: Record<string, Capability> }} BackendMetadata */
const linux = [{ os: "linux", arch: "x64" }, { os: "linux", arch: "arm64" }];
const both = [...linux, { os: "darwin", arch: "x64" }, { os: "darwin", arch: "arm64" }];
/** @param {string} os @param {string} arch @param {string} runtime @returns {Configuration} */
const tested = (os, arch, runtime) => ({ host: { os, arch }, runtime });
/** @param {string} description @param {boolean} [setup] @returns {Requirement} */
const manual = (description, setup = true) => ({ id: description, kind: "manual", description, setup });
/** @param {string[]} names @returns {Requirement[]} */
const tools = (names) => names.map((id) => ({ id, kind: "tool", description: `Install ${id} and put it on the boxery-host PATH`, setup: true }));
/** @param {string[]} [requires] @param {string} [note] @returns {Capability} */
const yes = (requires = [], note = "") => ({ status: requires.length ? "conditional" : "supported", requires, note });
/** @param {string} note @returns {Capability} */
const no = (note) => ({ status: "unsupported", requires: [], note });
/** @param {string[]} [requires] @returns {Record<string, Capability>} */
const capabilities = (requires = []) => ({
	desktop: yes(requires), headless: yes(), diskSnapshots: yes(requires, "Disk only; not a memory checkpoint"),
	fork: yes(requires), restore: yes(requires), resize: yes([], "Disk only grows; running VMs may restart"),
	pools: yes(requires), leases: yes(requires), guestSudo: yes(), grants: yes(),
});
const kvm = { id: "/dev/kvm", kind: /** @type {const} */ ("device"), description: "Enable KVM and allow this host user access to /dev/kvm (kvm group)", setup: true };
const paid = "Paid boat.dev saved-snapshot access";
/** @type {Record<string, BackendMetadata>} */
export const BACKENDS = {
	libvirt: {
		id: "libvirt", stability: "stable", supported: [{ os: "linux", arch: "x64" }],
		tested: [tested("linux", "x64", "kvm")],
		runtime: { location: "host", default: "kvm", options: ["kvm"] },
		requirements: [...tools(["virsh", "virt-install", "cloud-localds", "qemu-img"]), kvm, manual("Working libvirt connection and nwfilter driver (or BOXERY_NET_ISOLATION=off)")],
		capabilities: capabilities(),
	},
	lima: {
		id: "lima", stability: "stable", supported: both,
		tested: [tested("darwin", "arm64", "vz")],
		runtime: { location: "host", default: "platform", options: ["vz", "qemu"], platforms: { vz: both.filter((p) => p.os === "darwin"), qemu: both } },
		requirements: [...tools(["limactl", "jq", "ssh"]), { ...manual("macOS confinement needs sandbox-exec unless BOXERY_LIMA_CONFINE=0"), when: { os: "darwin", arch: "*" } },
			{ ...manual("Linux qemu: KVM recommended; without it Lima uses slow TCG emulation"), when: { os: "linux", arch: "*" } }],
		capabilities: capabilities(),
	},
	"cloud-hypervisor": {
		id: "cloud-hypervisor", stability: "experimental", supported: linux,
		tested: [tested("linux", "arm64", "kvm")],
		runtime: { location: "host", default: "kvm", options: ["kvm"] },
		requirements: [...tools(["cloud-hypervisor", "ch-remote", "qemu-img", "cloud-localds", "ip", "nft", "socat", "curl", "jq"]), kvm,
			manual("Cloud Hypervisor >=54 and firmware at BOXERY_CH_FIRMWARE"), manual("Root or passwordless BOXERY_CH_SUDO; cloud-hypervisor needs cap_net_admin")],
		capabilities: { ...capabilities(), resize: no("cloud-hypervisor has no resize; create a new VM with the size you need") },
	},
	exe: {
		id: "exe", stability: "experimental", supported: both,
		// Live provider validation is documented, but no host OS/arch was recorded. Do not infer it.
		tested: [], runtime: { location: "remote", default: "exe.dev", options: ["exe.dev"] },
		requirements: [...tools(["ssh", "jq", "nc", "node", "openssl"]), manual("exe.dev account with registered SSH key (ssh exe.dev, or BOXERY_EXE_KEY)")],
		capabilities: capabilities(),
	},
	openshell: {
		id: "openshell", stability: "experimental", supported: both,
		tested: [tested("linux", "x64", "docker")],
		runtime: { location: "gateway (local or remote)", default: "gateway", options: ["gateway", "docker", "podman", "microvm", "kubernetes"] },
		requirements: [...tools(["openshell", "node", "ssh"]), manual("Authenticated HTTPS OpenShell gateway and compatible image/policy; validated with OpenShell 0.1.7"),
			manual("Automatic image builds need local Docker; macOS uses Docker Desktop. Remote/non-Docker gateways need --image")],
		capabilities: {
			headless: yes([], "Prebuilt restricted image; no Boxery provisioning layers"),
			desktop: no("OpenShell has no desktop or browser; create with --headless"),
			diskSnapshots: no("OpenShell does not support disk snapshots or images"),
			fork: no("OpenShell does not support forks"), restore: no("OpenShell does not support disk restore or --from"),
			resize: no("OpenShell resize and disk sizing are driver-managed and unsupported by Boxery"),
			pools: no("OpenShell pools are unsupported: gateway SSH access is not fenced by guest authorized_keys"),
			leases: no("OpenShell leases are unsupported: gateway SSH access is not fenced by guest authorized_keys"),
			guestSudo: no("OpenShell workloads are restricted and cannot sudo; add packages to the image"),
			grants: no("OpenShell credentials are managed with OpenShell providers, not Boxery grants"),
		},
	},
	boat: {
		id: "boat", stability: "experimental", supported: both,
		tested: [], runtime: { location: "remote", default: "boat.dev", options: ["boat.dev"] },
		requirements: [...tools(["curl", "jq", "ssh", "ssh-keygen", "nc", "node", "openssl"]), manual("boat.dev account and BOAT_API_KEY (or saved api-key)"), manual(paid, false)],
		capabilities: { ...capabilities([paid]), headless: no("boat has no headless creation; use build-base and a desktop VM on a paid plan, or another backend") },
	},
};

// Common host prerequisites are declared too, not just the hypervisor-specific tools. The service
// manager is on the boxery-host machine even when compute is hosted by a provider.
for (const m of Object.values(BACKENDS)) {
	for (const r of tools(["nc", "ps", "ssh", "ssh-keygen"])) if (!m.requirements.some((existing) => existing.id === r.id)) m.requirements.push(r);
	if (m.id === "openshell") continue; // gateway manages services, not Boxery's proxy/reaper
	for (const [os, id] of [["linux", "systemctl"], ["darwin", "launchctl"]]) {
		m.requirements.push({ ...tools([id])[0], when: { os, arch: "*" } });
	}
}

/** uname and Node spellings both accepted; no fallback to a supported architecture.
 * @param {Platform} platform @returns {Platform} */
export function normalizePlatform({ os, arch }) {
	return { os: ({ Darwin: "darwin", Linux: "linux", macos: "darwin" })[os] ?? os,
		arch: ({ aarch64: "arm64", amd64: "x64", x86_64: "x64" })[arch] ?? arch };
}
/** @param {Platform} pattern @param {Platform} platform */
export function matchesPlatform(pattern, platform) {
	const p = normalizePlatform(pattern), h = normalizePlatform(platform);
	return (p.os === "*" || p.os === h.os) && (p.arch === "*" || p.arch === h.arch);
}
/** Out-of-tree backends (a .sh file in host/backends/) have none; they run unchecked. @param {string} id */
export const declared = (id) => Object.hasOwn(BACKENDS, id);
/** @param {string} id */
export function backendMetadata(id) {
	if (!Object.hasOwn(BACKENDS, id)) throw new Error(`No metadata for backend '${id}'; available: ${Object.keys(BACKENDS).join(", ")}`);
	return BACKENDS[id];
}
/** Supported is not tested. A runtime/host pair not recorded as tested stays untested.
 * @param {BackendMetadata} metadata @param {Configuration} config */
export function platformStatus(metadata, config) {
	return { supported: metadata.supported.some((p) => matchesPlatform(p, config.host)) && metadata.runtime.options.includes(config.runtime)
			&& (!metadata.runtime.platforms?.[config.runtime] || metadata.runtime.platforms[config.runtime].some((p) => matchesPlatform(p, config.host))),
		tested: metadata.tested.some((t) => matchesPlatform(t.host, config.host) && t.runtime === config.runtime) };
}
/** Unknown prerequisites must never become unconditional true (or false).
 * @param {Capability} capability @param {Record<string, boolean | undefined>} [facts] */
export function capabilityStatus(capability, facts = {}) {
	const missing = capability.requires.filter((id) => facts[id] === false);
	const unknown = capability.requires.filter((id) => facts[id] === undefined);
	return { ...capability, availability: capability.status === "unsupported" || missing.length ? "unavailable" : unknown.length ? "unknown" : "available", missing, unknown };
}

/** Generated documentation, pinned in tests. @returns {string} */
export function metadataTable() {
	const platform = (/** @type {Platform} */ p) => `${p.os}/${p.arch}`;
	return ["| Backend | Stability | Supported boxery-host | Tested host / runtime | Compute | Conditional capabilities |",
		"|---|---|---|---|---|---|", ...Object.values(BACKENDS).map((m) =>
		`| ${m.id} | ${m.stability} | ${m.supported.map(platform).join(", ")} | ${m.tested.map((t) => `${platform(t.host)} / ${t.runtime}`).join(", ") || "Not recorded"} | ${m.runtime.location}: ${m.runtime.options.join(", ")} | ${Object.entries(m.capabilities).filter(([, c]) => c.status !== "supported").map(([id, c]) => `${id}: ${c.status}${c.requires.length ? ` (${c.requires.join(", ")})` : ""}`).join("; ") || "None"} |`)].join("\n");
}
