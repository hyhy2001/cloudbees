#!/bin/csh -f

# Standalone 1-minute log generator for keyword-match scenarios.
# Usage:
#   csh done_keyword.csh [KEYWORD]

set KEYWORD = "Done"
if ($#argv >= 1) set KEYWORD = "$1"

echo "[email-test] keyword case start"
date
sleep 20
echo "[email-test] INFO heartbeat minute-1"
sleep 20
echo "[email-test] ${KEYWORD}: simulated status minute-2"
sleep 20
echo "[email-test] keyword case done"
date
exit 0
