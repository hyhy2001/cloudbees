#!/usr/bin/env bash
# rxauto - single entry point, lives OUTSIDE auto_env.
# Auto-detects the canonical RX_AUTO/UTLs/Cloudbees dir (holds `bee` + auto_env/),
# exports BEE, then dispatches into auto_env.
#
#   rxauto.sh provision|deploy|run|manage [args...]   -> auto_env/*.csh
#   rxauto.sh setup [all|makefile|general|auto|server] [--dry-run]  -> scripts/setup_all.bash
#   rxauto.sh all                                      -> provision + deploy + run
#   rxauto.sh bee <args...>                            -> raw bee passthrough
#
# Override detection with:  RXAUTO_CB=/path/to/RX_AUTO/UTLs/Cloudbees
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# find the Cloudbees dir (contains auto_env/). Walk up from script dir + cwd.
find_cb() {
  [ -n "${RXAUTO_CB:-}" ] && { echo "$RXAUTO_CB"; return 0; }
  local start d
  for start in "$SCRIPT_DIR" "$PWD"; do
    d="$start"
    while [ "$d" != / ]; do
      [ -d "$d/auto_env" ] && [ "$(basename "$d")" = Cloudbees ] && { echo "$d"; return 0; }
      [ -d "$d/RX_AUTO/UTLs/Cloudbees/auto_env" ] && { echo "$d/RX_AUTO/UTLs/Cloudbees"; return 0; }
      d="$(dirname "$d")"
    done
  done
  return 1
}

CB="$(find_cb)" || { echo "rxauto: cannot locate RX_AUTO/UTLs/Cloudbees (set RXAUTO_CB)" >&2; exit 1; }
AUTO="$CB/auto_env"
[ -d "$AUTO" ] || { echo "rxauto: $AUTO not found" >&2; exit 1; }
[ -x "$CB/bee" ] && export BEE="$CB/bee"   # else lib.csh falls back to ../bee (same path)

cmd="${1:-}"; shift || true
case "$cmd" in
  provision|deploy|run|manage) exec csh "$AUTO/$cmd.csh" "$@" ;;
  setup)                       exec bash "$AUTO/scripts/setup_all.bash" "$@" ;;
  bee)                         exec "${BEE:-$CB/bee}" "$@" ;;
  all)                         csh "$AUTO/provision.csh" "$@"
                               csh "$AUTO/deploy.csh"
                               exec csh "$AUTO/run.csh" ;;
  ""|-h|--help|help)
    sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    echo "detected CB=$CB" ;;
  *) echo "rxauto: unknown command '$cmd' (try --help)" >&2; exit 1 ;;
esac
