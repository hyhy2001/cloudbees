#!/usr/bin/env bash
set -e

# Run full bee ask benchmark in background, monitor progress, show results.
# Usage: bash scripts/run-benchmark.sh

cd "$(dirname "$0")/.."

LM_URL="${1:-http://127.0.0.1:11434}"
MODEL="${2:-qwen2.5-coder-3b-q4_k_m.gguf}"
LIMIT="${3:-73}"
LOG="/tmp/bee-bench-$$.log"
STARTED_AT=""

cleanup() { rm -f "$LOG"; }
trap cleanup EXIT

echo "=== bee ask Benchmark ==="
echo "  LM:    $LM_URL"
echo "  Model: $MODEL"
echo "  Limit: $LIMIT"
echo ""

STARTED_AT=$(date +%s)

# Start benchmark in background
nohup bun run scripts/benchmark.ts \
  --lm-url "$LM_URL" \
  --model "$MODEL" \
  --llm-limit "$LIMIT" \
  > "$LOG" 2>&1 &
BENCH_PID=$!

echo "  PID: $BENCH_PID"
echo "  Log: $LOG"
echo ""

# Monitor
DOTS=""
while kill -0 "$BENCH_PID" 2>/dev/null; do
  NEW=$(tail -1 "$LOG" 2>/dev/null | grep -o '\.' | wc -c)
  if [ "$NEW" -gt "${#DOTS}" ]; then
    DOTS=$(printf "%*s" "$NEW" "" | tr ' ' '.')
    echo -ne "\r  Queries completed: $NEW/$LIMIT  (elapsed: $(($(date +%s) - STARTED_AT))s)"
  fi
  sleep 5
done

echo ""
echo ""

# Print report summary
if grep -q "Phase B" "$LOG" 2>/dev/null; then
  echo "=== Results ==="
  grep -E "Recall|MRR|Correct|Hallucination|Has flag|Wrong refusal|Failures|Queries" "$LOG" | sed 's/^/  /'
  echo ""
  echo "=== Failures ==="
  grep -A 20 "✗ Failures" "$LOG" 2>/dev/null | head -25 | sed 's/^/  /'
  echo ""
  echo "Total time: $(($(date +%s) - STARTED_AT))s"
else
  echo "Benchmark did not complete. Last output:"
  tail -10 "$LOG"
fi
