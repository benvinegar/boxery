#!/usr/bin/env bash
# Pinned VM ssh host keys (#70), offline: the controller's generated ssh_config (resolved by the real
# `ssh -G`), the host's known-hosts/pin commands against the fake backend, and a real ssh connection to a
# throwaway sshd on loopback that presents the wrong key. No VMs, no network beyond 127.0.0.1.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CLI=$ROOT/controller/boxery
H=$ROOT/host/boxery-host
REAL_SSH=$(command -v ssh) || { echo "SKIP: no ssh client"; exit 0; }
tmp=$(mktemp -d)
cleanup() { if [ -n "${sshd_pid:-}" ]; then kill "$sshd_pid" 2>/dev/null || true; fi; rm -rf "$tmp"; }
trap cleanup EXIT
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
export BOXERY_HOME="$tmp/ctl" HOME="$tmp/home" BOXERY_CONF="$tmp/hostconf" BOXERY_BACKEND=fake BOXERY_FAKE_DIR="$tmp/vms"
mkdir -p "$HOME/.ssh" "$BOXERY_CONF" "$tmp/bin"
ssh-keygen -q -t ed25519 -N "" -f "$HOME/.ssh/id_ed25519"
ssh-keygen -q -t ed25519 -N "" -f "$BOXERY_CONF/mgmt_ed25519"

# --- the controller's ssh_config for a host that pins keys (this checkout, local)
"$CLI" setup local --host-bin "$H" >/dev/null 2>&1 || { echo "setup failed" >&2; exit 1; }
P=$BOXERY_HOME/profiles/local
echo 'GRANT_CONFIRM=off' >>"$P/config" # offline automation fixture
G=$("$REAL_SSH" -F "$P/ssh_config" -G demo.boxery)
printf '%s\n' "$G" | grep -qx 'stricthostkeychecking true' && ok "ssh_config: StrictHostKeyChecking yes" || bad "strict: $(printf '%s\n' "$G" | grep stricthost)"
printf '%s\n' "$G" | grep -Fqx "knownhostscommand \"$H\" known-hosts %H" && ok "ssh_config: the host's pinned key via KnownHostsCommand known-hosts %H" || bad "knownhostscommand: $(printf '%s\n' "$G" | grep knownhostscommand)"
printf '%s\n' "$G" | grep -qx 'userknownhostsfile none' && printf '%s\n' "$G" | grep -qx 'globalknownhostsfile none' &&
	ok "ssh_config: no local known_hosts (never /dev/null, never ~/.ssh/known_hosts)" || bad "known_hosts files: $(printf '%s\n' "$G" | grep knownhostsfile)"
printf '%s\n' "$G" | grep -qx 'checkhostip no' && printf '%s\n' "$G" | grep -qx 'updatehostkeys false' && ok "ssh_config: CheckHostIP and UpdateHostKeys off" || bad "checkhostip/updatehostkeys"
! grep -q 'StrictHostKeyChecking no\|/dev/null' "$P/ssh_config" && ok "ssh_config: nothing accepts an unknown key" || bad "an accept-anything option is left: $(cat "$P/ssh_config")"
"$CLI" agent-forward demo on >/dev/null 2>&1
"$REAL_SSH" -F "$P/ssh_config" -G demo.boxery | grep -qx 'stricthostkeychecking true' && ok "...also for a VM with its own Host block (ssh-agent grant)" || bad "per-VM block lost strict checking"

# --- a host from before pinned keys: keep working (unverified), warn, and switch once it is upgraded
old="$tmp/oldhost"; mkdir -p "$old"
printf '#!/usr/bin/env bash\ncase $1 in help) echo "  connect NAME [PORT]" ;; add-key) cat >/dev/null ;; ls) : ;; *) : ;; esac\n' >"$old/boxery-host"; chmod +x "$old/boxery-host"
"$CLI" host add legacy local --host-bin "$old/boxery-host" >/dev/null 2>&1
L=$BOXERY_HOME/profiles/legacy
grep -q '^  StrictHostKeyChecking no$' "$L/ssh_config" && ! grep -q KnownHostsCommand "$L/ssh_config" && ok "older host: the old (unverified) ssh_config, so its VMs stay reachable" || bad "legacy ssh_config: $(cat "$L/ssh_config")"
w=$("$CLI" --host legacy ls 2>&1 >/dev/null) || true
printf '%s\n' "$w" | grep -q "doesn't pin VM ssh host keys yet.*upgrade-host" && ok "older host: commands warn and point at upgrade-host" || bad "no warning: $w"
w=$("$CLI" --host legacy ls 2>&1 >/dev/null) || true
[ -z "$w" ] && ok "...once a day, not on every command" || bad "warned again: $w"
cp "$H" "$old/boxery-host.real" 2>/dev/null || true
printf '#!/usr/bin/env bash\nexec %q "$@"\n' "$H" >"$old/boxery-host"
rm -f "$L/.host-pins-keys-checked"
"$CLI" --host legacy ls >/dev/null 2>&1 || true
grep -q '^  StrictHostKeyChecking yes$' "$L/ssh_config" && grep -q '^  KnownHostsCommand ' "$L/ssh_config" && ok "after upgrade-host: the next command rewrites ssh_config to verify keys" || bad "not refreshed: $(cat "$L/ssh_config")"

# --- host: known-hosts and pin against the fake backend
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/ssh"; chmod +x "$tmp/bin/ssh"   # fake guests answer every ssh
PATH="$tmp/bin:$PATH" "$H" build-base >/dev/null 2>&1
PATH="$tmp/bin:$PATH" BOXERY_SSH_WAIT_TRIES=2 "$H" new v1 >/dev/null 2>&1 || bad "new v1"
rec=$BOXERY_CONF/host-keys/v1
[ -f "$rec" ] && grep -Eq '^v1\.boxery ssh-ed25519 [A-Za-z0-9+/]+=*$' "$rec" && ok "new: the VM's host key is recorded (known_hosts line under v1.boxery)" || bad "record: $(cat "$rec" 2>&1)"
ud=$BOXERY_FAKE_DIR/v1/user-data
pub=$(awk '/path: \/etc\/ssh\/boxery_host_ed25519_key.pub$/{f=1} f&&/content:/{print $2; exit}' "$ud" | base64 -d)
awk '/path: \/etc\/ssh\/boxery_host_ed25519_key$/{f=1} f&&/content:/{print $2; exit}' "$ud" | base64 -d >"$tmp/k"; chmod 600 "$tmp/k"
[ "$(ssh-keygen -y -f "$tmp/k" | cut -d' ' -f1-2)" = "$(cut -d' ' -f2-3 "$rec")" ] && [ "$(printf '%s' "$pub" | cut -d' ' -f1-2)" = "$(cut -d' ' -f2-3 "$rec")" ] &&
	ok "the seed carries the matching private key (a valid OpenSSH key)" || bad "seed key doesn't match the record"
awk '/path: \/etc\/ssh\/sshd_config.d\/05-boxery-hostkey.conf$/{f=1} f&&/content:/{print $2; exit}' "$ud" | base64 -d | grep -qx 'HostKey /etc/ssh/boxery_host_ed25519_key' &&
	ok "...and an sshd drop-in that makes it sshd's only host key" || bad "drop-in"
grep -A3 'path: /etc/ssh/boxery_host_ed25519_key$' "$ud" | grep -q 'permissions: "0600"' && [ "$(stat -c %a "$ud" 2>/dev/null || stat -f %Lp "$ud")" = 600 ] &&
	ok "private key file 0600 in the guest; the seed file is 0600 on the host" || bad "permissions"
[ "$("$H" known-hosts v1)" = "$(cat "$rec")" ] && [ "$("$H" known-hosts v1.boxery)" = "$(cat "$rec")" ] && ok "known-hosts NAME (or NAME.boxery) prints the record" || bad "known-hosts"
[ -z "$("$H" known-hosts nope)" ] && ok "known-hosts for a VM without a record prints nothing (ssh refuses it)" || bad "known-hosts nope"
if "$H" known-hosts '../x' >/dev/null 2>&1; then bad "known-hosts accepted a bad name"; else ok "known-hosts rejects invalid names"; fi
first=$(cat "$rec")
PATH="$tmp/bin:$PATH" BOXERY_SSH_WAIT_TRIES=2 "$H" fork v1 v2 >/dev/null 2>&1 || bad "fork"
[ -f "$BOXERY_CONF/host-keys/v2" ] && [ "$(cut -d' ' -f2- "$BOXERY_CONF/host-keys/v2")" != "$(cut -d' ' -f2- "$rec")" ] && [ "$(cat "$rec")" = "$first" ] &&
	ok "fork: the fork gets its own key; the source keeps its record" || bad "fork keys"
PATH="$tmp/bin:$PATH" "$H" snap v1 s1 >/dev/null 2>&1; PATH="$tmp/bin:$PATH" BOXERY_SSH_WAIT_TRIES=2 "$H" revert v1 s1 >/dev/null 2>&1
[ "$(cat "$rec")" = "$first" ] && ok "revert keeps the VM's record (its image carries its key)" || bad "revert changed the record"
PATH="$tmp/bin:$PATH" "$H" rm v2 >/dev/null 2>&1
[ ! -e "$BOXERY_CONF/host-keys/v2" ] && ok "rm removes the record" || bad "rm left the record"
rm "$rec"
out=$("$H" pin v1 2>&1) && bad "pin without a trusted channel succeeded: $out" || { printf '%s\n' "$out" | grep -q -- "--from-guest" && ok "pin: no hypervisor channel → refuses and names --from-guest" || bad "pin message: $out"; }

# --- a real sshd on loopback presenting the wrong key is refused; the right one is accepted
SSHD=$(command -v sshd || ls /usr/sbin/sshd /usr/bin/sshd 2>/dev/null | head -1 || true)
if [ -n "$SSHD" ] && [ -x "$SSHD" ]; then
	d=$tmp/sshd; mkdir -p "$d"
	ssh-keygen -q -t ed25519 -N "" -f "$d/right"; ssh-keygen -q -t ed25519 -N "" -f "$d/wrong"
	cat "$HOME/.ssh/id_ed25519.pub" >"$d/authorized_keys"; chmod 600 "$d/authorized_keys"
	port=$((20000 + $$ % 20000))
	start_sshd() { # KEY
		if [ -n "${sshd_pid:-}" ]; then kill "$sshd_pid" 2>/dev/null || true; wait "$sshd_pid" 2>/dev/null || true; fi
		"$SSHD" -D -e -f /dev/null -o "ListenAddress=127.0.0.1:$port" -o "HostKey=$d/$1" -o "AuthorizedKeysFile=$d/authorized_keys" \
			-o StrictModes=no -o PidFile=none -o UsePAM=no -o "PasswordAuthentication=no" 2>"$d/log" &
		sshd_pid=$!
		for _ in $(seq 50); do (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && return 0; sleep 0.1; done
		return 1
	}
	printf 'demo.boxery %s\n' "$(cut -d' ' -f1-2 "$d/right.pub")" >"$BOXERY_CONF/host-keys/demo"
	run_ssh() { "$REAL_SSH" -F "$P/ssh_config" -o "ProxyCommand=nc 127.0.0.1 $port" -o ControlMaster=no -o ControlPath=none -o "User=$(id -un)" -o BatchMode=yes demo.boxery true 2>"$d/err"; }
	if start_sshd right && command -v nc >/dev/null; then
		run_ssh && ok "real ssh: the pinned key is accepted" || bad "pinned key refused: $(cat "$d/err" "$d/log")"
		start_sshd wrong
		if run_ssh; then bad "real ssh: a VM presenting another key was accepted"; else grep -q "REMOTE HOST IDENTIFICATION HAS CHANGED\|Host key verification failed" "$d/err" && ok "real ssh: a spoofed endpoint (another key) is refused" || bad "refused for another reason: $(cat "$d/err")"; fi
		rm "$BOXERY_CONF/host-keys/demo"
		if run_ssh; then bad "real ssh: a VM without a record was accepted"; else ok "real ssh: a VM without a pinned key is refused"; fi
	else echo "  - skipped the real-sshd checks (sshd or nc unavailable: $(tail -2 "$d/log" 2>/dev/null))"; fi
else echo "  - skipped the real-sshd checks (no sshd)"; fi

echo "passed: $pass  failed: $fail"; [ "$fail" = 0 ]
