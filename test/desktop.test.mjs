// core/desktop.mjs: the session's VNC password, the tunnel's readiness, and what happens when it can't come up.
// A stub ssh plays the VM (the setup script) and the tunnel (-L: it listens on the local port).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerHost } from "./fixtures/register-host.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "boxery-desktop-"));
const home = path.join(dir, "home"), bin = path.join(dir, "bin");
registerHost(home);
mkdirSync(bin);
// MODE: password (a fresh one), headless, fail (VNC setup fails with a reason), notunnel (the forward fails).
writeFileSync(path.join(bin, "ssh"), `#!/usr/bin/env bash
mode=$(cat ${JSON.stringify(path.join(dir, "mode"))})
for a; do case $a in -L) fwd=1 ;; esac; done
if [ -n "\${fwd:-}" ]; then
  [ "$mode" != notunnel ] || { echo "bind: Address already in use" >&2; exit 255; }
  for a; do case $a in 127.0.0.1:*:127.0.0.1:6080) port=\${a#127.0.0.1:}; port=\${port%%:*} ;; esac; done
  exec node -e 'require("net").createServer().listen(Number(process.argv[1]), "127.0.0.1")' "$port"
fi
case $mode in
password|notunnel) echo "password Abc12345" ;;
headless) echo headless ;;
fail) echo "vncpasswd: cannot write" >&2; exit 1 ;;
esac
`);
chmodSync(path.join(bin, "ssh"), 0o755);
// No browser here: opened is false.
process.env.PATH = `${bin}:${process.env.PATH}`;
for (const b of ["xdg-open", "open"]) { writeFileSync(path.join(bin, b), "#!/bin/sh\nexit 0\n"); chmodSync(path.join(bin, b), 0o755); }
process.env.BOXERY_HOME = home;
const D = await import("../core/desktop.mjs");
const mode = (/** @type {string} */ m) => writeFileSync(path.join(dir, "mode"), m);

test("openDesktop: a fresh password in the URL, the tunnel up before it returns, closed on close()", async () => {
	mode("password");
	const d = await D.openDesktop("demo", { open: false });
	assert.match(d.url, /^http:\/\/127\.0\.0\.1:\d+\/vnc\.html\?autoconnect=1&resize=remote&reconnect=1#password=Abc12345$/);
	assert.equal(d.warning, null);
	const port = Number(new URL(d.url).port);
	assert.equal(await D.freePort(port), port + 1, "the tunnel's port is taken while it is open");
	d.close();
	await d.ended;
	assert.equal(await D.freePort(port), port, "and free after close()");
});

test("openDesktop: a tunnel that can't come up, a headless VM and a failed setup are errors that say why", async () => {
	mode("notunnel");
	await assert.rejects(D.openDesktop("demo", { open: false }), /tunnel to demo's desktop didn't come up/);
	mode("headless");
	await assert.rejects(D.openDesktop("demo"), /demo is headless/);
	mode("fail");
	await assert.rejects(D.prepareDesktop("demo"), /couldn't set up the desktop of demo .*: vncpasswd: cannot write/);
});
