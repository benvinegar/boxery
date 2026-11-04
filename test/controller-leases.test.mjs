// core/leases.mjs against a stub host: local records and keys, and the failure paths around them.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { registerHost } from "./fixtures/register-host.mjs";
import { LEASE_ID, grantTransport, hostCalls } from "./fixtures/grant-transport.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "boxery-cleases-"));
const home = path.join(dir, "home");
registerHost(home);
grantTransport(dir, [home]);
mkdirSync(path.join(dir, "bin"));
writeFileSync(path.join(dir, "bin/ssh"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(dir, "bin/ssh"), 0o755);
process.env.PATH = `${path.join(dir, "bin")}:${process.env.PATH}`;
process.env.BOXERY_HOME = home;
const leases = await import("../core/leases.mjs");
const leasesDir = path.join(home, "leases");
const statMode = (/** @type {string} */ f) => statSync(f).mode & 0o777;
const readdirNames = (/** @type {string} */ d) => (existsSync(d) ? readdirSync(d) : []);
const calls = () => hostCalls(dir).map((l) => l.slice(l.indexOf(": ") + 2));

beforeEach(() => {
	rmSync(leasesDir, { recursive: true, force: true });
	rmSync(path.join(dir, "host.calls"), { force: true });
	chmodSync(home, 0o755);
});

test("acquire keeps a 0600 record, the key and an ssh_config entry; release removes them", async () => {
	const r = await leases.acquireLease({ ttl: 600, holder: "me@test" });
	assert.deepEqual([r.name, r.id, r.ttl, r.holder], ["pool-1", LEASE_ID, 600, "me@test"]);
	assert.equal(readFileSync(path.join(home, "ssh_config"), "utf8").match(/^Host pool-1\.boxery\n {2}IdentityFile "(.*)"$/m)?.[1], path.join(leasesDir, `${LEASE_ID}.key`));
	const record = path.join(leasesDir, `${LEASE_ID}.lease`);
	assert.equal(readFileSync(record, "utf8"), `name=pool-1\nid=${LEASE_ID}\nexpires=${r.expires}\nttl=600\nholder=me@test\n`);
	assert.equal(statMode(record), 0o600);
	assert.equal(statMode(leasesDir), 0o700);
	assert.deepEqual(leases.leaseRows(r.expires - 10), [{ name: "pool-1", lease_id: LEASE_ID, expires_at: r.expires, expires_in: 10, ttl: 600, holder: "me@test" }]);
	assert.equal(leases.findLease("pool-1")?.id, LEASE_ID);
	await leases.releaseLease("pool-1");
	assert.deepEqual(readdirNames(leasesDir), []);
	assert.doesNotMatch(readFileSync(path.join(home, "ssh_config"), "utf8"), /pool-1\.boxery/);
	assert.equal(calls().at(-1), `release ${LEASE_ID}`);
});

test("a lease the host granted but this machine can't record is released, not stranded", { skip: process.getuid?.() === 0 && "root ignores the read-only directory" }, async () => {
	mkdirSync(leasesDir, { mode: 0o700 });
	// ssh_config can't be replaced: the setup after the host's acquire fails.
	chmodSync(home, 0o555);
	try {
		await assert.rejects(leases.acquireLease({ ttl: 600 }), /leased pool-1 but could not set it up on this machine .*released it again/s);
	} finally { chmodSync(home, 0o755); }
	assert.deepEqual(calls().map((c) => c.split(" ")[0]), ["acquire", "release"]);
	assert.equal(calls()[1], `release ${LEASE_ID}`);
	assert.deepEqual(readdirNames(leasesDir), [], "no record, key or half-made key left");
});

test("a renew answered after a release doesn't bring the record back", async () => {
	await leases.acquireLease({ ttl: 600 });
	// The host answers renew only after a release (another process) has removed the record.
	const hostbin = path.join(dir, "grant-host"), orig = readFileSync(hostbin, "utf8");
	writeFileSync(hostbin, orig.replace("renew) ", `renew) rm -f ${JSON.stringify(path.join(leasesDir, `${LEASE_ID}.lease`))}; `));
	try {
		await assert.rejects(leases.renewLease("pool-1", 900), /was released meanwhile/);
	} finally { writeFileSync(hostbin, orig); }
	assert.ok(!existsSync(path.join(leasesDir, `${LEASE_ID}.lease`)));
});

test("renew: unknown lease and bad ttl are local errors; a host failure is marked fromHost", async () => {
	await assert.rejects(leases.renewLease("nope"), /no local lease for 'nope'/);
	await leases.acquireLease({ ttl: 600 });
	await assert.rejects(leases.renewLease("pool-1", "9x"), /--ttl must be a number/);
	writeFileSync(path.join(dir, "renew-fails"), "");
	try {
		await assert.rejects(leases.renewLease("pool-1"), (e) => /** @type {any} */ (e).fromHost === true && /lease expired/.test(/** @type {Error} */ (e).message));
	} finally { rmSync(path.join(dir, "renew-fails")); }
	assert.equal((await leases.renewLease(LEASE_ID)).ttl, 600, "ttl defaults to the acquired one");
});
