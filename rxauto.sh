#!/usr/bin/env bash
# rxauto - single entry point, lives OUTSIDE auto_env.
# Auto-detects the canonical RX_AUTO/UTLs/Cloudbees dir (holds `bee` + auto_env/),
# exports BEE, then dispatches into auto_env.
#
#   rxauto.sh provision|deploy|run|manage [args...]   -> auto_env/*.csh
#   rxauto.sh setup [all|makefile|general|auto|server] [--dry-run]  -> scripts/setup_all.bash
#   rxauto.sh run-setup [makefile|general|auto|server|all]  -> trigger rx_setup job (default all)
#   rxauto.sh run-manual <split_file> [--ip trunk|common] [--wait]  -> ONE build for a custom module list
#   rxauto.sh all                                      -> provision + deploy + rx_setup(--wait) + run
#   rxauto.sh prune [--dry-run]                        -> DELETE infra config no longer wants
#   rxauto.sh pause [--dry-run]                        -> clear schedule on auto jobs (stop firing)
#   rxauto.sh resume [--dry-run]                       -> restore schedule from config
#   rxauto.sh bee <args...>                            -> raw bee passthrough
#
# Switch mode/ip without editing config (override, anywhere in the args):
#   --mode manual|auto     --ip common|trunk|all
#   e.g. rxauto.sh deploy --mode auto --ip all   (2 scheduled jobs: daily_trunk + daily_common)
#        rxauto.sh run --ip all                  (manual: run each job for BOTH trunk + common)
# deploy KEEPS jobs of the other mode (just clears their schedule); use `prune` to delete them.
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

# config.yaml may live next to rxauto.sh (not inside Cloudbees/). Export so lib.csh can find it.
export RXAUTO_CONFIG="$SCRIPT_DIR/config.yaml"

# RX_AUTO_ROOT = the top dir that holds rxauto.sh + config.yaml, and also
# my_cmd/my_ride_setup, the Makefile (setup targets), rxews_* dirs, dashboard_db
# and SUBMIT_LIST. ONLY the 01_*/02_* rx_run scripts live one level down in a
# subdir literally named RX_AUTO/ (which in turn holds UTLs/Cloudbees/). So the
# root is simply where rxauto.sh sits. config.yaml's rx_auto_root overrides.
export RXAUTO_ROOT="$SCRIPT_DIR"

# Pull --mode/--ip out of the args (anywhere) and export as env overrides read by parse_config.
# Everything else stays positional. --mode manual|auto ; --ip common|trunk|all.
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) export RXAUTO_MODE="$2"; shift 2 ;;
    --mode=*) export RXAUTO_MODE="${1#*=}"; shift ;;
    --ip) export RXAUTO_IP="$2"; shift 2 ;;
    --ip=*) export RXAUTO_IP="${1#*=}"; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]}"

# Resolve the rx_setup job path (folder/job) from config; echo it.
setup_job_path() {
  local base jn
  base="$(python3 "$AUTO/parse_config.py" get "$RXAUTO_CONFIG" base_name)"
  jn="$(python3 "$AUTO/parse_config.py" get "$RXAUTO_CONFIG" setup.job_name)"
  [ -n "$jn" ] || jn=rx_setup
  echo "${base:-RX_AUTO}/$jn"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  provision|deploy|run|manage) exec csh "$AUTO/$cmd.csh" "$@" ;;
  pause|resume)                exec csh "$AUTO/$cmd.csh" "$@" ;;
  prune)                       exec csh "$AUTO/manage.csh" prune "$@" ;;
  setup)                       exec bash "$AUTO/scripts/setup_all.bash" "$@" ;;
  run-setup)                   # trigger the rx_setup bee job. Optional 1st arg = phase
                               # (makefile|general|auto|server|all); default all.
                               phase="all"
                               case "${1:-}" in
                                 makefile|general|auto|server|all) phase="$1"; shift ;;
                                 "") ;;
                                 -*) ;;   # a flag, not a phase -> leave default, pass through
                                 *) echo "rxauto: bad phase '$1' (use makefile|general|auto|server|all)" >&2; exit 1 ;;
                               esac
                               exec "${BEE:-$CB/bee}" job run "$(setup_job_path)" -p "PHASE=$phase" "$@" ;;
  run-manual)                  # run ONE manual build for a custom module list, regardless of mode.
                               # usage: rxauto.sh run-manual <split_file> [--wait] [--ip trunk|common]
                               # (--ip is pulled out earlier into RXAUTO_IP; default from config)
                               sf="${1:-}"; shift || true
                               [ -n "$sf" ] || { echo "usage: rxauto.sh run-manual <split_file> [--ip trunk|common] [--wait]" >&2; exit 1; }
                               jobp="$(python3 "$AUTO/parse_config.py" first-manual-job "$RXAUTO_CONFIG")"
                               [ -n "$jobp" ] || { echo "rxauto: no manual job (need at least one entry in accounts:)" >&2; exit 1; }
                               ipm="$(RXAUTO_IP="${RXAUTO_IP:-}" python3 "$AUTO/parse_config.py" eff-ip "$RXAUTO_CONFIG")"
                               [ "$ipm" = all ] && ipm=trunk   # a single build needs one concrete script
                               echo "run-manual: $jobp  IP_MODE=$ipm  SPLIT_FILE=$sf"
                               exec "${BEE:-$CB/bee}" job run "$jobp" -p "IP_MODE=$ipm" -p "SPLIT_FILE=$sf" "$@" ;;
  bee)                         exec "${BEE:-$CB/bee}" "$@" ;;
  all)                         # full pipeline: provision -> deploy -> rx_setup (wait) -> run
                               csh "$AUTO/provision.csh" "$@" || { echo "rxauto: provision failed (rc=$?), aborting" >&2; exit 1; }
                               csh "$AUTO/deploy.csh" "$@" || { echo "rxauto: deploy failed (rc=$?), aborting" >&2; exit 1; }
                               # step 1-2: trigger rx_setup and BLOCK until it finishes (--wait),
                               # so step 3 only runs once the environment is set up.
                               "${BEE:-$CB/bee}" job run "$(setup_job_path)" -p "PHASE=all" --wait \
                                 || { echo "rxauto: rx_setup job failed (rc=$?), aborting run" >&2; exit 1; }
                               exec csh "$AUTO/run.csh" "$@" ;;
  ""|-h|--help|help)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    echo "detected CB=$CB" ;;
  *) echo "rxauto: unknown command '$cmd' (try --help)" >&2; exit 1 ;;
esac
