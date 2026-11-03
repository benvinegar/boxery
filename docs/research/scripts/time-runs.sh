#!/usr/bin/env bash
# Times a command several times and appends one JSON line per run.
#
# usage: time-runs.sh --label LABEL [--runs N] [--out FILE.jsonl] [--log-dir DIR] [--counts bun] -- COMMAND...
#
# Each run's output goes to DIR/LABEL-rN.log (default: ./logs). The JSON line holds the label, run
# number, UTC start and end, exit status, and the real/user/sys seconds from `time -p`, which counts
# the command and every child process it waits for. `--counts bun` also sums the pass/skip/fail
# summary lines that `bun test` prints, once per shard.
#
# Runs on macOS's bash 3.2 and on Linux. Needs /usr/bin/time (on Debian/Ubuntu: apt install time).
# The JSON holds no paths, host names or user names, so it can go into a public results file as is.
set -euo pipefail

label="" runs=2 out="runs.jsonl" log_dir="logs" counts=""
while [ $# -gt 0 ]; do
  case "$1" in
    --label) label="$2"; shift 2 ;;
    --runs) runs="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --log-dir) log_dir="$2"; shift 2 ;;
    --counts) counts="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "time-runs.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
if [ -z "$label" ] || [ $# -eq 0 ]; then
  sed -n '4p' "$0" | sed 's/^# //' >&2
  exit 2
fi
case "$label" in *[!A-Za-z0-9._-]*) echo "time-runs.sh: --label may only use letters, digits, . _ -" >&2; exit 2 ;; esac
mkdir -p "$log_dir"

# Prints the last value `time -p` wrote for one field (real, user or sys).
time_field() {
  awk -v f="$1" '$1 == f && NF == 2 { v = $2 } END { print (v == "" ? "null" : v) }' "$2"
}

# Sums one bun test summary field ("  2828 pass") across shards.
bun_count() {
  awk -v f="$1" '$2 == f && NF == 2 && $1 ~ /^[0-9]+$/ { n += $1; seen = 1 } END { print (seen ? n : "null") }' "$2"
}

i=1
while [ "$i" -le "$runs" ]; do
  log="$log_dir/$label-r$i.log"
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  set +e
  /usr/bin/time -p "$@" > "$log" 2>&1
  status=$?
  set -e
  ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  tests="null"
  if [ "$counts" = bun ]; then
    tests=$(printf '{"pass":%s,"skip":%s,"fail":%s}' \
      "$(bun_count pass "$log")" "$(bun_count skip "$log")" "$(bun_count fail "$log")")
  fi

  line=$(printf '{"label":"%s","run":%d,"started_at":"%s","ended_at":"%s","exit":%d,"real_s":%s,"user_s":%s,"sys_s":%s,"tests":%s}' \
    "$label" "$i" "$started" "$ended" "$status" \
    "$(time_field real "$log")" "$(time_field user "$log")" "$(time_field sys "$log")" "$tests")
  echo "$line" >> "$out"
  echo "$line"
  i=$((i + 1))
done
