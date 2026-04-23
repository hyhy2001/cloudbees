#!/bin/csh -f

# Standalone 1-minute log generator for regex-match scenarios.
# Usage:
#   csh failed_regex.csh

echo "[email-test] regex case start"
date
sleep 20
echo "[email-test] INFO heartbeat minute-1"
sleep 20
echo "[email-test] Failed: simulated status minute-2"
sleep 20
echo "[email-test] regex case done"
date
exit 0
