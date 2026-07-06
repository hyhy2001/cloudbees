#!/usr/bin/env bash
# RX AUTO STEP 1-2 (guide S13) - merges general/auto/server_setup into one.
# Runs OUTSIDE CloudBees, once. ALL variables are edited in rxews_makefile/setup.yaml (S2).
#
#   setup_all.bash [all|makefile|general|auto|server] [--dry-run]
#     makefile : step 1 S4 - apply RXEWS Makefile mods
#     general  : general_setup - setup_run_cmd (x2) + setup_check_rp_cmd
#     auto     : auto_setup    - setup_for_auto (x2)
#     server   : server_setup  - dashboard + ticket panel + run_rxqor
#     all      : makefile -> general -> auto -> server (default)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
YAML="$HERE/../rxews_makefile/setup.yaml"
APPLY="$HERE/../rxews_makefile/apply_makefile_mods.py"

PHASE="${1:-all}"; DRY=""
[ "${2:-}" = "--dry-run" ] && DRY=1
[ "$PHASE" = "--dry-run" ] && { DRY=1; PHASE=all; }

# load setup_vars from YAML (only variables that have a value)
eval "$(python3 "$APPLY" emit-vars "$YAML")"
: "${RX_AUTO_ROOT:?set RX_AUTO_ROOT in setup.yaml}"
COMMON_RUN_TYPE="${COMMON_RUN_TYPE:-Trunk}"

run(){ if [ -n "$DRY" ]; then echo "[dry] $*"; else "$@"; fi; }

phase_makefile(){
  echo "== STEP 1: RiDE + RXEWS Makefile mods (S4) =="
  [ -n "${RIDE_ACTIVATE:-}" ] && echo "  (manual S5) source my_ride_setup -> $RIDE_ACTIVATE ; ./my_cmd[_for_common]"
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

phase_server(){
  echo "== server_setup (S6-server): dashboard + ticket + run_rxqor (GENERATES scripts only) =="
  cd "$RX_AUTO_ROOT"
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
