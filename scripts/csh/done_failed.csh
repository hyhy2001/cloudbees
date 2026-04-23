#!/bin/csh -f

# Standalone 3-minute mixed log generator.
# Useful after you manually clear filters to verify only condition-based email remains.
# Usage:
#   csh done_failed.csh

echo "[email-test] clear-filter verification case start"
date
sleep 60
echo "[email-test] Done appears minute-1"
sleep 60
echo "[email-test] Failed appears minute-2"
sleep 60
echo "[email-test] clear-filter verification case done"
date
exit 0
