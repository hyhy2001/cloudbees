# lib.csh - sourced by the other scripts. Do not run directly.
# Resolves the bee binary, shared config, and controller selection. csh is glue only.
#
# IMPORTANT: `exit` inside a sourced tcsh file does NOT stop the parent script - it only ends
# the sourced file, and the caller keeps running with rc=0. So on any fatal error here we still
# `exit 1` (to stop reading lib.csh) but the caller MUST guard with `if ( ! $?LIB_READY )` right
# after `source lib.csh`. LIB_READY is set only on the success path at the bottom of this file.

# auto_env dir (where lib.csh lives); scripts set AUTO_DIR before sourcing.
if ( ! $?AUTO_DIR ) set AUTO_DIR = "."

# Layout (guide S3): RX_AUTO/UTLs/Cloudbees/{bee, auto_env/}
#   -> bee sits next to auto_env, i.e. ../bee. Override with env BEE for dev/testing.
if ( $?BEE ) then
  set BEE = "$BEE"
else
  set BEE = "$AUTO_DIR/../bee"
endif

set PY = "python3 $AUTO_DIR/parse_config.py"
# config.yaml: prefer RXAUTO_CONFIG (exported by rxauto.sh, may live next to it),
# else fall back to ../config.yaml (same Cloudbees/ dir as auto_env/).
if ( $?RXAUTO_CONFIG ) then
  set CONFIG = "$RXAUTO_CONFIG"
else
  set CONFIG = "$AUTO_DIR/../config.yaml"
endif
# complete.yml lives in the Cloudbees dir (one level up from auto_env), next to bee.
set MANIFEST = "$AUTO_DIR/../complete.yml"

if ( ! -x "$BEE" ) then
  echo "lib.csh: bee binary not found at $BEE (set env BEE to override)" ; exit 1
endif

# NOTE: do not use a csh alias with \!* to wrap bee - history expansion breaks
# quoting of args containing spaces/pipes (e.g. --shell "echo X | base64 -d | bash").
# Each script checks `if ($?DRY)` and calls $BEE directly instead.

# NOTE: we no longer run `bee controller select` here. bee persists the active
# controller in its session (per profile), so a one-time `bee controller select`
# right after `bee auth login` sticks for every later command. Re-selecting on
# each step was redundant. If no controller is active, bee itself errors with
# "No active controller selected. Run: bee controller select <name>" — clear enough.
# (config.yaml `controller:` is now advisory only; select it once by hand.)

set LIB_READY = 1
