#!/usr/bin/env bash
# Guest-side job protocol, sent over ssh by the CLI and shared core. Requires bash + tmux.
# shellcheck disable=SC2088 # literal ~ prefixes are expanded in the guest runner
set -eu
umask 077
d=$HOME/.boxery/jobs
fail() { echo "boxery jobs: $*" >&2; exit 1; }
quote() { local s=$1; s=${s//\'/\'\\\'\'}; printf "'%s'" "$s"; }
valid_id() { [[ ${1:-} =~ ^job-[A-Za-z0-9]{12}$ ]]; }
need_job() {
	valid_id "${1:-}" || fail "invalid job ID: ${1:-}"
	[ -f "$d/$1.meta" ] || fail "unknown job: $1"
}
state() {
	code=null
	if [ -f "$d/$id.exit" ]; then
		code=$(cat "$d/$id.exit"); status=completed
	elif tmux has-session -t "=$id" 2>/dev/null; then status=running
	elif [ -f "$d/$id.exit" ]; then
		code=$(cat "$d/$id.exit"); status=completed
	else status=lost
	fi
}
record() {
	printf '{"id":"%s","state":"%s","started_at":%s,"exit_code":%s}' "$id" "$status" "$(cat "$d/$id.meta")" "$code"
}
action=${1:-}; [ $# -eq 0 ] || shift
case $action in
start)
	[ $# -ge 2 ] || fail 'start needs cwd and command'
	cwd=$1; shift
	mkdir -p "$d"
	reservation=$(mktemp "$d/job-XXXXXXXXXXXX")
	id=${reservation##*/}
	date +%s >"$reservation"
	line=''
	for arg in "$@"; do line="$line $(quote "$arg")"; done
	case $cwd in
	'') cdline='cd ~/project 2>/dev/null || cd ~' ;;
	'~') cdline='cd ~' ;;
	'~/'*) cdline="cd -- \"\$HOME\"/$(quote "${cwd#\~/}")" ;;
	/*) cdline="cd -- $(quote "$cwd")" ;;
	*) cdline="cd -- \"\$HOME/project\"/$(quote "$cwd")" ;;
	esac
	# The command is a child: even `exec`, signals and exit 255 are captured by the parent.
	{
		printf '%s\n' '#!/usr/bin/env bash' "job=$(quote "$d/$id")"
		printf '%s\n' 'trap '\''rc=$?; printf "%s\n" "$rc" > "$job.exit.tmp"; mv -- "$job.exit.tmp" "$job.exit"'\'' EXIT'
		# Only the detached runner publishes readiness, before executing the command.
		printf 'mv -- %s "$job.meta" || exit $?\n' "$(quote "$reservation")"
		printf '( %s &&%s ) </dev/null >"$job.log" 2>&1\n' "$cdline" "$line"
		printf '%s\n' 'exit $?'
	} >"$d/$id.sh"
	: >"$d/$id.log"
	# Keep the runner's PTY open; redirecting all its fds makes tmux close the pane early.
	launch_failed() {
		tmux kill-session -t "=$id" 2>/dev/null || true
		rm -f -- "$reservation" "$d/$id.sh" "$d/$id.log" "$d/$id.meta" "$d/$id.exit" "$d/$id.exit.tmp"
		fail 'could not launch tmux job (runner did not become ready)'
	}
	tmux new-session -d -s "$id" "exec bash -l $(quote "$d/$id.sh")" || launch_failed
	# Login setup can fail or hang. A fast command may already have exited: metadata
	# is authoritative, and is checked again after probing the disappearing session.
	SECONDS=0
	while [ ! -f "$d/$id.meta" ]; do
		if ! tmux has-session -t "=$id" 2>/dev/null || [ "$SECONDS" -ge 10 ]; then
			[ -f "$d/$id.meta" ] || launch_failed
			break
		fi
		sleep 0.05
	done
	printf '%s\n' "$id"
	;;
list)
	json=false
	case $#:${1:-} in 0:) ;; 1:--json) json=true ;; *) fail 'usage: jobs NAME [--json]' ;; esac
	if "$json"; then printf '['; else printf 'ID\tSTATE\tSTARTED_AT\tEXIT_CODE\n'; fi
	sep=''
	for meta in "$d"/job-*.meta; do
		[ -f "$meta" ] || continue
		id=${meta##*/}; id=${id%.meta}; valid_id "$id" || continue
		state
		if "$json"; then printf '%s\n' "$sep"; record; sep=,
		else printf '%s\t%s\t%s\t%s\n' "$id" "$status" "$(cat "$meta")" "$code"; fi
	done
	if "$json"; then printf ']\n'; fi
	;;
logs)
	need_job "${1:-}"; id=$1; shift
	follow=false; strip=false; lines=200; byte_limit=0
	while [ $# -gt 0 ]; do
		case $1 in
		-f|--follow) follow=true; shift ;;
		--strip-ansi) strip=true; shift ;;
		--lines) [ $# -ge 2 ] || fail '--lines needs a number'; lines=$2; shift 2 ;;
		--bytes) [ $# -ge 2 ] || fail '--bytes needs a number'; byte_limit=$2
			[[ $byte_limit =~ ^[1-9][0-9]{0,8}$ ]] || fail 'invalid byte count'
			shift 2 ;;
		*) fail "unknown logs option: $1" ;;
		esac
	done
	[[ $lines =~ ^[0-9]+$ ]] || fail 'invalid line count'
	# Bound raw bytes BEFORE tail's line buffering and before ANSI filtering. The
	# stderr notice lets bounded API callers distinguish clipping from a short log.
	snapshot() {
		local start=$1 end=$2
		if [ "$byte_limit" -gt 0 ] && [ "$((end - start))" -gt "$byte_limit" ]; then
			start=$((end - byte_limit))
			echo 'boxery jobs: output byte-truncated' >&2
		fi
		tail -c "+$((start + 1))" -- "$d/$id.log" | head -c "$((end - start))"
	}
	stream() {
		bytes=$(wc -c <"$d/$id.log")
		snapshot 0 "$bytes" | tail -n "$lines"
		while "$follow"; do
			state
			# Read a size-bounded snapshot, including the final bytes after exit was published.
			next=$(wc -c <"$d/$id.log")
			if [ "$next" -gt "$bytes" ]; then
				snapshot "$bytes" "$next"
			fi
			bytes=$next
			[ "$status" = running ] || break
			sleep 0.2
		done
	}
	if "$strip"; then
		# CSI (colors/cursor), OSC (titles/hyperlinks), and two-byte escape sequences.
		# GNU -u and BSD -l both flush each output line instead of block buffering.
		buffering=-l
		if sed --version >/dev/null 2>&1; then buffering=-u; fi
		stream | LC_ALL=C sed "$buffering" -E $'s/\033\\]([^\007\033]|\033[^\\\\])*(\007|\033\\\\)//g; s/\033\\[[0-?]*[ -/]*[@-~]//g; s/\033[@-_]//g'
	else stream; fi
	;;
wait)
	need_job "${1:-}"; id=$1; shift
	json=false; timeout=0
	while [ $# -gt 0 ]; do
		case $1 in
		--json) json=true; shift ;;
		--timeout) [ $# -ge 2 ] || fail '--timeout needs seconds'; timeout=$2; shift 2 ;;
		*) fail "unknown wait option: $1" ;;
		esac
	done
	[[ $timeout =~ ^[0-9]+$ ]] || fail 'invalid timeout'
	SECONDS=0
	while :; do
		state
		[ "$status" = running ] || break
		if [ "$timeout" -gt 0 ] && [ "$SECONDS" -ge "$timeout" ]; then break; fi
		sleep 0.2
	done
	if "$json"; then record; printf '\n'
	elif [ "$status" = completed ]; then exit "$code"
	elif [ "$status" = lost ]; then fail "job $id was lost (tmux exited without recording a status)"
	else echo "boxery jobs: still running: $id" >&2; exit 124
	fi
	;;
*) fail "unknown action: $action" ;;
esac
