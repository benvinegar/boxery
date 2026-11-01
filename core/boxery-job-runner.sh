#!/bin/bash
# boxery job runner. Callers send this file with each `start`, and core/boxery-jobs.ts writes it into
# the VM as ~/.boxery/jobs/runner.sh, so a VM always runs the caller's version. Plain bash (3.2+).
#
# It only keeps the job alive and records its exit code. One file, two roles:
#   runner.sh JOBS_DIR ID            the tmux pane
#   runner.sh JOBS_DIR ID --waiter   started by the pane
#
# - The pane starts the waiter in a session of its own (recording its pid) and waits for it, printing
#   nothing (copying the log into tmux would cost CPU for every byte a chatty job prints). Closing the
#   pane, Ctrl-C there, or tmux going away doesn't touch the job.
# - The waiter is a login shell (profile, PATH, grants), so the command gets the same environment as
#   `boxery run`. It runs the command in yet another session (process group = its pid), which `kill`
#   signals as a whole without hitting the waiter, then records the exit code.
# - Builtins (exit 3, printf -v) behave as in `boxery run`: the command is run as "$@" by bash.
# - SSH_AUTH_SOCK is dropped: a forwarded agent only lives as long as the ssh session that started
#   the job, so the job would otherwise get a socket path that stops working a moment later.
# - JOBS_DIR is passed in rather than taken from $HOME: a tmux server started earlier may have a
#   different HOME in its environment.
#
# - ID.runner and ID.pid hold "PID STARTTIME" (field 22 of /proc/PID/stat, empty without /proc), so a
#   reused pid is never mistaken for the job's process.
#
# Files (see core/boxery-jobs.ts): reads ID.json ID.argv ID.cwd; writes ID.runner ID.pid ID.log ID.exit.
JD=$1; id=$2
umask 077  # our files are private; the command gets the usual 022
# shellcheck disable=SC2086  # /proc/PID/stat fields are split on purpose
starttime() { local s; s=$(cat "/proc/$1/stat" 2>/dev/null) || return 0; s=${s##*) }; set -- $s; printf '%s' "${20:-}"; }
if [ "${3:-}" != --waiter ]; then
	# Started from a subshell that exits at once, so the waiter isn't our child: an unreaped zombie
	# would still look alive. setsid execs in place (the subshell isn't a group leader), so $! is it.
	( setsid bash -l "$0" "$JD" "$id" --waiter </dev/null >/dev/null 2>&1 & echo "$! $(starttime $!)" >"$JD/$id.runner" )
	echo "boxery job $id: output goes to $JD/$id.log (boxery logs NAME $id -f)"
	w=; read -r w _ <"$JD/$id.runner" 2>/dev/null; while [ -n "$w" ] && kill -0 "$w" 2>/dev/null; do sleep 1; done
	exit 0
fi
[ -f "$JD/$id.json" ] || exit 0  # start gave up on this job (login shell too slow) and removed it
# Read as bytes: under a UTF-8 locale (Ubuntu's default), bash 5's read drops a word that isn't valid
# UTF-8 entirely. LC_ALL=C applies to these reads only; the command keeps the user's locale.
args=(); while IFS= LC_ALL=C read -r -d '' a; do args+=("$a"); done <"$JD/$id.argv"
cwd=$(LC_ALL=C cat "$JD/$id.cwd")
unset SSH_AUTH_SOCK
# A program is exec'd so its exit code (and how it handles signals) is its own: bash 5 does that for a
# final command anyway, bash 3.2 (macOS) doesn't, and would answer the group's TERM with 143 itself.
# Builtins and functions (exit 3, printf -v) cannot be exec'd; they run in the wrapper shell.
# shellcheck disable=SC2016  # the inner script's $1 / $@ are its own arguments
(umask 022; exec setsid bash -c 'cd -- "$1" || exit; shift; case $(type -t -- "$1") in file) exec "$@" ;; *) "$@" ;; esac' boxery-job "$cwd" "${args[@]}") </dev/null >>"$JD/$id.log" 2>&1 &
echo "$! $(starttime $!)" >"$JD/$id.pid"
wait $!; rc=$?
echo "$rc $(date +%s)" >"$JD/$id.exit.tmp" && mv "$JD/$id.exit.tmp" "$JD/$id.exit"
