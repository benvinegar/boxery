# shellcheck shell=bash disable=SC2154
# boxery backend: fake (tests only). VMs are directories under $BOXERY_FAKE_DIR; ssh endpoints point
# at a port that is never contacted (tests stub ssh). Exercises the dispatcher + contract without VMs.
FAKE=${BOXERY_FAKE_DIR:?BOXERY_FAKE_DIR must be set for the fake backend}
backend_check() { :; }
backend_init() { mkdir -p "$FAKE"; }
backend_proxy_services() { :; }
guest_proxy_upstream() { echo "TCP:fake-gateway:$PROXY_PORT"; }
backend_build_base() { mkdir -p "$FAKE"; touch "$FAKE/.base"; }
backend_has_base() { [[ -f $FAKE/.base ]]; }
backend_exists() { [[ -d $FAKE/$1 ]]; }
# Each fake VM gets a unique "ssh port" so test ssh stubs can map a connection to its VM directory.
fake_port() { cat "$FAKE/$1/port"; }
backend_new() {
	mkdir -p "$FAKE/$1/home"
	local n; n=$(find "$FAKE" -maxdepth 2 -name port | wc -l); echo $((22000 + n)) >"$FAKE/$1/port"
	[[ -z ${BOXERY_FAKE_FAIL_NEW:-} ]] || { echo running >"$FAKE/$1/state"; die "fake backend: injected failure"; }
	echo running >"$FAKE/$1/state"; cp "$5" "$FAKE/$1/user-data"; echo "$2 $3 $4" >"$FAKE/$1/size"
}
backend_list() { local d; for d in "$FAKE"/*/; do [[ -d $d ]] || continue; printf '%s\t%s\t%s\t%s\n' "$(basename "$d")" "$(cat "$d/state")" "127.0.0.1:$(cat "$d/port")" "1GiB"; done; }
backend_ssh_endpoint() { backend_exists "$1" || die "no such vm: $1"; [[ $(cat "$FAKE/$1/state") == running ]] || die "$1 is not running"; echo "127.0.0.1 $(fake_port "$1")"; }
backend_wait_endpoint() { echo "127.0.0.1 $(fake_port "$1")"; }
backend_start() { echo running >"$FAKE/$1/state"; }
backend_stop() { echo "shut off" >"$FAKE/$1/state"; }
backend_rm() { backend_exists "$1" || die "no such vm: $1"; rm -rf "${FAKE:?}/$1"; }
# Snapshots copy the VM dir (including its fake home: authorized_keys, files written by agents);
# revert restores it exactly, which is what makes lease fencing testable.
backend_snap() { rm -rf "${FAKE:?}/.snap-$1-$2"; cp -a "$FAKE/$1" "$FAKE/.snap-$1-$2"; }
backend_snap_rm() { rm -rf "${FAKE:?}/.snap-$1-$2"; }
backend_snaps() { ls -d "$FAKE"/.snap-"$1"-* 2>/dev/null | sed "s#.*/.snap-$1-##"; }
backend_revert() {
	[[ -d $FAKE/.snap-$1-$2 ]] || die "no snapshot $2"
	[[ -z ${BOXERY_FAKE_FAIL_REVERT:-} ]] || die "fake backend: injected revert failure"
	rm -rf "${FAKE:?}/$1"; cp -a "$FAKE/.snap-$1-$2" "$FAKE/$1"
}
