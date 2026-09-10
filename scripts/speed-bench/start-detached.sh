#!/bin/bash
# Run the speed bench detached so it survives the parent shell exiting.
# (Same pattern as scripts/start-dev.sh — see docs/zai-sandbox-setup.md.)
set -e
cd /home/z/my-project

# Kill any stale bench
pkill -9 -f "speed-bench/run.ts" 2>/dev/null || true
sleep 1

# Args forwarded to the bench script
BENCH_ARGS="${1:---provider=zai --thinking=low}"
OUT_DIR="${2:-download/speed-bench/baseline-zai-low}"
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/bench.log" "$OUT_DIR/ready"

# Detach to PID 1 (tini) so the host doesn't reap us between tool calls.
(
  setsid bash -c "
    cd /home/z/my-project
    bun scripts/speed-bench/run.ts $BENCH_ARGS --out=$OUT_DIR > $OUT_DIR/bench.log 2>&1
    echo DONE > $OUT_DIR/ready
  " >/dev/null 2>&1 &
) >/dev/null 2>&1 &

# Wait up to 12s for the log file to appear
for i in {1..12}; do
  if [ -f "$OUT_DIR/bench.log" ]; then
    echo "[ok] bench started, log: $OUT_DIR/bench.log"
    exit 0
  fi
  sleep 1
done
echo "[fail] bench did not start in 12s"
exit 1
