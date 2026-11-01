// Host lease policy. No process, filesystem, environment, shell, or SQLite imports.
// Store methods are synchronous transactions; side effects, locks, journal, clock and logging
// are injected so ordering and failure behavior can be tested without a hypervisor or subprocess.
export class LeaseWorkflows {
	constructor({ store, backend, journal, lock, reclaim, now, sleep, log }) {
		Object.assign(this, { store, backend, journal, lock, reclaim, now, sleep, log });
	}

	matches(name, gen, epoch, state) {
		const row = this.store.get(name); // storage errors propagate; they are not "stale"
		return row?.gen === Number(gen) && row.epoch === epoch && row.state === state;
	}

	async acquire({ holder, ttl = 1800, wait = 0, pubkey }) {
		const deadline = this.now() + wait;
		let reaped = false, claim;
		for (;;) {
			claim = this.store.claim(holder, ttl, pubkey);
			if (claim) break;
			if (!reaped) {
				reaped = true;
				// As before, a failed opportunistic reap does not conceal pool exhaustion.
				await this.reclaim().catch(() => {});
				continue;
			}
			if (this.now() >= deadline) {
				throw Object.assign(new Error("pool exhausted (no FREE VM)"), { exitCode: 4 });
			}
			await this.sleep(2000);
		}
		await this.lock(claim.name, "_lease_acquire", [claim.name, claim.gen, claim.epoch, pubkey]);
		this.log(`${claim.name} leased to ${holder} until ${new Date(claim.expires_at * 1000).toISOString()}`);
		return claim;
	}

	// Held-lock entry points. The runtime validates lock ownership before calling these.
	async install(name, gen, epoch, pubkey) {
		if (!this.matches(name, gen, epoch, "ACQUIRING")) throw new Error(`lease on ${name} changed while waiting for its lock`);
		const action = await this.journal.intent("acquire", [name, String(gen), epoch]);
		await this.backend.setKeys(name, pubkey);
		if (!this.store.commit(name, gen)) throw new Error(`lease on ${name} was fenced`);
		await this.journal.done(action);
	}

	async release(leaseId) {
		const row = this.store.find(leaseId);
		if (!row) throw new Error("unknown or inactive lease");
		await this.lock(row.name, "_lease_release", [leaseId]);
	}

	async releaseHeld(leaseId) {
		// Look up again after locking: a release cannot act on an old pre-lock observation.
		const row = this.store.beginReset(leaseId);
		await this.reset(row.name, row.gen, row.epoch);
	}

	async reset(name, gen, epoch) {
		if (!this.matches(name, gen, epoch, "RESETTING")) {
			this.log(`${name}: stale reset skipped`);
			return;
		}
		const action = await this.journal.intent("reset", [name, String(gen), epoch]);
		await this.backend.clearEdge(name);
		let healthy = false;
		try {
			await this.backend.restore(name, "boxery-clean");
			await this.backend.waitReady(name);
			await this.backend.stepClock(name);
			await this.backend.setKeys(name);
			healthy = true;
		} catch {
			// Backend/guest failures quarantine the VM. A failed DB commit below is different:
			// leave its durable intent intact so a successor can retry under the original locks.
		}
		const state = healthy ? "FREE" : "BROKEN";
		if (!this.store.finish(name, gen, state)) throw new Error(`${name}: reset commit failed`);
		this.log(healthy
			? `${name} reset → FREE`
			: `${name} reset FAILED → BROKEN (fix it, then: boxery-host pool rm ${name} && boxery-host pool add ${name})`);
		await this.journal.done(action);
	}

	async reapCandidates() {
		for (const row of this.store.candidates()) {
			await this.lock(row.name, "_reap_candidate", [row.name, row.gen, row.epoch]);
		}
	}

	async reapHeld(name, gen, epoch) {
		const [row] = this.store.due(name, gen, epoch); // rechecks deadline as well as generation/epoch
		if (!row) return;
		this.log(`reaping ${name} (${row.reason})`);
		await this.reset(name, row.gen, row.epoch);
	}
}
