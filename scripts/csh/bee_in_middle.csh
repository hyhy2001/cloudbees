#!/bin/csh -f

# Simple demo script: log -> bee command in the middle -> log
# Usage:
#   csh scripts/csh/bee_in_middle.csh [BEE_CMD]
# Example:
#   csh scripts/csh/bee_in_middle.csh "bee job list --all"

set BEE_CMD = "bee job list"
if ($#argv >= 1) set BEE_CMD = "$1"

echo "[demo] start"
date
sleep 2

echo "[demo] running bee command: $BEE_CMD"
$BEE_CMD
set CMD_STATUS = $status

echo "[demo] bee command exit code: $CMD_STATUS"
sleep 2
echo "[demo] done"
date

exit $CMD_STATUS
