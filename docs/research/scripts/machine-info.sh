#!/usr/bin/env bash
# Prints the machine a benchmark ran on as one JSON object: model, chip, cores, memory and OS.
#
# usage: machine-info.sh
#
# Run it on the host, and again inside a VM or container to describe the guest. It never prints the
# host name, user name, serial number or any path, so its output can go into a public results file.
set -euo pipefail

# Escapes a string for a JSON value.
json_str() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

case "$(uname -s)" in
  Darwin)
    model=$(sysctl -n hw.model)
    chip=$(sysctl -n machdep.cpu.brand_string)
    cores=$(sysctl -n hw.ncpu)
    groups=""
    level=0
    while sysctl -n "hw.perflevel$level.physicalcpu" > /dev/null 2>&1; do
      groups="$groups${groups:+,}$(sysctl -n "hw.perflevel$level.physicalcpu")"
      level=$((level + 1))
    done
    mem_bytes=$(sysctl -n hw.memsize)
    os="macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
    ;;
  Linux)
    model=$(cat /sys/devices/virtual/dmi/id/product_name 2> /dev/null || echo unknown)
    chip=$(awk -F: '/^model name/ { sub(/^ +/, "", $2); print $2; exit }' /proc/cpuinfo)
    [ -n "$chip" ] || chip=$(uname -m)
    cores=$(nproc)
    groups=""
    mem_bytes=$(awk '/^MemTotal:/ { print $2 * 1024 }' /proc/meminfo)
    # shellcheck source=/dev/null
    os=$( (. /etc/os-release && echo "$PRETTY_NAME") 2> /dev/null || echo Linux)
    ;;
  *)
    echo "machine-info.sh: unsupported OS $(uname -s)" >&2
    exit 1
    ;;
esac

mem_gib=$(awk -v b="$mem_bytes" 'BEGIN { printf "%.2f", b / 1073741824 }')
printf '{"model":%s,"chip":%s,"cpu_cores":%d,"cpu_core_groups":[%s],"memory_gib":%s,"os":%s,"kernel":%s,"arch":%s}\n' \
  "$(json_str "$model")" "$(json_str "$chip")" "$cores" "$groups" "$mem_gib" \
  "$(json_str "$os")" "$(json_str "$(uname -r)")" "$(json_str "$(uname -m)")"
