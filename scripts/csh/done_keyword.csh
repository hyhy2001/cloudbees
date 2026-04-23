#!/bin/csh -f

# Standalone 3-minute log generator for keyword-match scenarios.
# Usage:
#   csh done_keyword.csh [KEYWORD]

set KEYWORD = "Done"
if ($#argv >= 1) set KEYWORD = "$1"

echo "[email-test] keyword case start"
date
sleep 60
echo "[email-test] INFO heartbeat minute-1"
sleep 60
echo "[email-test] ${KEYWORD}: simulated status minute-2"
sleep 60
echo "[email-test] keyword case done"
date
exit 0
