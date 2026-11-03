set -eu
umask 077
RT=${BOXERY_RUNTIME_DIR:-/run/user/$(id -u)}
for _ in $(seq 30); do [ -d "$RT" ] && break; sleep 1; done   # appears once the user manager is up (lingering)
[ -d "$RT" ] || { echo "boxery: $RT missing (no user runtime dir)" >&2; exit 1; }
R=$RT/boxery
mkdir -p "$R/files"
# One apply at a time per VM (concurrent attach/revoke must not interleave staging files).
exec 9>"$R/.lock"; if command -v flock >/dev/null; then flock 9; fi
: >"$R/env.sh.new"; : >"$R/links.new"; : >"$R/targets.new"; : >"$R/gitconfig.new"
# Edge grants: the VM only learns *where* to send requests; the host proxy adds the credential.
TOK=$(cat "$HOME/.boxery/token" 2>/dev/null || true)
EDGE="http://127.0.0.1:8088/edge/$(printf %s "$TOK" | sed 's/:/%3A/')"
put_edge() {
	[ -n "$TOK" ] || { echo "boxery: no proxy token in the VM; http grants unavailable" >&2; return 0; }
	grep -q '^export BOXERY_EDGE=' "$R/env.sh.new" || printf 'export BOXERY_EDGE=%q\n' "$EDGE" >>"$R/env.sh.new"
	printf '[url "%s/%s/"]\n\tinsteadOf = https://%s/\n' "$EDGE" "$1" "$1" >>"$R/gitconfig.new"
	[ "$1" != registry.npmjs.org ] || printf 'export npm_config_registry=%q\n' "$EDGE/registry.npmjs.org/" >>"$R/env.sh.new"
}
put_env() { v=$(printf %s "$2" | base64 -d); printf 'export %s=%q\n' "$1" "$v" >>"$R/env.sh.new"; }
put_file() {
	d=$1; case "$d" in /*) ;; *) d=$HOME/$d ;; esac
	case "/$d/" in */../*) echo "boxery: refusing path with ..: $d" >&2; return 0 ;; esac
	case "$d" in "$HOME"/*) ;; *) echo "boxery: refusing file grant outside $HOME: $d" >&2; return 0 ;; esac
	t=$R/files/$(printf %s "$d" | cksum | cut -d' ' -f1)
	rm -f "$t"; printf %s "$2" | base64 -d >"$t"; chmod 0400 "$t"
	echo "$t" >>"$R/targets.new"
	if [ -e "$d" ] && [ ! -L "$d" ]; then echo "boxery: $d exists as a real file; not replacing it" >&2; return 0; fi
	mkdir -p "$(dirname "$d")"; ln -sfn "$t" "$d"; echo "$d" >>"$R/links.new"
	case "$d" in "$HOME"/project/*)
		if [ -d "$HOME/project/.git" ]; then
			ex=$HOME/project/.git/info/exclude; rel=/${d#"$HOME"/project/}
			mkdir -p "$(dirname "$ex")"; touch "$ex"; grep -qxF "$rel" "$ex" || echo "$rel" >>"$ex"
		fi ;;
	esac
}
# BOXERY_GRANT_VALUES
mv "$R/env.sh.new" "$R/env.sh"
mv "$R/gitconfig.new" "$R/gitconfig"
# git ignores a missing include, so this one-time line is harmless after revoke or reboot.
if [ -s "$R/gitconfig" ] && ! git config --global --get-all include.path 2>/dev/null | grep -qxF "$R/gitconfig"; then
	git config --global --add include.path "$R/gitconfig"
fi
if [ -f "$R/links" ]; then
	while IFS= read -r old; do
		grep -qxF "$old" "$R/links.new" && continue
		if [ -L "$old" ]; then case "$(readlink "$old")" in "$R"/*) rm -f "$old" ;; esac; fi
	done <"$R/links"
fi
mv "$R/links.new" "$R/links"
for t in "$R"/files/*; do [ -e "$t" ] || continue; grep -qxF "$t" "$R/targets.new" || rm -f "$t"; done
rm -f "$R/targets.new"
hook='[ -r "/run/user/$(id -u)/boxery/env.sh" ] && . "/run/user/$(id -u)/boxery/env.sh"  # boxery-grants'
for rc in "$HOME/.profile" "$HOME/.bashrc"; do
	touch "$rc"
	grep -q 'boxery-grants' "$rc" || { printf '%s\n' "$hook" | cat - "$rc" >"$rc.boxery" && cat "$rc.boxery" >"$rc" && rm -f "$rc.boxery"; }
done
echo "boxery: grants applied ($(grep -c . "$R/env.sh" || true) env, $(grep -c . "$R/links" || true) files, $(grep -c insteadOf "$R/gitconfig" || true) http)"
