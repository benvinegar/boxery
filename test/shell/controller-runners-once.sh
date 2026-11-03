#!/usr/bin/env bash
# Local runners (`boxery runners once`, docs/github-runners.md), offline: the controller with a stub gh (never
# GitHub) against a local host (fake backend, a stub ssh that plays the VM's boxery-runner). Checks that the
# JIT config goes controller → host → VM on stdin only (never argv), that the host never sees a GitHub
# credential, and that a finished job, Ctrl-C, a refused registration and a dead controller all end with
# the registration deleted (where the controller can) and the VM released and reset.
set -euo pipefail
node --disable-warning=ExperimentalWarning -e 'require("node:sqlite")' 2>/dev/null || { echo "SKIP: node:sqlite unavailable (need Node >= 22.13)"; exit 0; }
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host A=$ROOT/controller/boxery
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export HOME=$tmp/home BOXERY_CONF=$tmp/conf BOXERY_HOME=$tmp/ctl BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms BOXERY_PROXY_PORT=9999 \
	BOXERY_BOOT_ID=boot-1 BOXERY_SSH_WAIT_TRIES=2 BOXERY_RUNNERS_POLL=0.2 BOXERY_RUNNERS_TICK=1 GH_DIR=$tmp/gh
unset GH_HOST GH_TOKEN GITHUB_TOKEN
mkdir -p "$tmp/bin" "$HOME/.ssh" "$BOXERY_CONF" "$BOXERY_FAKE_DIR" "$GH_DIR"
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAImgmtmgmtmgmtmgmtmgmt mgmt@host" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"
echo "ssh-ed25519 AAAAme me@laptop" >"$HOME/.ssh/id_ed25519.pub"; touch "$HOME/.ssh/id_ed25519"
: >"$GH_DIR/argv"
# ssh: runs the command in the fake VM's home. boxery-runner (image/layers/github-runner.sh) is played here:
# start keeps its stdin (written atomically: the test polls for it), status reads .runner-done/.runner-started.
# A VM without .has-runner has no runner layer (status → 127).
cat >"$tmp/bin/ssh" <<STUB
#!/usr/bin/env bash
port=""; while [ \$# -gt 0 ]; do case \$1 in -p) port=\$2; shift 2 ;; -o|-F|-i) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
case "\$*" in *cloud-init*|*6080*) exit 0 ;; esac
for d in "$tmp/vms"/*/; do
	if [ "\$(cat "\$d/port" 2>/dev/null)" = "\$port" ]; then
		[ "\$(cat "\$d/state")" = running ] || exit 255
		mkdir -p "\$d/home"; h="\$d/home"; n=\$(basename "\$d")
		case "\$*" in
		*"boxery-runner "*) [ -e "$tmp/has-runner-\$n" ] || exit 127 ;;
		esac
		case "\$*" in
		*"boxery-runner start"*) cat >"\$h/.runner-jit.part" && mv "\$h/.runner-jit.part" "\$h/.runner-jit"; touch "\$h/.runner-started"; echo "start \$n" >>"$tmp/guest.log"; exit 0 ;;
		*"boxery-runner status"*) [ -e "\$h/.runner-done" ] && exit 1; [ -e "\$h/.runner-started" ] && exit 0; exit 2 ;;
		*"boxery-runner stop"*) echo "stop \$n" >>"$tmp/guest.log"; touch "\$h/.runner-done"; exit 0 ;;
		esac
		cd "\$h" && HOME="\$h" exec bash -c "\${*:-true}"
	fi
done
exit 255
STUB
# gh: never GitHub. Logs every call's argv; answers like `gh api`/`gh auth status`/`gh repo view` would.
cat >"$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_DIR/argv"
case "$1 ${2:-}" in
"auth status") [ ! -e "$GH_DIR/logged-out" ] || { echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1; }; exit 0 ;;
"repo view") echo "o/r"; exit 0 ;;
"api "*) ;;
*) echo "gh stub: unexpected: $*" >&2; exit 2 ;;
esac
shift; method=GET path=""
while [ $# -gt 0 ]; do case $1 in -X) method=$2; shift 2 ;; --input | --jq) shift 2 ;; *) path=$1; shift ;; esac; done
echo "$method $path" >>"$GH_DIR/calls"
case "$method $path" in
"POST repos/o/r/actions/runners/generate-jitconfig")
	cat >"$GH_DIR/body"
	[ ! -e "$GH_DIR/refuse" ] || { echo "gh: Resource not accessible by personal access token (HTTP 403)" >&2; exit 1; }
	echo "42 $(cat "$GH_DIR/jit")" ;;
"GET repos/o/r/actions/runners/42") if [ -e "$GH_DIR/busy" ]; then echo true; else echo false; fi ;;
"DELETE repos/o/r/actions/runners/42") [ ! -e "$GH_DIR/gone" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; } ;;
*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
esac
STUB
for c in systemctl launchctl; do printf '#!/bin/sh\nexit 3\n' >"$tmp/bin/$c"; done
chmod +x "$tmp/bin"/*
export PATH="$tmp/bin:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
home() { echo "$tmp/vms/$1/home"; }
state() { "$H" pool ls --json | jq -r --arg n "$1" '.[] | select(.name == $n) | .state'; }
holder() { "$H" ls --json | jq -r --arg n "$1" '.[] | select(.name == $n) | .lease.holder // "-"'; }
wait_for() { local _; for _ in $(seq 200); do if eval "$1"; then return 0; fi; sleep 0.1; done; echo "    (timed out: $1)"; return 1; }
# A JIT config shaped like GitHub's (base64 JSON of base64 files); a distinctive one per run.
jit() { node -e 'const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
	process.stdout.write(b({ ".runner": b({ AgentName: "x", DisableUpdate: false }), ".credentials": b({ secret: process.argv[1] }) }))' "$1" >"$GH_DIR/jit"; cat "$GH_DIR/jit"; }
# Every process's command line, sampled while the controller runs (the JIT config must never be in one).
sample_ps() { while kill -0 "$1" 2>/dev/null; do ps -A -ww -o args= >>"$tmp/ps.log" 2>/dev/null || true; sleep 0.05; done; }
reset_gh() { rm -f "$GH_DIR/busy" "$GH_DIR/gone" "$GH_DIR/refuse" "$GH_DIR/logged-out" "$GH_DIR/body" "$GH_DIR/calls"; }
# start_once ARGS…: the controller in the background, in its own process group (as a terminal's foreground
# job would be: Ctrl-C then reaches all of it). Sets pid; output in $tmp/out.
start_once() { set -m; "$A" runners once "$@" >"$tmp/out" 2>&1 & pid=$!; set +m; sample_ps "$pid" & }

"$H" build-base >/dev/null 2>&1
for n in ci-1 ci-2 pet; do "$H" new "$n" >/dev/null 2>&1; done
"$H" pool add ci-1 >/dev/null 2>&1; "$H" pool add pet >/dev/null 2>&1
touch "$tmp/has-runner-ci-1"
"$A" setup local --host-bin "$H" >/dev/null 2>&1 || bad "setup local"

echo "== gh is checked first"
nogh=$tmp/nogh; mkdir -p "$nogh"
# PATH without gh: every directory on PATH that has one is mirrored without it.
newpath=$nogh
IFS=: read -r -a dirs <<<"$PATH"
for d in "${dirs[@]}"; do
	if [ -x "$d/gh" ]; then m=$tmp/mirror$((${#newpath})); mkdir -p "$m"
		for f in "$d"/*; do [ "$(basename "$f")" = gh ] || ln -s "$f" "$m/" 2>/dev/null || true; done; newpath=$newpath:$m
	else newpath=$newpath:$d; fi
done
out=$(PATH=$newpath "$A" runners once --repo o/r 2>&1) && bad "ran without gh" || { [[ $out == *"install gh (https://cli.github.com)"* && $out == *"gh auth login"* ]] && ok "no gh: says to install it and log in" || bad "no gh: $out"; }
touch "$GH_DIR/logged-out"
out=$("$A" runners once --repo o/r 2>&1) && bad "ran logged out" || { [[ $out == *"gh is not logged in to github.com: run gh auth login"* ]] && ok "gh logged out: says to run gh auth login" || bad "logged out: $out"; }
reset_gh
[[ $(state ci-1) == free && ! -s $GH_DIR/calls ]] && ok "...before leasing anything or calling the API" || bad "leased or called: $(state ci-1) $(cat "$GH_DIR/calls" 2>/dev/null)"
out=$("$A" runners once --repo 'o/r;x' 2>&1) && bad "bad repo accepted" || { [[ $out == *"invalid repository"* ]] && ok "a bad --repo is refused" || bad "repo: $out"; }
out=$("$A" runners once --repo o/r --group 3 2>&1) && bad "--group with --repo accepted" || { [[ $out == *"--group is for --org"* ]] && ok "--group is for --org" || bad "group: $out"; }

echo "== a job: lease → JIT config → runner → job → release"
reset_gh; J1=$(jit run-one-secret)
start_once --labels gpu
wait_for '[ -e "$(home ci-1)/.runner-jit" ]' && ok "the runner started in ci-1" || bad "no runner: $(cat "$tmp/out")"
[[ $(holder ci-1) == github-runner-local && $(state pet) == free ]] && ok "ci-1 leased as github-runner-local; pet (no runner layer) left alone" || bad "lease: $(holder ci-1) pet=$(state pet)"
jq -e '.name | test("^boxery-local-ci-1-[0-9a-f]{6}$")' "$GH_DIR/body" >/dev/null && jq -e '.runner_group_id == 1 and .work_folder == "_work" and (.labels | .[0:2] == ["self-hosted","linux"] and index("boxery") != null and .[-1] == "gpu")' "$GH_DIR/body" >/dev/null \
	&& ok "generate-jitconfig: boxery-local-VM-… name, default labels + --labels, sent with gh (stdin body)" || bad "body: $(cat "$GH_DIR/body")"
node -e 'const j = JSON.parse(Buffer.from(require("fs").readFileSync(process.argv[1], "utf8"), "base64")); const r = JSON.parse(Buffer.from(j[".runner"], "base64"));
	process.exit(r.DisableUpdate === true && Buffer.from(j[".credentials"], "base64").includes("run-one-secret") ? 0 : 1)' "$(home ci-1)/.runner-jit" \
	&& ok "the VM got the JIT config, with self-update off" || bad "jit in VM: $(cat "$(home ci-1)/.runner-jit")"
wait_for 'grep -q "ready: a job with runs-on: \[self-hosted, boxery\] gets it" "$tmp/out"' && ok "says it is ready for a job" || bad "out: $(cat "$tmp/out")"
out=$("$H" runners status 2>&1) && [[ $out == *"ci-1"*"local runner (boxery runners once)"* ]] && ok "host runners status lists the local runner" || bad "status: $out"
touch "$GH_DIR/busy"
wait_for 'grep -q "is running a job" "$tmp/out"' && ok "notices the job (gh: busy)" || bad "busy: $(cat "$tmp/out")"
touch "$GH_DIR/gone" "$(home ci-1)/.runner-done"   # the job ends: a JIT runner deregisters itself
rc=0; wait "$pid" || rc=$?
[[ $rc == 0 ]] && grep -q "done: boxery-local-ci-1-.* ran its job; ci-1 is reset" "$tmp/out" && ok "exits 0 when the job is done" || bad "rc $rc: $(cat "$tmp/out")"
[[ $(state ci-1) == free && ! -e $(home ci-1)/.runner-jit ]] && ok "ci-1 released and reset" || bad "after: $(state ci-1) $(ls -a "$(home ci-1)")"
grep -q "DELETE repos/o/r/actions/runners/42" "$GH_DIR/calls" && ok "the registration is deleted (already gone: 404 is fine)" || bad "calls: $(cat "$GH_DIR/calls")"
if grep -qF "$J1" "$tmp/ps.log" "$GH_DIR/argv"; then bad "the JIT config was in a command line"; else ok "the JIT config was in no command line (ps, gh's argv)"; fi
! grep -rqF "$J1" "$BOXERY_CONF" && ok "...and in no file on the host" || bad "JIT config in $(grep -rlF "$J1" "$BOXERY_CONF")"

echo "== Ctrl-C while it waits: runner stopped, registration deleted, VM released"
reset_gh; J2=$(jit ctrl-c-secret); : >"$tmp/guest.log"; : >"$tmp/ps.log"
start_once
wait_for 'grep -q "Ctrl-C to stop" "$tmp/out"' || bad "not waiting: $(cat "$tmp/out")"
kill -INT -- -"$pid"   # what a terminal's Ctrl-C does: the whole foreground process group
rc=0; wait "$pid" || rc=$?
[[ $rc == 130 ]] && grep -q "stopping the runner and giving ci-1 back" "$tmp/out" && grep -q "==> stopped$" "$tmp/out" && ok "Ctrl-C: exits 130" || bad "rc $rc: $(cat "$tmp/out")"
grep -q "stop ci-1" "$tmp/guest.log" && ok "the runner was stopped" || bad "guest: $(cat "$tmp/guest.log")"
grep -q "DELETE repos/o/r/actions/runners/42" "$GH_DIR/calls" && grep -q "deleted runner registration boxery-local-ci-1-" "$tmp/out" && ok "its registration was deleted" || bad "calls: $(cat "$GH_DIR/calls")"
wait_for '[ "$(state ci-1)" = free ]' && [[ ! -e $(home ci-1)/.runner-jit ]] && ok "ci-1 released and reset" || bad "ci-1: $(state ci-1)"
if grep -qF "$J2" "$tmp/ps.log" "$GH_DIR/argv"; then bad "the JIT config was in a command line"; else ok "no JIT config in a command line"; fi

echo "== GitHub refuses the registration: the VM is given back"
reset_gh; touch "$GH_DIR/refuse"; jit refused >/dev/null
rc=0; out=$("$A" runners once 2>&1) || rc=$?
[[ $rc == 1 && $out == *"GitHub didn't register the runner: gh: Resource not accessible"* && $out == *"needs admin rights on repos/o/r"* ]] && ok "exits 1 with GitHub's reason (and --repo defaults to gh repo view)" || bad "rc $rc: $out"
wait_for '[ "$(state ci-1)" = free ]' && ! grep -q DELETE "$GH_DIR/calls" && ok "VM released; nothing to delete" || bad "after refuse: $(state ci-1) $(cat "$GH_DIR/calls")"

echo "== the controller dies: the host gives the VM back"
reset_gh; jit killed >/dev/null; : >"$tmp/guest.log"
start_once --repo o/r
wait_for 'grep -q "Ctrl-C to stop" "$tmp/out"' || bad "not waiting: $(cat "$tmp/out")"
kill -9 "$pid"; wait "$pid" 2>/dev/null || true
wait_for '[ "$(state ci-1)" = free ]' && grep -q "stop ci-1" "$tmp/guest.log" && ok "kill -9 of the controller: runner stopped, ci-1 released and reset" || bad "after kill: $(state ci-1) $(cat "$tmp/guest.log")"

echo "== no free runner VM"
reset_gh
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIleasekeyoneleasekeyone x" | "$H" acquire --holder github-runner --only ci-1 >/dev/null 2>&1 || bad "acquire for the host runners"
rc=0; out=$("$A" runners once 2>&1) || rc=$?
[[ $rc != 0 && $out == *"no free runner VM ("*"ci-1: leased to github-runner"*  && $out == *"boxery runners stop frees them"* && $out == *"--vms"* ]] && ok "says which VMs are taken, by whom, and what to do" || bad "rc $rc: $out"
! grep -q generate-jitconfig "$GH_DIR/calls" 2>/dev/null && ok "...without registering a runner" || bad "registered: $(cat "$GH_DIR/calls")"
rc=0; out=$("$A" runners once --vms ci-2 2>&1) || rc=$?
[[ $rc != 0 && $out == *"not pool VMs: ci-2"* ]] && ok "--vms must be pool VMs" || bad "rc $rc: $out"
rc=0; out=$("$A" runners once --vms pet 2>&1) || rc=$?
[[ $rc != 0 && $out == *"no pool VM here can run a runner (pet: no runner)"* && $out == *"--layers github-runner"* ]] && ok "a VM without the runner layer: says how to make one" || bad "rc $rc: $out"
[[ $(state pet) == free ]] && ok "...and pet was never leased (or reset)" || bad "pet: $(state pet)"

out=$("$A" help) && [[ $out == *"runners once [--repo OWNER/REPO | --org ORG]"*"local runner"*"runners status|start|stop|config|token   host runners"* ]] && ok "controller usage: local runners and host runners" || bad "usage"

echo "passed: $pass  failed: $fail"; ((fail == 0))
