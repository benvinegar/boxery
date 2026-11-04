#!/usr/bin/env bash
# Shapes (named VM sizes) on the host against the fake backend: built-ins, the user's shapes.json
# (override + extend + default), validation, flag precedence, the recorded size and fork inheritance.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/conf BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms BOXERY_PROXY_PORT=9999 BOXERY_BOOT_ID=boot-1 BOXERY_SSH_WAIT_TRIES=2
mkdir -p "$tmp/bin" "$BOXERY_CONF"
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAImgmtmgmtmgmtmgmtmgmt mgmt@host" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/ssh"; chmod +x "$tmp/bin/ssh"; export PATH="$tmp/bin:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
size() { cat "$tmp/vms/$1/size"; }
# sql QUERY → its rows in the host's store, as JSON (each VM's record is a vm_records row)
sql() { node --disable-warning=ExperimentalWarning -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);console.log(JSON.stringify(d.prepare(process.argv[2]).all()))' "$BOXERY_CONF/leases.db" "$1"; }
# rec NAME → NAME's recorded size, as {shape, cpus, mem, disk}; nothing without one
rec() { sql "SELECT shape, cpus, mem, disk FROM vm_records WHERE name='$1' AND cpus IS NOT NULL" | jq -c '.[]'; }
# forget NAME's size, as for a VM made before shapes
unrecord() { sql "UPDATE vm_records SET shape=NULL, cpus=NULL, mem=NULL, disk=NULL WHERE name='$1'" >/dev/null; }
user() { printf '%s\n' "$1" >"$BOXERY_CONF/shapes.json"; }
"$H" build-base >/dev/null 2>&1

echo "== built-ins"
j=$("$H" shapes --json)
[[ $(jq -r .default <<<"$j") == standard ]] && ok "default shape is standard" || bad "default: $j"
[[ $(jq -c '.shapes.standard' <<<"$j") == '{"cpus":4,"mem":8192,"disk":40}' ]] && ok "standard = 4 vCPU / 8 GiB / 40 GiB" || bad "standard: $j"
[[ $(jq -r '.shapes | keys | join(",")' <<<"$j") == large,small,standard ]] && ok "small, standard, large" || bad "names: $j"
t=$("$H" shapes); grep -q '^standard \*' <<<"$t" && ok "table marks the default" || bad "table: $t"

echo "== new"
"$H" new a >/dev/null 2>&1; [[ $(size a) == "4 8192 40" && $(rec a) == '{"shape":"standard","cpus":4,"mem":8192,"disk":40}' ]] && ok "no flags → default shape (recorded)" || bad "a: $(size a) $(rec a)"
"$H" new b --shape large >/dev/null 2>&1; [[ $(size b) == "8 16384 80" && $(rec b | jq -r .shape) == large ]] && ok "--shape large" || bad "b: $(size b)"
"$H" new c --shape small --mem 1024 >/dev/null 2>&1; [[ $(size c) == "2 1024 20" && $(rec c | jq -r .shape) == null ]] && ok "flags override one field of the shape (→ custom)" || bad "c: $(size c) $(rec c)"
"$H" new d --cpus 3 >/dev/null 2>&1; [[ $(size d) == "3 8192 40" ]] && ok "flags alone start from the default shape" || bad "d: $(size d)"
if "$H" new e --shape nope >/dev/null 2>&1; then bad "unknown shape accepted"; else ok "unknown shape fails"; fi
if "$H" new e --shape 'x;id' >/dev/null 2>&1; then bad "invalid shape name accepted"; else ok "invalid shape name fails"; fi
[[ ! -d $tmp/vms/e && -z $(rec e) ]] && ok "...and create nothing" || bad "half-made VM e"

echo "== ls shows the shape"
l=$("$H" ls --json)
[[ $(jq -r '.[] | select(.name == "b") | "\(.shape) \(.cpus) \(.mem)"' <<<"$l") == "large 8 16384" ]] && ok "ls --json: shape, cpus, mem" || bad "ls: $l"
[[ $(jq -r '.[] | select(.name == "c") | .shape' <<<"$l") == custom ]] && ok "custom size listed as custom" || bad "ls c: $l"
t=$("$H" ls); grep -qE '^b +running .* large ' <<<"$t" && ok "ls table has a SHAPE column" || bad "ls table: $t"

echo "== fork"
"$H" fork b b2 >/dev/null 2>&1; [[ $(size b2) == "8 16384 80" && $(rec b2 | jq -r .shape) == large ]] && ok "fork copies the source's shape" || bad "b2: $(size b2) $(rec b2)"
"$H" fork c c2 >/dev/null 2>&1; [[ $(size c2) == "2 1024 20" ]] && ok "fork copies a custom size" || bad "c2: $(size c2)"
"$H" fork b b3 --cpus 2 >/dev/null 2>&1; [[ $(size b3) == "2 16384 80" ]] && ok "fork size flag overrides one field of the source's size" || bad "b3: $(size b3)"
"$H" fork b b4 --shape small >/dev/null 2>&1; [[ $(size b4) == "2 4096 20" ]] && ok "fork --shape replaces the source's size" || bad "b4: $(size b4)"
unrecord a   # a VM from before shapes
"$H" fork a a2 >/dev/null 2>&1; [[ $(size a2) == "4 8192 40" ]] && ok "fork of an unrecorded VM → its backend size" || bad "a2: $(size a2)"
[[ $("$H" ls --json | jq -c '.[] | select(.name == "a") | [.shape, .cpus, .mem, .disk_size]') == '["custom",4,8192,40]' ]] && ok "unrecorded VM lists its backend size, as custom" || bad "a: $("$H" ls --json | jq -c '.[] | select(.name == "a")')"
[[ $(rec a) == '{"shape":null,"cpus":4,"mem":8192,"disk":40}' ]] && ok "...and ls records it" || bad "a record: $(rec a 2>&1)"
if "$H" fork b b5 --shape nope >/dev/null 2>&1; then bad "fork with unknown shape"; else ok "fork with unknown shape fails"; fi
[[ ! -d $tmp/vms/b5 && -z $("$H" images 2>/dev/null | grep '@fork-') ]] && ok "...before capturing anything" || bad "leftovers after bad fork shape"

echo "== resize updates the record"
"$H" resize b2 --cpus 12 >/dev/null 2>&1
[[ $(rec b2) == '{"shape":null,"cpus":12,"mem":16384,"disk":80}' ]] && ok "resize → custom with the new size" || bad "b2 after resize: $(rec b2)"
"$H" fork b2 b6 >/dev/null 2>&1; [[ $(size b6) == "12 16384 80" ]] && ok "fork after resize copies the new size" || bad "b6: $(size b6)"
unrecord a; echo "6 3072 30" >"$tmp/vms/a/size"   # unrecorded VM: fork reads the backend's size
"$H" fork a a3 >/dev/null 2>&1; [[ $(size a3) == "6 3072 30" ]] && ok "fork of an unrecorded VM uses backend_size" || bad "a3: $(size a3)"

echo "== rm forgets the size"
"$H" rm b3 >/dev/null 2>&1; [[ $(sql "SELECT count(*) n FROM vm_records WHERE name='b3'") == '[{"n":0}]' ]] && ok "rm removes the size record" || bad "b3 record left"

echo "== user shapes.json"
user '{"default":"dev","shapes":{"dev":{"cpus":6,"mem":12288,"disk":60},"large":{"mem":24576}}}'
j=$("$H" shapes --json)
[[ $(jq -r .default <<<"$j") == dev ]] && ok "user default" || bad "default: $j"
[[ $(jq -c .shapes.large <<<"$j") == '{"cpus":8,"mem":24576,"disk":80}' ]] && ok "partial override keeps the other built-in fields" || bad "large: $j"
[[ $(jq -c .shapes.small <<<"$j") == '{"cpus":2,"mem":4096,"disk":20}' ]] && ok "untouched built-ins stay" || bad "small: $j"
"$H" new u >/dev/null 2>&1; [[ $(size u) == "6 12288 60" && $(rec u | jq -r .shape) == dev ]] && ok "new uses the user's default" || bad "u: $(size u)"
"$H" new v --shape large >/dev/null 2>&1; [[ $(size v) == "8 24576 80" ]] && ok "new uses the overridden built-in" || bad "v: $(size v)"

echo "== invalid shapes.json fails closed"
for bad_json in '{"shapes":{"x":{"cpus":1}}}' '{"default":"nope"}' '{"shapes":{"Bad":{"cpus":1,"mem":1,"disk":1}}}' '{"shapes":{"small":{"cpus":1.5}}}' '{"shapes":{"small":{"mem":0}}}' '{"shapes":{"small":{"disk":"9"}}}' 'garbage' '[]'; do
	user "$bad_json"
	if err=$("$H" new w 2>&1); then bad "accepted: $bad_json"; else [[ $err == *shapes.json* ]] && ok "rejects $bad_json" || bad "unclear error for $bad_json: $err"; fi
done
"$H" shapes >/dev/null 2>&1 && bad "shapes with invalid file" || ok "shapes reports the invalid file too"
[[ ! -d $tmp/vms/w ]] && ok "...and no VM was created" || bad "VM w created from invalid shapes"
rm "$BOXERY_CONF/shapes.json"

echo; echo "passed: $pass  failed: $fail"; ((fail == 0))
