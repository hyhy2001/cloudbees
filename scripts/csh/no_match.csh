#!/bin/csh -f

# Standalone 3-minute log generator for no-match scenarios.
# Usage:
#   csh no_match.csh

echo "[email-test] no-match case start"
date
sleep 60
echo "[email-test] INFO all good minute-1"
sleep 60
echo "[email-test] INFO still healthy minute-2"
sleep 60
echo "[email-test] no-match case done"
date
exit 0
