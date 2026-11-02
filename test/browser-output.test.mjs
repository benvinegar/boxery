// The real CDP helper exits explicitly to close its websocket. It must drain a large screenshot
// before exiting: Node's stdout pipe buffers only ~64 KiB, and process.exit() drops the remainder.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerHost } from "./fixtures/register-host.mjs";

test("browser drains screenshot output before exiting its Node helper", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "boxery-browser-output-"));
	const old = { home: process.env.BOXERY_HOME, path: process.env.PATH, pw: process.env.BOXERY_PW };
	try {
		const home = path.join(dir, "controller"), profile = path.join(home, "profile"), bin = path.join(dir, "bin");
		mkdirSync(profile, { recursive: true });
		mkdirSync(bin);
		writeFileSync(path.join(profile, "ssh_config"), "# mock transport\n");
		registerHost(home, "mock", profile);
		const fake = path.join(dir, "playwright.mjs");
		writeFileSync(fake, `const page = { url: () => 'https://example.com', bringToFront: async () => {}, screenshot: async () => Buffer.alloc(1024 * 1024, 42) };
export const chromium = { connectOverCDP: async () => ({ contexts: () => [{ pages: () => [page] }] }) };`);
		const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
		writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nexec ${q(process.execPath)} --input-type=module\n`, { mode: 0o755 });
		process.env.BOXERY_HOME = home;
		process.env.PATH = `${bin}:${old.path}`;
		process.env.BOXERY_PW = pathToFileURL(fake).href;
		const { browser } = await import("../core/boxery-core.mjs");
		const result = await browser("test", { code: "return 42", screenshot: true });
		assert.match(result.text, /result: 42/);
		assert.equal(Buffer.from(result.image.data, "base64").length, 1024 * 1024);
	} finally {
		for (const [key, value] of Object.entries({ BOXERY_HOME: old.home, PATH: old.path, BOXERY_PW: old.pw })) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});
