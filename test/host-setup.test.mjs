// host/setup.mjs: host.env and the proxy/reaper service definitions written by `init` (no SQLite).
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostEnv, servicePath, serviceFiles } from "../host/setup.mjs";

const config = { conf: "/h/.config/boxery", root: "/opt/boxery", proxyPort: "8088", proxyUnit: "boxery-proxy", reaperUnit: "boxery-reaper", runnersUnit: "boxery-runners", backend: "libvirt" };

test("host.env: backend, proxy, node, and only the settings that are set", () => {
	const text = hostEnv({ ...config, env: { BOXERY_POOL: "pool2", BOXERY_NET: "", LIMA_HOME: "/l", BOXERY_CH_SUDO: "", PATH: "/x" } }, "/n/bin/node");
	assert.equal(text, "BOXERY_BACKEND=libvirt\nBOXERY_PROXY_PORT=8088\nBOXERY_PROXY_UNIT=boxery-proxy\nBOXERY_NODE=/n/bin/node\nBOXERY_POOL=pool2\nLIMA_HOME=/l\nBOXERY_CH_SUDO=\n");
	assert.doesNotMatch(hostEnv({ ...config, env: {} }, "/n"), /CH_SUDO/, "unset CH_SUDO is not written");
});

test("systemd user units on Linux", () => {
	const files = serviceFiles(config, { node: "/n/bin/node", bind: "0.0.0.0", home: "/h", platform: "linux", searchPath: "" });
	assert.deepEqual(Object.keys(files), ["/h/.config/systemd/user/boxery-proxy.service", "/h/.config/systemd/user/boxery-reaper.service", "/h/.config/systemd/user/boxery-reaper.timer",
		"/h/.config/systemd/user/boxery-runners.service"]);
	const runners = files["/h/.config/systemd/user/boxery-runners.service"];
	assert.match(runners, /^ExecStart=\/opt\/boxery\/host\/boxery-host runners run$/m);
	assert.match(runners, /^Environment=BOXERY_CONF=\/h\/\.config\/boxery BOXERY_BACKEND=libvirt PATH=/m);
	// SIGTERM to the manager only, so the acquire/release it waits for can finish; restarted if it crashes.
	assert.match(runners, /^KillMode=mixed$/m);
	assert.match(runners, /^Restart=on-failure$/m);
	const proxy = files["/h/.config/systemd/user/boxery-proxy.service"];
	assert.match(proxy, /^ExecStart=\/n\/bin\/node \/opt\/boxery\/proxy\/boxery-proxy\.mjs$/m);
	assert.match(proxy, /^Environment=BOXERY_PROXY_BIND=0\.0\.0\.0$/m);
	assert.match(proxy, /^Environment=BOXERY_CONF=\/h\/\.config\/boxery$/m);
	const reaper = files["/h/.config/systemd/user/boxery-reaper.service"];
	assert.match(reaper, /^ExecStart=\/opt\/boxery\/host\/boxery-host reap$/m);
	assert.match(reaper, /^Environment=BOXERY_CONF=\/h\/\.config\/boxery BOXERY_BACKEND=libvirt PATH=\/n\/bin:\/usr\/local\/bin:/m);
	assert.match(files["/h/.config/systemd/user/boxery-reaper.timer"], /^OnUnitActiveSec=1min$/m);
});

test("launchd agents on macOS", () => {
	const files = serviceFiles(config, { node: "/n/bin/node", bind: "127.0.0.1", home: "/h", platform: "darwin" });
	const proxy = files["/h/Library/LaunchAgents/dev.boxery-proxy.plist"];
	assert.ok(proxy.includes("<key>ProgramArguments</key><array><string>/n/bin/node</string><string>/opt/boxery/proxy/boxery-proxy.mjs</string></array>"));
	assert.ok(proxy.includes("<key>KeepAlive</key><true/>"));
	assert.ok(proxy.includes("<string>/h/Library/Logs/boxery-proxy.log</string>"));
	const reaper = files["/h/Library/LaunchAgents/dev.boxery-reaper.plist"];
	assert.ok(reaper.includes("<string>/opt/boxery/host/boxery-host</string><string>reap</string>"));
	assert.ok(reaper.includes("<key>StartInterval</key><integer>60</integer>"));
	const runners = files["/h/Library/LaunchAgents/dev.boxery-runners.plist"];
	assert.ok(runners.includes("<string>/opt/boxery/host/boxery-host</string><string>runners</string><string>run</string>"));
});

test("the reaper's PATH finds the backend's tools where they are (limactl in ~/.local/bin)", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-setup-"));
	try {
		const local = path.join(dir, ".local/bin"), other = path.join(dir, "other");
		mkdirSync(local, { recursive: true }); mkdirSync(other);
		for (const f of [path.join(local, "limactl"), path.join(other, "jq")]) { writeFileSync(f, "#!/bin/sh\n"); chmodSync(f, 0o755); }
		writeFileSync(path.join(other, "socat"), ""); // not executable: ignored
		const p = servicePath("/n/bin/node", "/usr/bin:/bin", `relative:${other}:${local}`);
		assert.equal(p, `/n/bin:${other}:${local}:/usr/bin:/bin`);
		const files = serviceFiles(config, { node: "/n/bin/node", bind: "127.0.0.1", home: "/h", platform: "linux", searchPath: local });
		assert.match(files["/h/.config/systemd/user/boxery-reaper.service"], new RegExp(`PATH=/n/bin:${local}:/usr/local/bin:`));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
