# shellcheck shell=bash disable=SC2154
# boxery backend: fake (tests only). VMs are directories under $BOXERY_FAKE_DIR; ssh endpoints point
# at a port that is never contacted (tests stub ssh). Exercises the dispatcher + contract without VMs.
# A VM's "disk" is its directory minus the hypervisor bits (port, state, size, user-data); images are
# copies of that disk under $FAKE/.images/IMAGE.
FAKE=${BOXERY_FAKE_DIR:?BOXERY_FAKE_DIR must be set for the fake backend}
# Deterministic crash/race barriers, only in this test backend. A release file unblocks retries too.
fake_checkpoint() { # POINT NAME
	[[ ${BOXERY_FAKE_PAUSE:-} == "$1" ]] || return 0
	mkdir -p "$FAKE/.barriers"
	printf '%s\n' "$BOXERY_OPERATION_ID" >"$FAKE/.barriers/$2.$1"
	while [[ ! -e $FAKE/.barriers/$2.$1.release ]]; do sleep 0.02; done
}
backend_check() { :; }
backend_init() { mkdir -p "$FAKE"; }
backend_proxy_services() { :; }
guest_proxy_upstream() { echo "TCP:fake-gateway:$PROXY_PORT"; }
backend_build_base() { mkdir -p "$FAKE"; touch "$FAKE/.base"; }
backend_has_base() { [[ -f $FAKE/.base ]]; }
backend_exists() { [[ -d $FAKE/$1 ]]; }
# Each fake VM gets a unique "ssh port" so test ssh stubs can map a connection to its VM directory.
fake_port() { cat "$FAKE/$1/port"; }
fake_disk_copy() { # SRC_DIR DST_DIR: copy everything that isn't hypervisor state
	mkdir -p "$2"
	(cd "$1" && find . -mindepth 1 -maxdepth 1 ! -name port ! -name state ! -name size ! -name user-data -exec cp -a {} "$2/" \;)
}
backend_new() { # NAME CPUS MEM DISK USERDATA [IMAGE]
	mkdir -p "$FAKE/$1/home" "$FAKE/.ports"
	local p=22000; while ! mkdir "$FAKE/.ports/$p" 2>/dev/null; do p=$((p + 1)); done   # atomic: parallel creates
	echo "$p" >"$FAKE/$1/port"
	[[ -z ${BOXERY_FAKE_FAIL_NEW:-} ]] || { echo running >"$FAKE/$1/state"; die "fake backend: injected failure"; }
	if [[ -n ${6:-} ]]; then
		[[ -d $FAKE/.images/$6 ]] || die "no such image: $6"
		fake_disk_copy "$FAKE/.images/$6" "$FAKE/$1"
		# what cloud-init's per-instance bootcmd does on a real guest (see boxery_seed)
		rm -f "$FAKE/$1/home/.ssh/authorized_keys"
		echo "$6" >"$FAKE/$1/from"
	fi
	echo running >"$FAKE/$1/state"; cp "$5" "$FAKE/$1/user-data"; echo "$2 $3 $4" >"$FAKE/$1/size"
	fake_checkpoint new "$1"
}
backend_list() { local d; for d in "$FAKE"/*/; do [[ -d $d ]] || continue; printf '%s\t%s\t%s\t%s\n' "$(basename "$d")" "$(cat "$d/state")" "127.0.0.1:$(cat "$d/port")" "1GiB"; done; }
backend_ssh_endpoint() { backend_exists "$1" || die "no such vm: $1"; [[ $(cat "$FAKE/$1/state") == running ]] || die "$1 is not running"; echo "127.0.0.1 $(fake_port "$1")"; }
backend_wait_endpoint() { echo "127.0.0.1 $(fake_port "$1")"; }
backend_start() { echo running >"$FAKE/$1/state"; }
backend_stop() { echo "shut off" >"$FAKE/$1/state"; }
backend_rm() { backend_exists "$1" || die "no such vm: $1"; rm -rf "${FAKE:?}/$1"; fake_checkpoint rm "$1"; }
backend_cleanup_new() { rm -rf "${FAKE:?}/$1"; }
backend_cleanup_image() { rm -rf "${FAKE:?}/.images/$1" "$FAKE/.images/$1.part" "$FAKE/.images/$1.created"; }
backend_recover_capture() { backend_cleanup_image "$2"; }

# Images. capture works on running VMs (like the real backends); reimage keeps the VM's own identity.
backend_capture() { # NAME IMAGE
	backend_exists "$1" || die "no such vm: $1"
	[[ -z ${BOXERY_FAKE_FAIL_CAPTURE:-} ]] || die "fake backend: injected capture failure"
	mkdir -p "$FAKE/.images"; [[ ! -e $FAKE/.images/$2 ]] || die "image $2 exists"
	fake_disk_copy "$FAKE/$1" "$FAKE/.images/$2.part"
	fake_checkpoint capture "$1"
	mv "$FAKE/.images/$2.part" "$FAKE/.images/$2"
	date +%Y-%m-%dT%H:%M:%S >"$FAKE/.images/$2.created"
}
backend_images() { # → IMAGE<TAB>CREATED<TAB>SIZE
	local d; for d in "$FAKE"/.images/*@*; do
		[[ -d $d && $d != *.part ]] || continue
		printf '%s\t%s\t%s\n' "$(basename "$d")" "$(cat "$d.created" 2>/dev/null)" 1MiB
	done
}
backend_image_rm() { [[ -d $FAKE/.images/$1 ]] || die "no such image: $1"; rm -rf "${FAKE:?}/.images/$1" "$FAKE/.images/$1.created"; }
backend_reimage() { # NAME IMAGE
	[[ -d $FAKE/.images/$2 ]] || die "no such image: $2"
	[[ -z ${BOXERY_FAKE_FAIL_REVERT:-} ]] || die "fake backend: injected revert failure"
	local keep; keep=$(mktemp -d)
	for f in port state size user-data from; do [[ ! -e $FAKE/$1/$f ]] || cp -a "$FAKE/$1/$f" "$keep/"; done
	rm -rf "${FAKE:?}/$1"; mkdir -p "$FAKE/$1"
	fake_disk_copy "$FAKE/.images/$2" "$FAKE/$1"
	cp -a "$keep/." "$FAKE/$1/"; rm -rf "$keep"
	echo running >"$FAKE/$1/state"
	fake_checkpoint reimage "$1"
}
