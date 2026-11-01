// core.LeaseKeeper against a stub controller: heartbeat renewal, activity gating, lost leases, release.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerHost } from "./fixtures/register-host.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "boxery-lease-"));
const calls = path.join(dir, "calls");
const failRenew = path.join(dir, "renew-fails");
registerHost(path.join(dir, "home"));
writeFileSync(
	path.join(dir, "boxery"),
	`#!/usr/bin/env bash
[ "$1" != --host ] || shift 4 # --host NAME --profile-dir DIR
echo "$*" >> ${calls}
case "$1" in
acquire) echo "==> leased pool-1" >&2; echo "pool-1 l-0123456789abcdef0123456789abcdef" ;;
renew) [ ! -f ${failRenew} ] || { echo "lease expired" >&2; exit 1; }; echo "pool-1 9999999999" ;;
release) echo "==> released pool-1" ;;
esac
`,
);
chmodSync(path.join(dir, "boxery"), 0o755);
process.env.BOXERY_HOME = path.join(dir, "home");
process.env.BOXERY_BIN = path.join(dir, "boxery");
const core = await import("../core/boxery-core.mjs");

const log = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
const reset = () => rmSync(calls, { force: true });
const until = async (pred) => {
	for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
	assert.ok(pred(), `timed out; calls: ${log().join(" | ")}`);
};

test("acquire validates, parses NAME LEASE_ID and renews on a heartbeat while alive", async () => {
	reset();
	let alive = true;
	const k = new core.LeaseKeeper({ alive: () => alive, everyMs: () => 40 });
	await assert.rejects(k.acquire({ ttl: 5 }), /ttl must be/);
	await assert.rejects(k.acquire({ wait: -1 }), /wait must be/);
	const l = await k.acquire({ ttl: 600, wait: 3 });
	assert.deepEqual([l.name, l.id, l.ttl], ["pool-1", "l-0123456789abcdef0123456789abcdef", 600]);
	assert.equal(k.find("pool-1"), l);
	assert.equal(k.find("other"), null);
	await until(() => log().filter((c) => c.startsWith("renew")).length >= 2);
	assert.equal(log()[1], "renew l-0123456789abcdef0123456789abcdef --ttl 600");

	alive = false; // an idle session stops renewing; the lease is left to expire on the host
	await new Promise((r) => setTimeout(r, 60));
	const n = log().length;
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(log().length, n, "no renewals while not alive");

	await k.release("pool-1");
	assert.equal(log().at(-1), "release l-0123456789abcdef0123456789abcdef");
	assert.equal(k.list().length, 0);
	await assert.rejects(k.release("pool-1"), /holds no lease/);
});

test("a failed heartbeat forgets the lease and reports it lost", async () => {
	reset();
	const lost = [];
	const k = new core.LeaseKeeper({ everyMs: () => 30, onLost: (l, e) => lost.push([l.name, e.message]) });
	await k.acquire({ ttl: 600 });
	writeFileSync(failRenew, "");
	try {
		await until(() => lost.length === 1);
		assert.equal(lost[0][0], "pool-1");
		assert.match(lost[0][1], /lease expired/);
		assert.equal(k.list().length, 0);
		await assert.rejects(k.renew("pool-1"), /holds no lease/);
	} finally {
		rmSync(failRenew);
	}
});

test("renew with a new ttl keeps it; a failed renew loses the lease; releaseAll gives everything back", async () => {
	reset();
	const k = new core.LeaseKeeper({ everyMs: () => 60_000 });
	await k.acquire({ ttl: 600 });
	assert.equal((await k.renew("pool-1", 1200)).ttl, 1200);
	assert.equal(log().at(-1), "renew l-0123456789abcdef0123456789abcdef --ttl 1200");
	await assert.rejects(k.renew("pool-1", 30), /ttl must be/);
	writeFileSync(failRenew, "");
	await assert.rejects(k.renew("pool-1"), /is gone/);
	rmSync(failRenew);
	assert.equal(k.list().length, 0);

	await k.acquire({});
	assert.match(log().at(-1), /^acquire --ttl 1800 --wait 60$/);
	await k.releaseAll();
	assert.equal(log().at(-1), "release l-0123456789abcdef0123456789abcdef");
	assert.equal(k.list().length, 0);
	assert.equal(core.formatLeases([], null), "this session holds no leases");
});
