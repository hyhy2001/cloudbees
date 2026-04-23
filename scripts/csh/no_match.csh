#!/bin/csh -f

# Standalone 1-minute log generator for no-match scenarios.
# Usage:
#   csh no_match.csh

echo "[email-test] no-match case start"
date
sleep 20
echo "[email-test] INFO all good minute-1"
sleep 20
echo "[email-test] INFO still healthy minute-2"
sleep 20
echo "[email-test] no-match case done"
date
exit 0
