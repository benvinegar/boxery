#!/usr/bin/env bash
# shellcheck disable=SC2088 # tilde strings below intentionally refer to target home
# Offline multi-profile registry and shell-layer quoting regressions (stock Bash 3.2).
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CLI=$ROOT/controller/boxery
REAL_SSH=$(command -v ssh)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp" # even an injection regression's marker stays inside the fixture
export BOXERY_HOME="$tmp/registry" HOME="$tmp/controller-home"
mkdir -p "$HOME/.ssh" "$tmp/bin" "$tmp/remote-home"
printf 'public key\n' >"$HOME/.ssh/id_ed25519.pub"
export SSH_LOG="$tmp/ssh.log" REMOTE_HOME="$tmp/remote-home"
cat >"$tmp/bin/ssh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SSH_LOG"
while [ $# -gt 0 ]; do case $1 in -o|-F) shift 2 ;; --) shift ;; *) break ;; esac; done
case ${1:-} in *.boxery) exit 0 ;; esac
shift
HOME=$REMOTE_HOME exec /bin/sh -c "$*"
STUB
chmod +x "$tmp/bin/ssh"
export PATH="$tmp/bin:$PATH"
# The executable path is data, including an apostrophe, $, backticks, %, spaces and shell syntax.
rel="bin/it's \$(touch NOT_EXECUTED) \`echo no\` % host"
mkdir -p "$REMOTE_HOME/bin"
printf '#!/usr/bin/env bash\ncase $1 in help) : ;; add-key) cat >/dev/null ;; ls) echo "demo running" ;; connect) printf "CONNECTED:%%s:%%s\\n" "$2" "$3" ;; esac\n' >"$REMOTE_HOME/$rel"
chmod +x "$REMOTE_HOME/$rel"
"$CLI" host add alpha user@fake --host-bin "~/$rel" >/dev/null
[ ! -f "$BOXERY_HOME/default-host" ]
[ "$("$CLI" host show alpha)" = "$BOXERY_HOME/profiles/alpha" ]
# Sourcing saved config on the controller must NOT expand the remote tilde.
# shellcheck disable=SC1090
. "$BOXERY_HOME/profiles/alpha/config"
[ "$HOST_BIN" = "~/$rel" ]
[ ! -e NOT_EXECUTED ]
"$CLI" --host alpha ls | grep -q '^demo '
# Execute exactly the ProxyCommand resolved by OpenSSH: local shell -> ssh -> remote /bin/sh.
proxy=$("$REAL_SSH" -F "$BOXERY_HOME/profiles/alpha/ssh_config" -G demo.boxery | sed -n 's/^proxycommand //p')
# ssh -G retains tokens; model OpenSSH's percent substitution before /bin/sh executes it.
proxy=${proxy//%%/PERCENT_PLACEHOLDER}; proxy=${proxy//%h/demo.boxery}; proxy=${proxy//%p/22}; proxy=${proxy//PERCENT_PLACEHOLDER/%}
sh -c "$proxy" | grep -q '^CONNECTED:demo.boxery:22$'
[ ! -e NOT_EXECUTED ]
# Import as-is: paths with spaces/apostrophes, no setup, writes, or SSH invocations.
import="$tmp/imported profile's"
mkdir -p "$import/grants"
printf "HOST='local'\nHOST_BIN='/bin/echo'\n" >"$import/config"
printf '# untouched ssh config\n' >"$import/ssh_config"
printf 'ssh-agent\t\t\n' >"$import/grants/demo"
cp "$import/config" "$tmp/config.before"; cp "$import/ssh_config" "$tmp/ssh.before"
lines=$(wc -l <"$SSH_LOG")
"$CLI" host add beta --config-dir "$import" >/dev/null
[ "$(wc -l <"$SSH_LOG")" -eq "$lines" ]
cmp "$import/config" "$tmp/config.before"; cmp "$import/ssh_config" "$tmp/ssh.before"
# No ambient legacy destination/executable leaks into a registered profile.
export BOXERY_HOST=unwanted BOXERY_HOST_BIN=/no/such/bin
"$CLI" --host beta ls | grep -q '^ls '
"$CLI" host use alpha
cp "$BOXERY_HOME/default-host" "$tmp/default.before"
if "$CLI" host use unknown >/dev/null 2>&1; then exit 1; fi
cmp "$BOXERY_HOME/default-host" "$tmp/default.before"
"$CLI" ls | grep -q '^demo '
"$CLI" host ls | grep -q "alpha.*\*"
if "$CLI" host rm alpha >/dev/null 2>&1; then echo 'removed selected default' >&2; exit 1; fi
"$CLI" host use beta
"$CLI" host rm alpha >/dev/null
[ -f "$BOXERY_HOME/profiles/alpha/config" ]
if "$CLI" host add alpha user@fake >/dev/null 2>&1; then echo 'overwrote forgotten profile data' >&2; exit 1; fi
[ -f "$import/grants/demo" ]
"$CLI" host use legacy
[ ! -e "$BOXERY_HOME/default-host" ]
# Legacy ambient overrides still work; root config does not need to exist.
BOXERY_HOST=local BOXERY_HOST_BIN=/bin/echo "$CLI" ls | grep -q '^ls '
for name in '../escape' '-oProxyCommand=x' 'bad name' 'a/b' 'Upper' ''; do
 if "$CLI" --host "$name" ls >/dev/null 2>&1; then echo "accepted invalid host $name" >&2; exit 1; fi
done
if "$CLI" --host unknown ls >/dev/null 2>&1; then exit 1; fi
if "$CLI" host add beta --config-dir "$import" >/dev/null 2>&1; then exit 1; fi
if "$CLI" host add failed local --host-bin /no/such/bin >/dev/null 2>&1; then exit 1; fi
[ ! -e "$BOXERY_HOME/host-registry/failed" ]; [ ! -e "$BOXERY_HOME/profiles/failed" ]; [ ! -e "$BOXERY_HOME/default-host" ]
# Two managed local profiles: separate grants, SSH configs and control sockets, even for demo.
# Include quotes/spaces in the root path to exercise SSH config value quoting.
export BOXERY_HOME="$tmp/root's space"
unset BOXERY_HOST BOXERY_HOST_BIN
localbin="$tmp/local it's \$(touch NOT_EXECUTED) \`echo no\` % host"
cp "$REMOTE_HOME/$rel" "$localbin"
"$CLI" host add quoted local --host-bin "$localbin" >/dev/null
"$CLI" --host quoted ls | grep -q '^demo '
proxy=$("$REAL_SSH" -F "$BOXERY_HOME/profiles/quoted/ssh_config" -G demo.boxery | sed -n 's/^proxycommand //p')
proxy=${proxy//%%/PERCENT_PLACEHOLDER}; proxy=${proxy//%h/demo.boxery}; proxy=${proxy//%p/22}; proxy=${proxy//PERCENT_PLACEHOLDER/%}
sh -c "$proxy" | grep -q '^CONNECTED:demo.boxery:22$'
[ ! -e NOT_EXECUTED ]
"$CLI" host add one local --host-bin /bin/echo >/dev/null
"$CLI" host add two local --host-bin /bin/echo >/dev/null
"$CLI" --host one grant demo ssh-agent >/dev/null
[ -f "$BOXERY_HOME/profiles/one/grants/demo" ]; [ ! -f "$BOXERY_HOME/profiles/two/grants/demo" ]
one=$("$REAL_SSH" -F "$BOXERY_HOME/profiles/one/ssh_config" -G demo.boxery)
two=$("$REAL_SSH" -F "$BOXERY_HOME/profiles/two/ssh_config" -G demo.boxery)
printf '%s\n' "$one" | grep -q '^forwardagent yes$'
printf '%s\n' "$two" | grep -q '^forwardagent no$'
printf '%s\n' "$one" | grep -Fq "controlpath $BOXERY_HOME/profiles/one/cm-demo.boxery"
printf '%s\n' "$two" | grep -Fq "controlpath $BOXERY_HOME/profiles/two/cm-demo.boxery"
"$CLI" host rm one >/dev/null
[ -f "$BOXERY_HOME/profiles/one/grants/demo" ]
# Upstream pool leases and HTTP grants must stay profile-local, even with duplicate VM/lease IDs.
leasebin="$tmp/lease-host"
export EDGE_LOG="$tmp/edge.log"
cat >"$leasebin" <<'STUB'
#!/usr/bin/env bash
case $1 in
help|release) : ;;
add-key) cat >/dev/null ;;
acquire) cat >/dev/null; printf 'demo l-0123456789abcdef0123456789abcdef %s\n' "$(( $(date +%s) + 600 ))" ;;
renew) printf '%s %s\n' "$2" "$(( $(date +%s) + 600 ))" ;;
edge-set) cat >>"$EDGE_LOG" ;;
esac
STUB
chmod +x "$leasebin"
"$CLI" host add lease-one local --host-bin "$leasebin" >/dev/null
"$CLI" host add lease-two local --host-bin "$leasebin" >/dev/null
id=l-0123456789abcdef0123456789abcdef
[ "$("$CLI" --host lease-one acquire --ttl 600 2>/dev/null)" = "demo $id" ]
p1="$BOXERY_HOME/profiles/lease-one"; p2="$BOXERY_HOME/profiles/lease-two"
[ -f "$p1/leases/$id.key" ]; [ ! -e "$p2/leases" ]
[ "$("$CLI" --host lease-two leases)" = "(no leases)" ]
if "$CLI" --host lease-two renew demo >/dev/null 2>&1; then echo 'renew crossed hosts' >&2; exit 1; fi
if "$CLI" --host lease-two release "$id" >/dev/null 2>&1; then echo 'release crossed hosts' >&2; exit 1; fi
"$CLI" --host lease-one renew demo --ttl 900 >/dev/null
[ "$("$CLI" --host lease-two acquire --ttl 600 2>/dev/null)" = "demo $id" ]
if cmp -s "$p1/leases/$id.key" "$p2/leases/$id.key"; then echo 'lease keys shared across profiles' >&2; exit 1; fi
"$REAL_SSH" -F "$p1/ssh_config" -G demo.boxery | grep -Fq "identityfile $p1/leases/$id.key"
"$REAL_SSH" -F "$p2/ssh_config" -G demo.boxery | grep -Fq "identityfile $p2/leases/$id.key"
"$CLI" --host lease-one grant demo http:api.example.com --cmd 'printf fixture-token' --readonly >/dev/null
[ -f "$p1/grants/.demo.edge" ]; [ ! -e "$p2/grants/.demo.edge" ]
grep -q '"readonly":true' "$EDGE_LOG"
"$CLI" --host lease-two grant demo http:api.example.com --cmd 'printf other-fixture-token' >/dev/null
"$CLI" --host lease-one release demo >/dev/null
[ ! -e "$p1/leases/$id.key" ]; [ ! -e "$p1/grants/demo" ]; [ ! -e "$p1/grants/.demo.edge" ]
[ -f "$p2/leases/$id.key" ]; [ -f "$p2/grants/demo" ]; [ -f "$p2/grants/.demo.edge" ]
"$CLI" --host lease-two leases | grep -q "$id"
"$CLI" --host lease-two release "$id" >/dev/null
[ ! -e "$p2/leases/$id.key" ]
# Copy setup's exact Include recommendation into an isolated SSH config, never ~/.ssh/config.
for suffix in "root's include space" 'root "quoted" \slash [*?] include'; do
	export BOXERY_HOME="$tmp/$suffix"
	output=$("$CLI" setup local --host-bin "$localbin")
	recommendation=$(printf '%s\n' "$output" | sed -n 's/^    \(Include .*\)$/\1/p')
	[ -n "$recommendation" ]
	printf '%s\n' "$recommendation" >"$tmp/include-test-config"
	resolved=$("$REAL_SSH" -F "$tmp/include-test-config" -G demo.boxery)
	printf '%s\n' "$resolved" | grep -q '^user agent$'
	direct=$("$REAL_SSH" -F "$BOXERY_HOME/ssh_config" -G demo.boxery)
	[ "$resolved" = "$direct" ]
	# Named profiles must not encourage ambiguous global *.boxery Includes.
	output=$("$CLI" host add named local --host-bin "$localbin")
	if printf '%s\n' "$output" | grep -q '^    Include '; then echo 'named profile recommended a global Include' >&2; exit 1; fi
done
# OpenSSH 9.6 and newer macOS clients differ on percent expansion in Include. Do not print
# a misleading global Include for such paths; explicit -F still reads the exact config.
export BOXERY_HOME="$tmp/percent % profile"
output=$("$CLI" setup local --host-bin "$localbin")
if printf '%s\n' "$output" | grep -q '^    Include '; then echo 'nonportable percent Include recommended' >&2; exit 1; fi
printf '%s\n' "$output" | grep -q 'instead of a global Include'
"$REAL_SSH" -F "$BOXERY_HOME/ssh_config" -G demo.boxery | grep -q '^user agent$'
# host ls says where each host runs: destination, the backend setup recorded, and which names share a profile.
export BOXERY_HOME="$tmp/listing"
backendbin="$tmp/backend-host"
printf '#!/usr/bin/env bash\ncase $1 in add-key) cat >/dev/null ;; backend) echo lima ;; esac\n' >"$backendbin"
chmod +x "$backendbin"
"$CLI" setup local --host-bin "$backendbin" | grep -q '^==> backend: lima$'
[ "$(cat "$BOXERY_HOME/backend")" = lima ]
"$CLI" host add mirror --config-dir "$BOXERY_HOME" >/dev/null # records the canonical path (/private/var on macOS)
real=$(cd "$BOXERY_HOME" && pwd -P)
"$CLI" host add far user@fake --host-bin "~/$rel" >/dev/null # predates `backend`: nothing recorded
[ ! -e "$BOXERY_HOME/profiles/far/backend" ]
"$CLI" host use mirror
"$CLI" host ls | grep -q "^legacy		$BOXERY_HOME	local	lima	mirror$"
"$CLI" host ls | grep -q "^mirror	\*	$real	local	lima	legacy$"
"$CLI" host ls | grep -q "^far		$BOXERY_HOME/profiles/far	user@fake	-	-$"
"$CLI" host ls --json | jq -e --arg d "$BOXERY_HOME" --arg r "$real" '. == [
	{name:"legacy",dir:$d,default:false,destination:"local",backend:"lima",same_as:["mirror"]},
	{name:"far",dir:($d + "/profiles/far"),default:false,destination:"user@fake",backend:null,same_as:[]},
	{name:"mirror",dir:$r,default:true,destination:"local",backend:"lima",same_as:["legacy"]}]' >/dev/null
# Legacy honors the ambient override, exactly as routing does; named profiles ignore it.
BOXERY_HOST=elsewhere "$CLI" host ls --json | jq -e '.[0].destination == "elsewhere" and .[2].destination == "local"' >/dev/null
# `backend` refreshes the record, and clears it rather than keep a stale one when the host can't say.
[ "$("$CLI" --host legacy backend)" = lima ]
printf 'stale\n' >"$BOXERY_HOME/profiles/far/backend"
if "$CLI" --host far backend >/dev/null 2>&1; then echo 'backend invented a value' >&2; exit 1; fi
[ ! -e "$BOXERY_HOME/profiles/far/backend" ]
echo 'PASS: named registry, default/reset, import, safe removal, isolation, failures and remote quoting'
