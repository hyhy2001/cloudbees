#!/bin/csh -f

# Simple demo script: log -> bee command in the middle -> log
# Usage:
#   csh scripts/csh/bee_in_middle.csh [BEE_CMD]
# Example:
#   csh scripts/csh/bee_in_middle.csh "bee job list --all"

set BEE_CMD = "bee job list"
if ($#argv >= 1) set BEE_CMD = "$1"

# Resolve bee binary directory, then source setup_env.csh there.
# You can override by exporting BEE_DIR before running this script.
set bee_dir = "$env:BEE_DIR"
if ("$bee_dir" == "") then
  set bee_bin = `which bee 2>/dev/null`
  if ("$bee_bin" == "") then
    echo "[demo] ERROR: cannot find 'bee' in PATH. Set BEE_DIR manually."
    exit 1
  endif
  set bee_dir = `dirname "$bee_bin"`
endif

if (! -f "$bee_dir/setup_env.csh") then
  echo "[demo] ERROR: missing $bee_dir/setup_env.csh"
  exit 1
endif

echo "[demo] start"
date
sleep 2

echo "[demo] sourcing: $bee_dir/setup_env.csh"
source "$bee_dir/setup_env.csh"

echo "[demo] running bee command: $BEE_CMD"
$BEE_CMD
set CMD_STATUS = $status

echo "[demo] bee command exit code: $CMD_STATUS"
sleep 2
echo "[demo] done"
date

exit $CMD_STATUS
