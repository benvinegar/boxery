// Guest OS definitions (guests/): the lookup, and the Linux paths core/ and host/ share.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_OS, guestOs } from "../guests/index.mjs";
import * as core from "../core/boxery-core.mjs";

test("guestOs: linux is the default, an unknown OS is refused", () => {
	assert.equal(DEFAULT_OS, "linux");
	assert.equal(guestOs().name, "linux");
	assert.equal(guestOs("linux"), guestOs());
	assert.throws(() => guestOs("macos"), /unknown guest OS: macos \(known: linux\)/);
});

test("core's guest paths are the Linux definition's", () => {
	const linux = guestOs("linux");
	assert.equal(core.REMOTE_HOME, linux.home);
	assert.equal(core.PROJECT, linux.project);
	assert.deepEqual([linux.home, linux.project, linux.configDir, linux.grantsDir], ["/home/agent", "/home/agent/project", "/etc/boxery", "/run/user/$(id -u)/boxery"]);
});
