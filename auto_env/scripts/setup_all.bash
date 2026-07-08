#!/usr/bin/env bash
# RX AUTO STEP 1-2 (guide S13) - merges general/auto/server_setup into one.
# Runs OUTSIDE CloudBees, once. ALL variables are edited in ../config.yaml (setup: block, S2).
# PREREQ: source my_ride_setup + ./my_cmd + ./my_cmd_for_common must be done manually first.
#
#   setup_all.bash [all|makefile|general|auto|server] [--dry-run]
#     makefile : step 1 S4 - apply RXEWS Makefile mods
#     general  : general_setup - setup_run_cmd (x2) + setup_check_rp_cmd
#     auto     : auto_setup    - setup_for_auto (x2)
#     server   : server_setup  - dashboard + ticket panel + run_rxqor
#     all      : makefile -> general -> auto -> server (default)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
YAML="$HERE/../../config.yaml"
APPLY="$HERE/../rxews_makefile/apply_makefile_mods.py"

PHASE="${1:-all}"; DRY=""
[ "${2:-}" = "--dry-run" ] && DRY=1
[ "$PHASE" = "--dry-run" ] && { DRY=1; PHASE=all; }

# load setup_vars from YAML (only variables that have a value)
eval "$(python3 "$APPLY" emit-vars "$YAML")"
: "${RX_AUTO_ROOT:?set RX_AUTO_ROOT in config.yaml}"
COMMON_RUN_TYPE="${COMMON_RUN_TYPE:-Trunk}"

run(){ if [ -n "$DRY" ]; then echo "[dry] $*"; else "$@"; fi; }

phase_makefile(){
  echo "== STEP 1: RXEWS Makefile mods (S4) =="
  if [ -n "$DRY" ]; then python3 "$APPLY" "$YAML" --dry-run; else python3 "$APPLY" "$YAML"; fi
}

phase_general(){
  echo "== general_setup (S6-general): run + report scripts =="
  cd "$RX_AUTO_ROOT"
  run make setup_run_cmd RX_AUTO_ROOT="$RX_AUTO_ROOT" RXEWS_RUN_DIR_PATH="$TRUNK_IP_RXEWS_RUN_DIR_PATH"
  run make setup_run_cmd RX_AUTO_ROOT="$RX_AUTO_ROOT" RXEWS_RUN_DIR_PATH="$COMMON_RXEWS_RUN_DIR_PATH" RUN_TYPE="$COMMON_RUN_TYPE"
  run make setup_check_rp_cmd RX_AUTO_ROOT="$RX_AUTO_ROOT"
}

phase_auto(){
  echo "== auto_setup (S6-auto): auto + queue scripts =="
  cd "$RX_AUTO_ROOT"
  run make setup_for_auto RX_AUTO_ROOT="$RX_AUTO_ROOT" RXEWS_RUN_DIR_PATH="$TRUNK_IP_RXEWS_RUN_DIR_PATH"
  [ -n "$DRY" ] || sleep 3
  run make setup_for_auto RX_AUTO_ROOT="$RX_AUTO_ROOT" RXEWS_RUN_DIR_PATH="$COMMON_RXEWS_RUN_DIR_PATH" RUN_TYPE="$COMMON_RUN_TYPE"
}

# ENV_BASE: user value wins; else read REV from the dir's Makefile and build path deterministically.
resolve_env_base(){  # $1=current value  $2=rxews dir  $3=RxEnv prefix (e.g. RxEnv-Trunk-IP-VNET)
  [ -n "$1" ] && { echo "$1"; return 0; }
  local rev
  rev=$(grep -m1 '^[[:space:]]*REV[[:space:]]*[?:]*=' "$2/Makefile" | sed 's/.*=[[:space:]]*//' | tr -d ' \t')
  [ -n "$rev" ] || { echo "setup: REV not found in $2/Makefile" >&2; return 1; }
  echo "$2/$3-${rev}"
}

phase_server(){
  echo "== server_setup (S6-server): dashboard + ticket + run_rxqor (GENERATES scripts only) =="
  cd "$RX_AUTO_ROOT"
  TRUNK_IP_ENV_BASE="$(resolve_env_base "${TRUNK_IP_ENV_BASE:-}" "$TRUNK_IP_RXEWS_RUN_DIR_PATH" 'RxEnv-Trunk-IP-VNET')" || exit 1
  COMMON_ENV_BASE="$(resolve_env_base "${COMMON_ENV_BASE:-}" "$COMMON_RXEWS_RUN_DIR_PATH" 'RxEnv-Trunk-VNET')" || exit 1
  run make gen_dashboard_sv_core   RX_AUTO_ROOT="$RX_AUTO_ROOT" DASHBOARD_DB_LOCATION="$DASHBOARD_DB_LOCATION" ENV_BASE="$TRUNK_IP_ENV_BASE" RIDE_ENV_VER="${RIDE_ENV_VER:-}"
  run make gen_dashboard_sv_core   RX_AUTO_ROOT="$RX_AUTO_ROOT" DASHBOARD_DB_LOCATION="$DASHBOARD_DB_LOCATION" ENV_BASE="$COMMON_ENV_BASE" RIDE_ENV_VER="${RIDE_ENV_VER:-}" RUN_TYPE="$COMMON_RUN_TYPE"
  run make gen_ticket_panel_sv_core RX_AUTO_ROOT="$RX_AUTO_ROOT" DASHBOARD_DB_LOCATION="$DASHBOARD_DB_LOCATION" TRUNK_IP_ENV_PATH="$TRUNK_IP_ENV_BASE" COMMON_IP_ENV_PATH="$COMMON_ENV_BASE"
  run make gen_update_dashboard_script RX_AUTO_ROOT="$RX_AUTO_ROOT" DASHBOARD_DB_LOCATION="$DASHBOARD_DB_LOCATION" ENV_BASE="$TRUNK_IP_ENV_BASE"
  run make gen_update_dashboard_script RX_AUTO_ROOT="$RX_AUTO_ROOT" DASHBOARD_DB_LOCATION="$DASHBOARD_DB_LOCATION" ENV_BASE="$COMMON_ENV_BASE" RUN_TYPE="$COMMON_RUN_TYPE"
  run make setup_dashboard_sv      RX_AUTO_ROOT="$RX_AUTO_ROOT" DASHBOARD_DB_LOCATION="$DASHBOARD_DB_LOCATION"
}

case "$PHASE" in
  makefile) phase_makefile ;;
  general)  phase_general ;;
  auto)     phase_auto ;;
  server)   phase_server ;;
  all)      phase_makefile; phase_general; phase_auto; phase_server ;;
  *) echo "usage: setup_all.bash [all|makefile|general|auto|server] [--dry-run]"; exit 1 ;;
esac
echo "== setup_all ($PHASE) done ==${DRY:+  (dry-run)}"
