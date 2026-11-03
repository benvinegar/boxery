import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// All locks and HOME paths belong to the temporary fixture, never the developer.
export function guestFixture(dir, { emulateFlock = process.platform === "darwin" } = {}) {
	const bin = path.join(dir, "bin"); mkdirSync(bin, { recursive: true });
	if (emulateFlock) {
		writeFileSync(path.join(bin, "flock"), `#!/usr/bin/env perl
use Fcntl qw(:flock F_SETFD);
if (@ARGV == 1 && $ARGV[0] =~ /^[0-9]+$/) {
    # grants use an fd opened by the parent bash; locking that same open description
    # keeps the lock in the parent after this helper exits.
    open(my $lock, '>>&=', $ARGV[0]) or die $!;
    flock($lock, LOCK_EX) or die $!;
    exit 0;
}
shift @ARGV; shift @ARGV; # -w 60 (tests use bounded barriers)
open(my $lock, '>>', shift @ARGV) or die $!;
fcntl($lock, F_SETFD, 0) or die $!; # retain the lock across exec
flock($lock, LOCK_EX) or die $!;
exec @ARGV or die $!;
`);
		chmodSync(path.join(bin, "flock"), 0o755);
	}
	if (process.platform === "darwin") {
		writeFileSync(path.join(bin, "stat"), '#!/bin/sh\nshift; shift; exec /usr/bin/stat -f %Lp "$@"\n');
		chmodSync(path.join(bin, "stat"), 0o755);
	}
	const preload = path.join(dir, "inject.mjs");
	writeFileSync(preload, `import fs from 'node:fs/promises'; import {writeSync} from 'node:fs';
if (process.env.EDIT_INJECT) await eval('(async()=>{' + process.env.EDIT_INJECT + '})()');\n`);
	return { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${preload}` };
}

export function fakeSSH(dir) {
	const file = path.join(dir, "bin/ssh");
	writeFileSync(file, `#!${process.execPath}
import {spawn} from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2), profile=path.dirname(args[args.indexOf('-F')+1]);
let input=''; for await (const chunk of process.stdin) input+=chunk;
const r=JSON.parse(input); r.path=r.path.replace('/home/agent',profile);
fs.appendFileSync(path.join(profile,'calls'),'edit\\n');
const child=spawn('bash',['-c',args.at(-1)],{detached:true,env:{...process.env,HOME:profile,NODE_OPTIONS:process.env.GUEST_NODE_OPTIONS},stdio:['pipe','inherit','inherit']});
for (const sig of ['SIGTERM','SIGHUP','SIGINT']) process.on(sig,()=>{try{process.kill(-child.pid,sig)}catch{}});
child.stdin.end(JSON.stringify(r)); child.on('exit',code=>{process.exitCode=code??1});
`);
	chmodSync(file, 0o755);
}

export function lockHeld(lock) {
	return execFileSync("perl", ["-MFcntl=:flock", "-e", 'open(my $f, ">>", $ARGV[0]) or die; print flock($f, LOCK_EX|LOCK_NB) ? "free" : "held"', lock], { encoding: "utf8" }) === "held";
}
