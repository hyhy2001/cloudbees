#!/bin/csh -f

# Simple demo script: log -> bee command in the middle -> log
# Usage:
#   csh scripts/csh/script_run_with_bee.csh [BEE_CMD]
# Example:
#   csh scripts/csh/script_run_with_bee.csh "bee job list --all"
# Optional:
#   setenv BEE_DIR /path/to/cloudbees

set BEE_CMD = "bee job list"
if ($#argv >= 1) set BEE_CMD = "$1"

# Resolve bee project directory (BEE_DIR override, fallback to script directory).
set bee_dir = ""
if ($?BEE_DIR) then
  set bee_dir = "$BEE_DIR"
endif
if ("$bee_dir" == "") then
  set script_dir = `dirname "$0"`
  if ("$script_dir" == ".") then
    set bee_dir = `pwd`
  else if ("$script_dir" =~ /*) then
    set bee_dir = "$script_dir"
  else
    set bee_dir = "`pwd`/$script_dir"
  endif
endif

set venv_activate = "$bee_dir/.venv/bin/activate.csh"
if (! -f "$venv_activate") then
  echo "[demo] ERROR: missing $venv_activate"
  echo "[demo] Hint: setenv BEE_DIR /path/to/cloudbees"
  exit 1
endif

echo "[demo] start"
date
sleep 2

# In non-interactive csh (-f), `prompt` may be undefined.
# venv activate.csh references `$prompt`, so define a safe default.
if (! $?prompt) then
  set prompt = ""
endif

echo "[demo] sourcing: $venv_activate"
source "$venv_activate"

echo "[demo] running bee command via bs: $BEE_CMD"
bs -os "RHEL7 RHEL8" tcsh -c "$BEE_CMD"
set CMD_STATUS = $status

echo "[demo] bee command exit code: $CMD_STATUS"
sleep 2
echo "[demo] done"
date

exit $CMD_STATUS
