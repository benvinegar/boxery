#!/usr/bin/env bash
# Exact boxery-host output against the fake backend: listing tables, JSON, usage and common errors.
# The controller parses this output without jq, so it must not change while the host moves to Node
# (docs/plans/2026-11-01-host-orchestration-in-node.md). Fake ports are deterministic (22000, 22001, …).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/conf BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms BOXERY_PROXY_PORT=9999 BOXERY_BOOT_ID=boot-1 BOXERY_SSH_WAIT_TRIES=1
mkdir -p "$tmp/bin" "$BOXERY_CONF"
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/ssh"; chmod +x "$tmp/bin/ssh"
echo "ssh-ed25519 AAAAtest mgmt" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"
export PATH="$tmp/bin:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
# run ARGS…: stdout → $tmp/out, stderr → $tmp/err (temp dir → TMP, timestamps → DATE), exit status → $rc
run() {
	rc=0; "$H" "$@" >"$tmp/out.raw" 2>"$tmp/err.raw" || rc=$?
	for f in out err; do sed -E -e "s#$tmp#TMP#g" -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}/DATE/g' -e 's/, [0-9]+s\)$/, Ns)/' -e 's/installed [0-9]+s after/installed Ns after/' "$tmp/$f.raw" >"$tmp/$f"; done
}
# same DESC FILE EXPECTED_RC: compare $tmp/FILE with $tmp/expected, and $rc with EXPECTED_RC
same() {
	if [[ $rc == "$3" ]] && diff -u "$tmp/expected" "$tmp/$2" >"$tmp/diff"; then ok "$1"
	else bad "$1 (exit $rc, wanted $3)"; sed 's/^/      /' "$tmp/diff"; fi
}
# err DESC MESSAGE ARGS…: the command fails with exit 1 and prints exactly MESSAGE on stderr, nothing on stdout
err() {
	local d=$1 m=$2; shift 2; run "$@"
	if [[ $rc == 1 && $(cat "$tmp/err") == "$m" && ! -s $tmp/out ]]; then ok "$d"
	else bad "$d: exit $rc, stderr: $(cat "$tmp/err"), stdout: $(head -c 200 "$tmp/out")"; fi
}

"$H" build-base >/dev/null 2>&1

echo "== new / stop"
run new a1 --cpus 2 --mem 2048 --disk 10
echo "a1 127.0.0.1:22000" >"$tmp/expected"; same "new prints NAME ADDR" out 0
cat >"$tmp/expected" <<'EOF'
==> a1 reachable at 127.0.0.1:22000; waiting for ssh + cloud-init
==> a1 ready (desktop, Ns)
EOF
same "new logs progress on stderr" err 0
run new b2
echo "b2 127.0.0.1:22001" >"$tmp/expected"; same "new with the default shape" out 0
run stop b2
echo "==> b2 shutting down" >"$tmp/expected"; same "stop logs on stderr" err 0

echo "== usage"
cat >"$tmp/expected" <<'EOF'
boxery-host — Ubuntu desktop VMs for coding agents (backend: fake)

  init [--backend libvirt|lima|cloud-hypervisor|exe|boat]  install proxy services + backend setup, symlinks
  --profile NAME COMMAND…   use a second profile on this host (~/.config/boxery-NAME): its own backend,
                            state, proxy port and services. Create it with: --profile NAME init --backend B
  profiles [--json]         the profiles on this host (backend, proxy port, service name, state directory)
  version [--json]          this install's version, commit and kind (git or npm)
  upgrade [--check] [--ref REF] [--wait S] [--reinit]
                            update this install (git pull --ff-only, or npm), re-run init for every
                            profile using it and check them; waits for in-flight operations, rolls back on failure
  build-base                build the golden desktop image (one-time; headless VMs don't need it)
  add-key < key.pub         authorize a controller's ssh key for new VMs
  new NAME [--shape S] [--cpus N --mem MiB --disk GiB] [--headless] [--cold]
                            --headless: no desktop; boots the stock image, no build-base needed
                            --cold: bypass any Boxery RAM-template fast-create path
  new NAME --template NAME  select a declared backend/profile template (no silent fallback)
  new NAME --from IMAGE     boot a new VM from an image (e.g. demo@s1; keeps its desktop or not)
  fork SRC DST... [--shape S] [--cpus N --mem MiB --disk GiB]
                            copy a VM (running or not) into new VMs with their own identity
                            (same size as SRC unless --shape or size flags are given)
  templates [--json]        backend/profile templates (ready, missing or on-demand)
  shapes [--json]           VM sizes (built-ins + TMP/conf/shapes.json; * = default)
  ls [--json] | ip NAME | start NAME | stop NAME | rm NAME
  resize NAME [--cpus N] [--mem MiB] [--disk GiB]
                            change a VM's size; a running VM is restarted. Disk only grows
  snap NAME [SNAP] | snaps NAME [--json] | snap-rm NAME SNAP | revert NAME SNAP | images [--json]
  connect NAME [PORT]       stdio to VM port (for ssh ProxyCommand)
  proxy-log [N]             recent LLM + edge proxy requests
  edge-set NAME [--lease ID] < routes.json   set the VM's edge credential routes (used by boxery grant http:…)

  pool add NAME | rm NAME [--force] | ls [--json]   shared pool of leasable VMs
  acquire --holder H [--ttl S] [--wait S]    lease a free pool VM (lease ssh pubkey on stdin)
  renew LEASE [--ttl S] | release LEASE | reap | reconcile
EOF
run help; same "help" out 0
run; same "no command → usage" out 0
run bogus; same "unknown command → usage, exit 1" out 1

echo "== listings"
cat >"$tmp/expected" <<'EOF'
NAME             STATE      SSH                DISK         SHAPE      KIND      LEASE
a1               running    127.0.0.1:22000    0.5/10GiB    custom     desktop   -
b2               shut off   -                  0.5/40GiB    standard   desktop   -
EOF
run ls; same "ls" out 0
cat >"$tmp/expected" <<'EOF'
[
{"name":"a1","state":"running","ssh_addr":"127.0.0.1:22000","disk_size":10,"disk_used":0.5,"tunnel":null,"lease":null,"shape":"custom","cpus":2,"mem":2048,"desktop":true},
{"name":"b2","state":"shut off","ssh_addr":null,"disk_size":40,"disk_used":0.5,"tunnel":null,"lease":null,"shape":"standard","cpus":4,"mem":8192,"desktop":true}
]
EOF
run ls --json; same "ls --json (one element per line)" out 0
cat >"$tmp/expected" <<'EOF'
SHAPE             CPUS   MEM_MIB  DISK_GIB
small                2      4096        20
standard *           4      8192        40
large                8     16384        80
EOF
run shapes; same "shapes" out 0
echo '{"default":"standard","shapes":{"small":{"cpus":2,"mem":4096,"disk":20},"standard":{"cpus":4,"mem":8192,"disk":40},"large":{"cpus":8,"mem":16384,"disk":80}}}' >"$tmp/expected"
run shapes --json; same "shapes --json" out 0
run snap a1 one
echo "==> snapshot a1@one" >"$tmp/expected"; same "snap logs on stderr" err 0
printf 'one\tDATE\t1MiB\n' >"$tmp/expected"
run snaps a1; same "snaps (tab-separated)" out 0
cat >"$tmp/expected" <<'EOF'
[
{"name":"one","created":"DATE","size":"1MiB"}
]
EOF
run snaps a1 --json; same "snaps --json" out 0
cat >"$tmp/expected" <<'EOF'
IMAGE                                    CREATED              SIZE
a1@one                                   DATE  1MiB
EOF
run images; same "images" out 0
run pool add a1
echo "==> a1 added to the pool (only lease holders can reach it now)" >"$tmp/expected"; same "pool add logs on stderr" err 0
cat >"$tmp/expected" <<'EOF'
NAME             LEASE      EXPIRES    HOLDER
a1               free       -          -
EOF
run pool ls; same "pool ls" out 0
run pool; same "pool (defaults to ls)" out 0
cat >"$tmp/expected" <<'EOF'
[
{"name":"a1","state":"free","holder":null,"acquired_at":null,"expires_at":null,"expires_in":null}
]
EOF
run pool ls --json; same "pool ls --json" out 0
echo 127.0.0.1 >"$tmp/expected"
run ip a1; same "ip" out 0
# VMs without a size record: ls asks the backend once and records it as a custom size. A VM whose size
# can't be read (b2: the fake backend has none) is listed with nulls, and the rest still list.
rm -rf "$BOXERY_CONF/vm-shapes"; mv "$BOXERY_FAKE_DIR/b2/size" "$tmp/b2.size"
cat >"$tmp/expected" <<'EOF'
[
{"name":"a1","state":"running","ssh_addr":"127.0.0.1:22000","disk_size":10,"disk_used":0.5,"tunnel":null,"lease":{"state":"free","holder":null,"expires_at":null},"shape":"custom","cpus":2,"mem":2048,"desktop":true},
{"name":"b2","state":"shut off","ssh_addr":null,"disk_size":null,"disk_used":0.5,"tunnel":null,"lease":null,"shape":null,"cpus":null,"mem":null,"desktop":true}
]
EOF
run ls --json; same "ls --json: pool lease object; sizes from the backend for VMs without a record, nulls if unreadable" out 0
echo '{"shape":null,"cpus":2,"mem":2048,"disk":10}' >"$tmp/expected"; cp "$BOXERY_CONF/vm-shapes/a1.json" "$tmp/a1.rec" 2>/dev/null || : >"$tmp/a1.rec"
same "...and records it as a custom size" a1.rec 0
[[ ! -e $BOXERY_CONF/vm-shapes/b2.json ]] && ok "...but records nothing for an unreadable size" || bad "b2 recorded: $(cat "$BOXERY_CONF/vm-shapes/b2.json")"
mv "$tmp/b2.size" "$BOXERY_FAKE_DIR/b2/size"
cat >"$tmp/expected" <<'EOF'
NAME             STATE      SSH                DISK         SHAPE      KIND      LEASE
a1               running    127.0.0.1:22000    0.5/10GiB    custom     desktop   free
b2               shut off   -                  0.5/40GiB    custom     desktop   -
EOF
run ls; same "ls: lowercase lease state; b2's size read and recorded once readable" out 0
mv "$BOXERY_FAKE_DIR/a1" "$tmp/a1.away"; mv "$BOXERY_FAKE_DIR/b2" "$tmp/b2.away"
echo "[]" >"$tmp/expected"
run ls --json; same "ls --json with no VMs → []" out 0
cat >"$tmp/expected" <<'EOF'
NAME             STATE      SSH                DISK         SHAPE      KIND      LEASE
EOF
run ls; same "ls with no VMs → header only" out 0
mv "$tmp/a1.away" "$BOXERY_FAKE_DIR/a1"; mv "$tmp/b2.away" "$BOXERY_FAKE_DIR/b2"

echo "== errors"
err "ip of a stopped VM" "boxery-host: b2 is not running" ip b2
err "snaps of a missing VM" "boxery-host: no such vm: nope" snaps nope --json
err "snaps with a bad flag" "boxery-host: usage: snaps NAME [--json]" snaps a1 bogus
err "invalid snapshot name" "boxery-host: invalid snapshot name 'x;id'" snap a1 'x;id'
err "non-numeric size" "boxery-host: --mem must be a number" new a3 --mem '1;id'
err "invalid VM name" "boxery-host: invalid VM name: A1" new A1
err "new without a name" "boxery-host: usage: new NAME [--shape S] [--cpus N] [--mem MiB] [--disk GiB] [--from IMAGE] [--headless]" new
err "connect to a non-ssh port" "boxery-host: connect: only the ssh port is supported (forward other ports over ssh)" connect a1 80
err "resize without sizes" "boxery-host: usage: resize NAME [--cpus N] [--mem MiB] [--disk GiB]" resize a1
err "revert without a snapshot" "boxery-host: usage: revert NAME SNAP" revert a1
err "rm of a missing VM" "boxery-host: no such vm: nope" rm nope
err "pool rm of a pet" "boxery-host: b2 is not a pool VM" pool rm b2
err "edge-set with no input" "boxery-host: edge-set: invalid routes (hosts must be DNS names; header names [A-Za-z0-9-]; no CR/LF)" edge-set a1 </dev/null
err "images with a bad flag" "boxery-host: usage: images [--json]" images bogus
err "shapes with an extra argument" "boxery-host: usage: shapes [--json]" shapes extra
err "ls with an extra argument" "boxery-host: usage: ls [--json]" ls extra
BOXERY_BACKEND=nope err "unknown backend" "boxery-host: unknown backend 'nope' (have: boat cloud-hypervisor exe fake libvirt lima )" ls

echo "== headless"
run new h3 --headless
echo "h3 127.0.0.1:22002" >"$tmp/expected"; same "new --headless prints NAME ADDR" out 0
cat >"$tmp/expected" <<'EOF'
==> h3 reachable at 127.0.0.1:22002; waiting for ssh + cloud-init (installing plumbing devtools)
==> h3: plumbing devtools installed Ns after create
==> h3 ready (headless, Ns)
EOF
same "new --headless logs the layers it installs" err 0
run ls --json
grep -F '"name":"h3"' "$tmp/out" >"$tmp/h3.json" || true
echo '{"name":"h3","state":"running","ssh_addr":"127.0.0.1:22002","disk_size":40,"disk_used":0.5,"tunnel":null,"lease":null,"shape":"standard","cpus":4,"mem":8192,"desktop":false}' >"$tmp/expected"
same "ls --json: a headless VM has desktop false" h3.json 0
run ls
grep '^h3 ' "$tmp/out" >"$tmp/h3.txt" || true
echo "h3               running    127.0.0.1:22002    0.5/40GiB    standard   headless  -" >"$tmp/expected"
same "ls: KIND headless" h3.txt 0
run snap h3 hs
"$H" new h4 --from h3@hs --headless >/dev/null 2>&1 && ok "new --from a headless image with --headless" || bad "new --from headless image"
err "a desktop image can't become headless" "boxery-host: a1@one has a desktop, and a VM made from an image keeps it (drop --headless)" new h5 --from a1@one --headless

echo; echo "passed: $pass  failed: $fail"; ((fail == 0))
