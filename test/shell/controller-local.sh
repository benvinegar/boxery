#!/usr/bin/env bash
# Controller in local mode against the fake backend: setup, new/ls/rm, grants storage + apply script.
# shellcheck disable=SC1090,SC2154  # sources the generated env.sh under test (vars come from it)
# The "VM" is a local directory; an ssh stub executes remote scripts locally with HOME=that dir.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
A=$ROOT/controller/boxery
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/hostconf BOXERY_HOME=$tmp/ctl BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms
export BOXERY_RUNTIME_DIR=$tmp/run
HOSTBIN=$ROOT/host/boxery-host P=$BOXERY_HOME/profiles/local # `setup local` registers host "local" here
# Keep git's "global" config inside the fake VM home: never touch the real ~/.config/git/config.
export XDG_CONFIG_HOME=$tmp/xdg GIT_CONFIG_NOSYSTEM=1; unset GIT_CONFIG_GLOBAL
mkdir -p "$tmp/bin" "$BOXERY_CONF" "$tmp/run" "$tmp/home/.ssh"
echo "ssh-ed25519 AAAAtest mgmt" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"
echo "ssh-ed25519 AAAAme me@laptop" >"$tmp/home/.ssh/id_ed25519.pub"; touch "$tmp/home/.ssh/id_ed25519"
# ssh stub: control-master ops succeed; "NAME.boxery 'bash -s'" runs the script locally in the VM dir.
cat >"$tmp/bin/ssh" <<STUB
#!/usr/bin/env bash
for a in "\$@"; do case \$a in -O) exit 0 ;; esac; done
host=""; port=""; while [ \$# -gt 0 ]; do case \$1 in -p) port=\$2; shift 2 ;; -F|-o|-i) shift 2 ;; *.boxery) host=\${1%.boxery}; shift; break ;; agent@*) shift; break ;; *) shift ;; esac; done
if [ -z "\$host" ] && [ -n "\$port" ]; then for d in $tmp/vms/*/; do [ "\$(cat "\$d/port" 2>/dev/null)" = "\$port" ] && host=\$(basename "\$d"); done; fi
case "\$*" in *cloud-init*|*6080*|*boxery-provision*) exit 0 ;; esac
[ -n "\$host" ] || exit 0
vm=$tmp/vms/\$host; [ -d "\$vm" ] || { echo "no such vm" >&2; exit 255; }
mkdir -p "\$vm/home/project/.git/info"
cd "\$vm/home" && HOME="\$vm/home" exec bash -c "\${*:-true}"
STUB
chmod +x "$tmp/bin/ssh"; export PATH="$tmp/bin:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }

HOME=$tmp/home "$A" setup local --host-bin "$HOSTBIN" >/dev/null 2>&1 && ok "setup local" || bad "setup local"
[ "$(cat "$BOXERY_HOME/default-host")" = local ] && ok "the first host becomes the default" || bad "default-host"
grep -q "^HOST='local'" "$P/config" && ok "config records HOST=local" || bad "config"
grep -q "ProxyCommand \"$ROOT/host/boxery-host\" connect %h %p" "$P/ssh_config" && ok "ProxyCommand runs boxery-host directly" || bad "ProxyCommand: $(grep ProxyCommand "$P/ssh_config")"
grep -q AAAAme "$BOXERY_CONF/authorized_keys" && ok "setup registered the key with the local host" || bad "key not registered"
"$HOSTBIN" build-base >/dev/null 2>&1
"$A" new w1 >/dev/null 2>&1 && ok "new via local host" || bad "new"
"$A" ls 2>/dev/null | grep -q '^w1 ' && ok "ls shows the VM with GRANTS column" || bad "ls"
"$A" new w2 --shape small --cpus 3 >/dev/null 2>&1 && [ "$(cat "$tmp/vms/w2/size")" = "3 4096 20" ] && ok "new --shape + size flag passed to the host" || bad "new --shape: $(cat "$tmp/vms/w2/size" 2>&1)"
"$A" fork w2 w3 >/dev/null 2>&1 && [ "$(cat "$tmp/vms/w3/size")" = "3 4096 20" ] && ok "fork keeps the source's size" || bad "fork size: $(cat "$tmp/vms/w3/size" 2>&1)"
"$A" ls --json | jq -e '.[] | select(.name == "w2") | .shape == "custom" and .cpus == 3' >/dev/null && ok "ls --json has shape fields" || bad "ls shape: $("$A" ls --json)"
"$A" shapes --json | jq -e '.default == "standard" and .shapes.large.cpus == 8' >/dev/null && ok "shapes --json via controller" || bad "shapes: $("$A" shapes --json 2>&1)"
if "$A" new w4 --shape 'x;id' >/dev/null 2>&1; then bad "invalid --shape accepted"; else ok "invalid --shape rejected by the controller"; fi
"$A" new hc --headless >/dev/null 2>&1 && [ "$(cat "$tmp/vms/hc/from")" = stock ] && ok "new --headless passed to the host" || bad "new --headless"
"$A" ls --json | grep '"name":"hc"' | grep -q '"desktop":false,"grants":' && ok "ls --json: desktop false, with grants" || bad "ls --json headless: $("$A" ls --json)"
"$A" ls | grep -q '^hc .* headless ' && ok "ls shows KIND" || bad "ls KIND: $("$A" ls)"
"$A" rm hc >/dev/null 2>&1 || true
if "$A" shapes bogus >/dev/null 2>&1; then bad "shapes bogus accepted"; else ok "shapes rejects extra args"; fi
"$A" rm w2 >/dev/null 2>&1; "$A" rm w3 >/dev/null 2>&1

printf 'SECRET_FILE=1\n' >"$tmp/dev.env"
export MY_TOKEN='va lue $with "quotes"'
"$A" grant w1 ssh-agent env:MY_TOKEN env:FROM_CMD --cmd 'echo computed' "file:$tmp/dev.env=project/.env" >/dev/null 2>&1 && ok "grant" || bad "grant"
! grep -q 'va lue' "$P/grants/w1" && ok "grant store holds names, not values" || bad "value leaked into grant store"
grep -q '^Host w1.boxery' "$P/ssh_config" && ok "ssh-agent grant → ForwardAgent for that VM" || bad "ForwardAgent"
envsh=$tmp/run/boxery/env.sh
[[ -f $envsh ]] && (unset MY_TOKEN; . "$envsh"; [[ $MY_TOKEN == 'va lue $with "quotes"' && $FROM_CMD == computed ]]) && ok "env values pushed and shell-safe" || bad "env.sh: $(cat "$envsh" 2>/dev/null)"
link=$tmp/vms/w1/home/project/.env
[[ -L $link ]] && grep -q SECRET_FILE "$link" && ok "file grant linked into project" || bad "file link"
grep -qx '/.env' "$tmp/vms/w1/home/project/.git/info/exclude" && ok "file grant git-excluded" || bad "exclude"
"$A" grants w1 --json | jq -e --arg l "$tmp/dev.env" '. == [{kind: "ssh-agent"}, {kind: "env", var: "MY_TOKEN", cmd: null}, {kind: "env", var: "FROM_CMD", cmd: "echo computed"}, {kind: "file", local: $l, remote: "/home/agent/project/.env"}]' >/dev/null && ok "grants --json" || bad "grants --json: $("$A" grants w1 --json)"
"$A" ls --json | jq -e '.[] | select(.name == "w1") | .state == "running" and (.grants | map(.kind) == ["ssh-agent", "env", "env", "file"])' >/dev/null && ok "ls --json merges local grants" || bad "ls --json: $("$A" ls --json)"
"$A" revoke w1 env:MY_TOKEN "file:$tmp/dev.env" >/dev/null 2>&1
if (unset MY_TOKEN; . "$envsh"; [[ -z ${MY_TOKEN:-} && $FROM_CMD == computed ]]) && [[ ! -e $link && ! -L $link ]]; then ok "revoke removes exactly the revoked items"; else bad "revoke: env=$(cat "$envsh") link=$(ls -la "$link" 2>&1)"; fi
# resize restarts the VM, which empties its tmpfs: the controller must push the grants again
rm -f "$envsh"
"$A" resize w1 --cpus 2 --mem 4096 >/dev/null 2>&1 && [[ $(cut -d' ' -f1,2 "$tmp/vms/w1/size") == "2 4096" ]] && ok "resize via the controller" || bad "resize: $(cat "$tmp/vms/w1/size")"
[[ -f $envsh ]] && (. "$envsh"; [[ $FROM_CMD == computed ]]) && ok "resize pushes the VM's grants again" || bad "grants not re-applied after resize"
if "$A" resize 'bad;name' --cpus 2 >/dev/null 2>&1; then bad "resize accepted an invalid VM name"; else ok "resize rejects an invalid VM name"; fi
if "$A" grant w1 env:1BAD >/dev/null 2>&1; then bad "invalid env name accepted"; else ok "invalid env name rejected"; fi
if "$A" grant w1 file:/nonexistent >/dev/null 2>&1; then bad "missing file accepted"; else ok "missing file rejected"; fi
if "$A" grant w1 "file:$tmp/dev.env=../../etc/x" >/dev/null 2>&1; then bad "path traversal accepted"; else ok "remote path traversal rejected"; fi
# Every apply re-reads granted files: a symlink re-pointed after approval at keys or boxery's own
# state is skipped (and its old copy removed); a key file the user names directly is still sent.
G() { HOME=$tmp/home "$A" "$@"; }
mkdir -p "$tmp/home/.pi/agent" "$tmp/benign"
printf 'PLAIN=1\n' >"$tmp/plain.env"; printf 'BENIGN\n' >"$tmp/benign/id_ed25519"
printf 'PRIVATE-SSH\n' >"$tmp/home/.ssh/id_ed25519"; printf 'MGMT-KEY\n' >"$BOXERY_CONF/mgmt_ed25519"; printf 'PI-AUTH\n' >"$tmp/home/.pi/agent/auth.json"
ln -s "$tmp/plain.env" "$tmp/swap.env"; ln -s "$tmp/benign" "$tmp/kdir"
G grant w1 "file:$tmp/swap.env=project/swap.env" "file:$tmp/kdir/id_ed25519=project/kd" >/dev/null 2>&1
swap=$tmp/vms/w1/home/project/swap.env kd=$tmp/vms/w1/home/project/kd
grep -q PLAIN "$swap" && grep -q BENIGN "$kd" && ok "file grants through symlinks are applied" || bad "symlinked file grant: $(cat "$swap" "$kd" 2>&1)"
for target in "$tmp/home/.ssh/id_ed25519" "$BOXERY_CONF/mgmt_ed25519" "$tmp/home/.pi/agent/auth.json"; do
	ln -sfn "$target" "$tmp/swap.env"
	out=$(G grants w1 apply 2>&1)
	if [[ $out == *"swap.env: now leads through a symlink"*skipped* ]] && ! grep -qs -e PRIVATE -e MGMT -e PI-AUTH "$swap"; then ok "re-pointed symlink to ${target#"$tmp"/} skipped"
	else bad "re-pointed symlink to $target: $out / $(cat "$swap" 2>&1)"; fi
done
ln -sfn "$tmp/home/.ssh" "$tmp/kdir"
out=$(G grants w1 apply 2>&1)
[[ $out == *"kdir/id_ed25519: now leads through a symlink"*skipped* ]] &&! grep -qs PRIVATE "$kd" && ok "re-pointed directory symlink to ~/.ssh skipped" || bad "directory swap: $out / $(cat "$kd" 2>&1)"
G grant w1 "file:$tmp/home/.ssh/id_ed25519.pub=project/me.pub" >/dev/null 2>&1
grep -q AAAAme "$tmp/vms/w1/home/project/me.pub" && ok "a key file the user grants by name is still applied" || bad "explicit ~/.ssh grant not applied"
G revoke w1 "file:$tmp/swap.env" "file:$tmp/kdir/id_ed25519" "file:$tmp/home/.ssh/id_ed25519.pub" >/dev/null 2>&1
printf '#!/bin/sh\nprintf "pi\\t2\\t1700000000\\t1\\nweird \\"name\\t1\\t1700000001\\t0\\n"\n' >"$tmp/bin/tmux"; chmod +x "$tmp/bin/tmux"
"$A" sessions w1 --json | jq -e '. == [{name: "pi", windows: 2, created: 1700000000, attached: true}, {name: "weird \"name", windows: 1, created: 1700000001, attached: false}]' >/dev/null && ok "sessions --json (names escaped)" || bad "sessions --json: $("$A" sessions w1 --json 2>&1)"
printf '#!/bin/sh\nexit 1\n' >"$tmp/bin/tmux"
[ "$("$A" sessions w1 --json)" = '[]' ] && ok "sessions --json with no tmux server → []" || bad "sessions --json empty: $("$A" sessions w1 --json 2>&1)"
rm -f "$tmp/bin/tmux"
[ "$("$A" leases --json)" = '[]' ] && ok "leases --json with none → []" || bad "leases --json empty"
[ "$("$A" grants nogrants --json)" = '[]' ] && ok "grants --json with none → []" || bad "grants --json empty"
"$A" snap w1 s1 >/dev/null 2>&1; [ "$("$A" snaps w1 --json | jq -c 'map({name})')" = '[{"name":"s1"}]' ] && ok "snaps --json via controller" || bad "snaps --json: $("$A" snaps w1 --json 2>&1)"
"$A" rm w1 >/dev/null 2>&1 && [[ ! -f $P/grants/w1 ]] && ! grep -q '^Host w1.boxery' "$P/ssh_config" && ok "rm clears grants + ForwardAgent" || bad "rm cleanup"

# --- edge (http:) grants: secret goes to the host proxy's route file, never into the VM
"$A" new e1 >/dev/null 2>&1
mkdir -p "$tmp/vms/e1/home/.boxery"; printf 'e1:tok123' >"$tmp/vms/e1/home/.boxery/token"
export EDGE_SECRET='ghp_EDGESECRET42'
"$A" grant e1 github --cmd 'printf %s "$EDGE_SECRET"' http:registry.npmjs.org --cmd 'echo npm_EDGE2' http:api.example.com --auth header:X-Api-Key --cmd 'echo k3y' --readonly >/dev/null 2>&1 && ok "grant http + github preset" || bad "grant http: $("$A" grant e1 github --cmd 'printf %s "$EDGE_SECRET"' 2>&1)"
routes=$BOXERY_CONF/edge/e1.json
[[ -f $routes ]] && ok "edge routes written on the host" || bad "no $routes"
[[ $(stat -c %a "$routes" 2>/dev/null || stat -f %Lp "$routes") == 600 ]] && ok "route file is 0600" || bad "route mode"
want_basic="Basic $(printf 'x-access-token:%s' "$EDGE_SECRET" | base64 | tr -d '\n')"
[[ $(jq -r '.hosts["github.com"].headers.Authorization' "$routes") == "$want_basic" ]] && ok "github.com: basic x-access-token" || bad "github.com header: $(jq -c . "$routes")"
[[ $(jq -r '.hosts["api.github.com"].headers.Authorization' "$routes") == "Bearer $EDGE_SECRET" ]] && ok "api.github.com: bearer" || bad "api.github.com header"
[[ $(jq -r '.hosts["api.example.com"].headers["X-Api-Key"]' "$routes") == k3y && $(jq -r '.hosts["api.example.com"].readonly' "$routes") == true ]] && ok "custom header + readonly" || bad "api.example.com route"
! grep -rqs -e "$EDGE_SECRET" -e npm_EDGE2 -e k3y "$tmp/vms/e1" "$tmp/run" && ok "no edge secret anywhere in the VM (disk or tmpfs)" || bad "edge secret leaked into the VM: $(grep -rls -e "$EDGE_SECRET" "$tmp/vms/e1" "$tmp/run")"
! grep -qs -e "$EDGE_SECRET" "$P/grants/e1" && ok "grant store holds the command, not the value" || bad "value in grant store"
(. "$envsh"; [[ $BOXERY_EDGE == http://127.0.0.1:8088/edge/e1%3Atok123 && $npm_config_registry == "$BOXERY_EDGE/registry.npmjs.org/" ]]) && ok "BOXERY_EDGE + npm registry exported" || bad "env.sh: $(cat "$envsh")"
gc=$tmp/run/boxery/gitconfig
grep -q 'insteadOf = https://github.com/' "$gc" && grep -q '/edge/e1%3Atok123/github.com/' "$gc" && ok "git insteadOf for github.com" || bad "gitconfig: $(cat "$gc" 2>/dev/null)"
HOME=$tmp/vms/e1/home git config --global --get-all include.path | grep -qxF "$gc" && ok "gitconfig included once" || bad "include.path"
"$A" grants e1 apply --quiet >/dev/null 2>&1; [[ $(HOME=$tmp/vms/e1/home git config --global --get-all include.path | grep -c .) == 1 ]] && ok "re-apply does not duplicate the include" || bad "include duplicated"
"$A" grants e1 | grep -q 'http:github.com.*basic:x-access-token' && ok "grants lists http routes" || bad "grants output"
"$A" grants e1 --json | jq -e '(map(select(.kind == "http")) | map(.host) == ["github.com", "api.github.com", "registry.npmjs.org", "api.example.com"]) and (.[0].auth == "basic:x-access-token") and (.[3] | .auth == "header:X-Api-Key" and .readonly == true and .cmd == "echo k3y") and (.[0].readonly == false)' >/dev/null && ok "grants --json lists http routes (no secret)" || bad "grants --json http: $("$A" grants e1 --json)"
! "$A" grants e1 --json | grep -q "$EDGE_SECRET" && ok "grants --json never prints the secret" || bad "secret in grants --json"
for badspec in http:127.0.0.1 http:localhost http:api.example.com:8443 http:https://x.com http:x.com/path "http:a b.com" http:-x.com; do
	if "$A" grant e1 "$badspec" --cmd 'echo x' >/dev/null 2>&1; then bad "accepted $badspec"; else ok "rejected $badspec"; fi
done
if "$A" grant e1 http:ok.example.com >/dev/null 2>&1; then bad "http grant without --cmd accepted"; else ok "http grant requires --cmd"; fi
if "$A" grant e1 http:ok.example.com --auth header:Host --cmd 'echo x' >/dev/null 2>&1; then bad "header:Host accepted"; else ok "reserved header names rejected"; fi
if "$A" grant e1 env:X --readonly >/dev/null 2>&1; then bad "--readonly on env accepted"; else ok "--readonly only for http"; fi
"$A" revoke e1 github >/dev/null 2>&1
[[ $(jq -r '.hosts | keys | join(",")' "$routes") == api.example.com,registry.npmjs.org ]] && ok "revoke github drops both hosts" || bad "after revoke: $(jq -c .hosts "$routes")"
! grep -q 'github.com' "$gc" && ok "revoke removes the git rewrite" || bad "gitconfig still has github"
"$A" revoke e1 all >/dev/null 2>&1; "$A" grants e1 apply --quiet >/dev/null 2>&1
[[ ! -f $routes ]] && ok "revoke all clears the host routes" || bad "routes left: $(cat "$routes")"
# --- llm: grants: the host proxy refuses every LLM route unless the VM's grants list the provider
"$A" grant e1 llm:chatgpt llm:ollama >/dev/null 2>&1 && ok "grant llm:chatgpt llm:ollama" || bad "grant llm: $("$A" grant e1 llm:chatgpt 2>&1)"
[[ $(jq -c '.llm' "$routes" 2>/dev/null) == '["chatgpt","ollama"]' && $(jq -c '.hosts' "$routes") == '{}' ]] && ok "llm grants reach the host's edge file (no http routes needed)" || bad "llm routes: $(cat "$routes" 2>/dev/null)"
"$A" grants e1 --json | jq -e 'map(select(.kind == "llm") | .provider) == ["chatgpt", "ollama"]' >/dev/null && ok "grants --json lists llm grants" || bad "grants --json llm: $("$A" grants e1 --json)"
"$A" grants e1 | grep -q 'llm:chatgpt' && "$A" ls | grep '^e1 ' | grep -q 'llm:chatgpt,llm:ollama' && ok "grants and ls show llm grants" || bad "llm in grants/ls"
for badspec in llm: llm:gemini llm:ChatGPT "llm:chatgpt x"; do
	if "$A" grant e1 "$badspec" >/dev/null 2>&1; then bad "accepted $badspec"; else ok "rejected $badspec"; fi
done
if "$A" grant e1 llm:openai --cmd 'echo k' >/dev/null 2>&1; then bad "llm grant with --cmd accepted"; else ok "llm grants take no --cmd (credential is on the host)"; fi
"$A" grant e1 http:api.example.com --cmd 'echo v' >/dev/null 2>&1
[[ $(jq -c '.llm' "$routes") == '["chatgpt","ollama"]' && $(jq -r '.hosts | keys | join(",")' "$routes") == api.example.com ]] && ok "llm and http grants share the edge file" || bad "mixed: $(cat "$routes")"
"$A" revoke e1 llm:chatgpt >/dev/null 2>&1
[[ $(jq -c '.llm' "$routes") == '["ollama"]' ]] && ok "revoke llm:chatgpt" || bad "after revoke: $(cat "$routes")"
"$A" revoke e1 http:api.example.com >/dev/null 2>&1
[[ $(jq -c '.llm' "$routes") == '["ollama"]' && $(jq -c '.hosts' "$routes") == '{}' ]] && ok "revoking the last http grant keeps llm grants" || bad "after http revoke: $(cat "$routes" 2>/dev/null)"
"$A" revoke e1 llm:ollama >/dev/null 2>&1
[[ ! -f $routes ]] && ok "revoking the last llm grant clears the host file (no LLM access)" || bad "llm file left: $(cat "$routes")"
"$A" new e2 --grant llm:anthropic >/dev/null 2>&1; [[ $(jq -c '.llm' "$BOXERY_CONF/edge/e2.json" 2>/dev/null) == '["anthropic"]' ]] && ok "new --grant llm:anthropic" || bad "new --grant llm: $(cat "$BOXERY_CONF/edge/e2.json" 2>/dev/null)"
"$A" rm e2 >/dev/null 2>&1; [[ ! -f $BOXERY_CONF/edge/e2.json ]] && ok "rm clears llm grants" || bad "llm grants survived rm"

"$A" grant e1 http:api.example.com --cmd 'echo v' >/dev/null 2>&1
"$A" rm e1 >/dev/null 2>&1; [[ ! -f $routes ]] && ok "rm deletes edge routes" || bad "routes survived rm"

# --- leases from the controller (local mode → fake backend)
if node --disable-warning=ExperimentalWarning -e 'require("node:sqlite")' 2>/dev/null; then
"$A" new lp1 >/dev/null 2>&1
BOXERY_SSH_WAIT_TRIES=2 "$HOSTBIN" pool add lp1 >/dev/null 2>&1 && ok "pool add via host" || bad "pool add"
out=$("$A" acquire --ttl 600 2>/dev/null) && set -- $out && [ "$1" = lp1 ] && ok "acquire → $1 $2" || bad "acquire: $out"
lid=${2:-x}
[ -f "$P/leases/$lid.lease" ] && [ -f "$P/leases/$lid.key" ] && ok "lease record + private key stored locally" || bad "local lease files"
[ "$(stat -c %a "$P/leases" 2>/dev/null || stat -f %Lp "$P/leases")" = 700 ] && ok "leases dir is 0700" || bad "leases dir perms"
grep -A2 "^Host lp1.boxery" "$P/ssh_config" | grep -Fq "IdentityFile \"$P/leases/$lid.key\"" && ok "ssh_config uses the lease key for lp1" || bad "ssh_config lease identity"
grep -q "boxery-lease" "$tmp/vms/lp1/home/.ssh/authorized_keys" && ok "lease key authorized in the VM" || bad "lease key not in VM"
"$A" leases | grep -q "^lp1 " && ok "leases lists it" || bad "leases"
"$A" leases --json | jq -e --arg i "$lid" 'length == 1 and .[0].name == "lp1" and .[0].lease_id == $i and .[0].ttl == 600 and .[0].expires_in > 0 and (.[0].holder | type) == "string"' >/dev/null && ok "leases --json" || bad "leases --json: $("$A" leases --json)"
"$A" renew lp1 >/dev/null 2>&1 && ok "renew by name" || bad "renew"
if "$A" acquire >/dev/null 2>&1; then bad "second acquire on a 1-VM pool succeeded"; else ok "pool exhausted for a second acquire"; fi
"$A" release lp1 >/dev/null 2>&1 && ok "release" || bad "release"
[ ! -f "$P/leases/$lid.lease" ] && [ ! -f "$P/leases/$lid.key" ] && ok "release forgets the lease and deletes its key" || bad "lease files left"
! grep -q "^Host lp1.boxery" "$P/ssh_config" && ok "ssh_config entry removed" || bad "ssh_config entry left"
! grep -q "boxery-lease" "$tmp/vms/lp1/home/.ssh/authorized_keys" && ok "VM no longer accepts the old lease key" || bad "old lease key still authorized"
"$A" acquire >/dev/null 2>&1 && ok "VM can be acquired again after release" || bad "re-acquire"
else echo "  - node:sqlite unavailable; skipping lease checks"; fi

# --- fork from the controller: forks are pets with their own grants (none, unless --grants)
"$A" new fk >/dev/null 2>&1
"$A" grant fk ssh-agent env:FROM_CMD --cmd 'echo computed' >/dev/null 2>&1
echo fork-me >"$tmp/vms/fk/home/project/f.txt"
"$A" fork fk fk1 >/dev/null 2>&1 && grep -q fork-me "$tmp/vms/fk1/home/project/f.txt" && ok "fork via controller" || bad "fork"
[ ! -f "$P/grants/fk1" ] && ! grep -q '^Host fk1.boxery' "$P/ssh_config" && ok "fork does not inherit grants by default" || bad "grants leaked into fork"
"$A" fork fk fk2 --grants >/dev/null 2>&1 && grep -q '^Host fk2.boxery' "$P/ssh_config" && grep -q '^env	FROM_CMD' "$P/grants/fk2" && ok "fork --grants copies the grant list" || bad "fork --grants"
if "$A" fork fk 'x;id' >/dev/null 2>&1; then bad "invalid fork name accepted"; else ok "invalid fork name rejected"; fi
"$A" snap fk s1 >/dev/null 2>&1; "$A" new fk3 --from fk@s1 >/dev/null 2>&1 && grep -q fork-me "$tmp/vms/fk3/home/project/f.txt" && ok "new --from via controller" || bad "new --from"
if "$A" new fk4 --from 'fk;id' >/dev/null 2>&1; then bad "bad --from accepted"; else ok "bad --from rejected"; fi
for n in fk fk1 fk2 fk3; do "$A" rm "$n" >/dev/null 2>&1 || true; done

# --- concurrent grant/revoke must not corrupt the store or the guest state (P1 #9)
"$A" new w4 >/dev/null 2>&1
for i in 1 2 3 4 5 6; do env "V$i=x" "$A" grant w4 "env:V$i" >/dev/null 2>&1 & done; wait
[ "$(grep -c '^env' "$P/grants/w4")" = 6 ] && ok "6 parallel grants → 6 entries" || bad "grant store: $(cat "$P/grants/w4")"
for i in 1 2 3 4 5 6; do "$A" revoke w4 "env:V$i" >/dev/null 2>&1 & done; wait
[ ! -f "$P/grants/w4" ] && ok "6 parallel revokes → store empty" || bad "left: $(cat "$P/grants/w4" 2>/dev/null)"
"$A" rm w4 >/dev/null 2>&1 || true

# --- regression (code review P0 #1): args must not be re-parsed by the host shell
"$A" new w2 >/dev/null 2>&1
rm -f "$tmp/pwned"
"$A" snap w2 "x; touch $tmp/pwned #" >/dev/null 2>&1 || true
[ ! -e "$tmp/pwned" ] && ok "snapshot name cannot inject commands (local mode)" || bad "INJECTION via snapshot name"
if "$A" new w3 --cpus '1; touch '"$tmp"'/pwned' >/dev/null 2>&1; then bad "non-numeric --cpus accepted"; else ok "non-numeric --cpus rejected"; fi
[ ! -e "$tmp/pwned" ] && ok "--cpus cannot inject" || bad "INJECTION via --cpus"
# remote mode: an ssh stub that, like real ssh, joins argv into one string and runs it with sh -c
cat >"$tmp/bin/sshjoin" <<STUB2
#!/usr/bin/env bash
while [ \$# -gt 0 ]; do case \$1 in -o|-F|-p) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift  # destination
exec sh -c "\$*"
STUB2
chmod +x "$tmp/bin/sshjoin"
rm -f "$tmp/pwned"
( ssh() { "$tmp/bin/sshjoin" "$@"; }; export -f ssh
  . /dev/stdin <<<"$(sed -n '/^literal()/p; /^literal_args()/p' "$A")"
  cmdline="echo $(literal_args snap w2 "x; touch $tmp/pwned #")"
  sh -c "$cmdline" >/dev/null )
[ ! -e "$tmp/pwned" ] && ok "remote transport quotes every argument" || bad "INJECTION via remote transport"
"$A" rm w2 >/dev/null 2>&1 || true

# --- run: exact argv like docker exec; a shell is explicit (bash -c); cwd like vm_bash (#11)
"$A" new w5 >/dev/null 2>&1
vh=$tmp/vms/w5/home tilde='~' nl='
'
exp=$(printf '[%s]' 'a  b' '$HOME' "it's" '' 'x;y' '*' "l1${nl}l2" '~')
out=$("$A" run w5 printf '[%s]' 'a  b' '$HOME' "it's" '' 'x;y' '*' "l1${nl}l2" '~' 2>/dev/null) || true
[ "$out" = "$exp" ] && ok "run passes args through as an exact argv" || bad "run argv: $out"
rm -f "$tmp/pwned"
"$A" run w5 echo "x; touch $tmp/pwned" >/dev/null 2>&1 || true
"$A" run w5 echo '$(touch '"$tmp"'/pwned)' >/dev/null 2>&1 || true
[ ! -e "$tmp/pwned" ] && ok "run args cannot inject commands into the VM shell" || bad "INJECTION via run args"
[ "$("$A" run w5 bash -c 'echo "$HOME" ~ | tr a-z A-Z' 2>&1)" = "$(printf '%s %s' "$vh" "$vh" | tr a-z A-Z)" ] \
	&& ok "bash -c gives a shell line with pipes, ~ and \$VAR" || bad "bash -c"
rc=0; err=$("$A" run w5 'echo hi' 2>&1 >/dev/null) || rc=$?
[ "$rc" = 127 ] && ok "a whole command line in one argument is one command name" || bad "single arg: rc=$rc"
case $err in *"hint:"*"run w5 bash -c 'echo hi'"*) ok "...and the error says how to run it as a shell line" ;; *) bad "no hint: $err" ;; esac
rc=0; err=$("$A" run w5 nosuchcmd 2>&1 >/dev/null) || rc=$?
[ "$rc" = 127 ] && case $err in *hint:*) false ;; esac && ok "no hint for an ordinary missing command" || bad "spurious hint: $err"
# the silent case (exit 0, literal $VAR or ~) gets a note on stderr; data and code that only look like it do not
noted() { "$A" run w5 "$@" 2>&1 >/dev/null | grep -q '^boxery: note:.*bash -c'; }
n=0; for a in '$HOME' '~' "$tilde/x" '--dir=$HOME/x' '${X:-y}'; do noted echo "$a" && n=$((n + 1)); done
[ "$n" = 5 ] && ok "a literal ~ or \$VAR argument gets a note pointing at bash -c" || bad "notes: $n of 5"
q=0; noted echo 'cost $5' && q=1; noted echo '$lower' && q=1; noted awk 'BEGIN { print "$NF" }' && q=1
noted bash -c 'echo $HOME' && q=1; noted /usr/bin/env true && q=1
[ "$q" = 0 ] && ok "no note for \$5, lowercase, awk/bash code or plain args" || bad "spurious literal note"
[ "$("$A" run w5 -- printf %s ok 2>&1)" = ok ] && ok "-- ends run's options" || bad "-- separator"
mkdir -p "$vh/project/dir with space"
[ "$("$A" run w5 pwd 2>&1)" = "$vh/project" ] && ok "run starts in ~/project, like vm_bash" || bad "default cwd: $("$A" run w5 pwd 2>&1)"
[ "$("$A" run w5 --cwd 'dir with space' pwd 2>&1)" = "$vh/project/dir with space" ] \
	&& ok "a relative --cwd is under ~/project and keeps spaces" || bad "--cwd relative"
[ "$("$A" run w5 --cwd "$tilde" pwd 2>&1)" = "$vh" ] && ok "--cwd ~ is the VM home" || bad "--cwd ~"
[ "$("$A" run w5 --cwd "$tilde/project/dir with space" pwd 2>&1)" = "$vh/project/dir with space" ] \
	&& ok "--cwd expands ~/ in the VM" || bad "--cwd ~/"
[ "$("$A" run w5 --cwd "$vh/project" pwd 2>&1)" = "$vh/project" ] && ok "an absolute --cwd is used as is" || bad "--cwd absolute"
rc=0; "$A" run w5 --cwd nope touch ran >/dev/null 2>&1 || rc=$?
[ "$rc" != 0 ] && [ ! -e "$vh/project/ran" ] && ok "a missing --cwd fails before running anything" || bad "--cwd nope: rc=$rc"
rc=0; "$A" run w5 sh -c 'exit 7' >/dev/null 2>&1 || rc=$?
[ "$rc" = 7 ] && ok "run returns the command's exit code" || bad "exit code: $rc"
"$A" run --help 2>&1 | grep -q "bash -c" && ok "run --help shows the examples" || bad "run --help"
u=0
"$A" run >/dev/null 2>&1 && u=1
"$A" run w5 >/dev/null 2>&1 && u=1
"$A" run w5 -- >/dev/null 2>&1 && u=1
"$A" run w5 --cwd >/dev/null 2>&1 && u=1
"$A" run w5 --cwd project >/dev/null 2>&1 && u=1
"$A" run 'bad;name' true >/dev/null 2>&1 && u=1
[ "$u" = 0 ] && ok "run rejects usage errors and invalid VM names" || bad "a malformed run invocation was accepted"
"$A" rm w5 >/dev/null 2>&1 || true

# version: the controller and the host (here, the same checkout) agree, so there is no warning.
v=$("$A" version --json 2>/dev/null) || v=""
case $v in '{"controller":{"version":"'*'"host":{"name":"local","version":"'*'"behind":false}') ok "version --json reports controller and host" ;; *) bad "version --json: $v" ;; esac
out=$("$A" version 2>&1) && printf '%s\n' "$out" | grep -q '^controller ' && printf '%s\n' "$out" | grep -q '^host .*\[local\]' && ! printf '%s\n' "$out" | grep -q 'older' && ok "version (text), no skew warning" || bad "version: $out"
# A host that predates `version` (any failure) is reported as behind, with the manual path.
printf '#!/bin/sh\nexit 1\n' >"$tmp/old-host"; chmod +x "$tmp/old-host"
mkdir -p "$tmp/old-profile"; cp "$P/ssh_config" "$tmp/old-profile/"
sed "s|^HOST_BIN=.*|HOST_BIN='$tmp/old-host'|" "$P/config" >"$tmp/old-profile/config"
"$A" host add old --config-dir "$tmp/old-profile" >/dev/null
out=$("$A" --host old version 2>&1); printf '%s\n' "$out" | grep -q "predates 'boxery-host version'" && ok "version: old host gets the manual upgrade path" || bad "old host: $out"
rc=0; out=$("$A" --host old upgrade-host 2>&1) || rc=$?
[ "$rc" != 0 ] && printf '%s\n' "$out" | grep -q "predates 'upgrade'" && ok "upgrade-host refuses a host without upgrade, explains the one-time manual step" || bad "upgrade-host on old host: rc=$rc $out"
# skew_note: a host behind the controller (release or commits after the same tag) gets a hint.
sn() { "$A" __skew "$@"; }
[ -n "$(sn 0.8.0 v0.8.0 0.7.0 v0.7.0 local)" ] && ok "skew: older release" || bad "skew: older release"
sn 0.7.0 v0.7.0-15-gabc 0.7.0 v0.7.0-3-gdef hornet | grep -q 'boxery --host hornet upgrade-host' && ok "skew: same release, fewer commits; hint names the host" || bad "skew: commits"
[ -z "$(sn 0.7.0 v0.7.0 0.8.0 v0.8.0 local)" ] && ok "skew: a newer host is fine" || bad "skew: newer host"
[ -z "$(sn 0.7.0 '' 0.7.0 '' local)" ] && ok "skew: equal npm releases are fine" || bad "skew: equal"

# --- desktop: the VM's VNC password (image/layers/desktop.sh) and `boxery desktop`'s URL. The ssh stub runs
# the "VM" side here with the layer's real boxery-vnc-password; vncpasswd is a stand-in that keeps the text.
D=$ROOT/image/layers/desktop.sh
grep -q -- '-SecurityTypes VncAuth -PasswordFile %t/boxery-vnc/passwd ' "$D" && ! grep -q 'SecurityTypes None' "$D" &&
	grep -q '^ExecStartPre=/usr/local/bin/boxery-vnc-password$' "$D" && ok "desktop layer: VNC needs a password, made before every start" || bad "desktop layer: VNC unit"
"$A" new d1 >/dev/null 2>&1
url_re='^==> desktop for d1 at http://127\.0\.0\.1:[0-9]+/vnc\.html\?autoconnect=1&resize=remote&reconnect=1'
old_re="$url_re  " new_re="$url_re#password=[A-Za-z0-9]{8}  "
rc=0; out=$("$A" desktop d1 --no-open 2>"$tmp/err") || rc=$?
[ "$rc" = 0 ] && [[ $out =~ $old_re ]] && grep -q "d1's desktop has no VNC password" "$tmp/err" &&
	ok "desktop, image without the VNC password: no password in the URL, a warning" || bad "desktop, old image: rc=$rc $out $(cat "$tmp/err")"
awk '/^cat >\/usr\/local\/bin\/boxery-vnc-password <<.EOF.$/{f=1; next} f&&/^EOF$/{exit} f' "$D" >"$tmp/bin/boxery-vnc-password"
printf '#!/bin/sh\nprintf obf:; cat\n' >"$tmp/bin/vncpasswd"; chmod +x "$tmp/bin/boxery-vnc-password" "$tmp/bin/vncpasswd"
export XDG_RUNTIME_DIR=$tmp/xdg-run; pf=$tmp/xdg-run/boxery-vnc/passwd
mode() { if stat -c %a "$1" >/dev/null 2>&1; then stat -c %a "$1"; else stat -f %Lp "$1"; fi; }
[ -z "$(boxery-vnc-password)" ] && [ "$(mode "$pf")" = 600 ] && [ "$(mode "${pf%/*}")" = 700 ] && grep -Eqx 'obf:[A-Za-z0-9]{8}' "$pf" &&
	ok "boxery-vnc-password: a random 8-character password, 0600 in a 0700 dir" || bad "vnc password file: $(ls -la "${pf%/*}" 2>&1) $(cat "$pf" 2>&1)"
cp "$pf" "$tmp/pf0"; boxery-vnc-password; cmp -s "$pf" "$tmp/pf0" && ok "boxery-vnc-password: keeps an existing one (the service restarting)" || bad "a service start replaced the password"
p=$(boxery-vnc-password --new)
[[ $p =~ ^[A-Za-z0-9]{8}$ ]] && [ "$(cat "$pf")" = "obf:$p" ] && ok "boxery-vnc-password --new: replaces it and prints it" || bad "--new: $p / $(cat "$pf")"
rc=0; out=$("$A" desktop d1 --no-open 2>"$tmp/err") || rc=$?
pw=${out##*#password=}; pw=${pw%% *}
[ "$rc" = 0 ] && [[ $out =~ $new_re ]] && [ "$(cat "$pf")" = "obf:$pw" ] && [ "$pw" != "$p" ] && [ ! -s "$tmp/err" ] &&
	ok "desktop: a fresh password for the session, only in the URL fragment" || bad "desktop URL: rc=$rc $out $(cat "$tmp/err")"
out=$("$A" desktop d1 --no-open 2>/dev/null); pw2=${out##*#password=}; pw2=${pw2%% *}
[ -n "$pw2" ] && [ "$pw2" != "$pw" ] && [ "$(cat "$pf")" = "obf:$pw2" ] && ok "desktop: the next session replaces it" || bad "second session: $out"
printf '#!/bin/sh\nexit 1\n' >"$tmp/bin/vncpasswd"
rc=0; out=$("$A" desktop d1 --no-open 2>&1) || rc=$?
[ "$rc" != 0 ] && [[ $out != *"==> desktop"* ]] && [ "$(cat "$pf")" = "obf:$pw2" ] && ok "desktop: no tunnel when the password can't be set" || bad "desktop, failing vncpasswd: rc=$rc $out"
rc=0; out=$("$A" desktop nosuch --no-open 2>&1) || rc=$?
[ "$rc" != 0 ] && [[ $out != *"==> desktop"* ]] && ok "desktop: no tunnel to an unreachable VM" || bad "desktop nosuch: rc=$rc $out"
rc=0; out=$("$A" desktop -oProxyCommand=x --no-open 2>&1) || rc=$?
[ "$rc" != 0 ] && [[ $out == *"invalid VM name"* ]] && ok "desktop: invalid VM name rejected" || bad "desktop, bad name: rc=$rc $out"
rm -f "$tmp/bin/boxery-vnc-password" "$tmp/bin/vncpasswd"; unset XDG_RUNTIME_DIR
"$A" rm d1 >/dev/null 2>&1 || true

echo; echo "passed: $pass  failed: $fail"; [ "$fail" -eq 0 ]
