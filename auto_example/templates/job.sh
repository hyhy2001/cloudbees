#!/usr/bin/env bash
# RX AUTO STEP 3 - bee bakes this into --shell.
# This is only a DEFAULT template; the real body comes from config.yaml (auto.command / manual.command).
# Build param from Jenkins env: $IP_MODE (common|trunk). Manual uses no index - jobs self-claim.
#
# Mapping (guide S3/S6): TrunkIP -> 01_*  |  Common -> 02_*
#   IP_MODE=trunk  -> 01_go_rx_auto.bash / 01_rx_run_ip_unit.bash
#   IP_MODE=common -> 02_go_rx_auto.bash / 02_rx_run_common_ip_unit.bash
set -euo pipefail

RX_AUTO_ROOT="${RX_AUTO_ROOT:-TODO}"          # set via job env or the config command
cd "$RX_AUTO_ROOT/RX_AUTO"

if [ "${IP_MODE:-common}" = "trunk" ]; then PFX=01; else PFX=02; fi
echo "[job] IP_MODE=${IP_MODE:-common} PFX=$PFX"

# --- auto: orchestrator (detect -> queue -> run all). ---
#   ./${PFX}_go_rx_auto.bash
#
# --- manual: work-stealing. N jobs = N workers scanning SUBMIT_LIST, claiming files via mkdir. ---
#   accounts > splits -> extra workers idle; accounts < splits -> workers keep claiming next file.
#   (SUBMIT_LIST must be shared across nodes for the shared claim dir.)
#
# (draft) the real body lives in config.yaml (auto.command / manual.command).
echo "[job] draft - put the real step 3 command in config.yaml (auto.command / manual.command)"
