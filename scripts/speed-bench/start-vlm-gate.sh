#!/bin/bash
# Run the VLM quality gate — all 8 scenarios, one turn each.
# Resumable: re-running picks up where the previous run left off (inFlight manifest).
#
# Each scenario can take up to 9 minutes (MAX_WAIT=540). The whole run
# can take 60-90 minutes. Detached so it survives between tool calls.
set -e
cd /home/z/my-project

OUT_DIR="${1:-download/vlm-exercise/after-p0-p1}"
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/vlm-gate.log" "$OUT_DIR/ready"

# Detach to PID 1 (tini) so the host doesn't reap us between tool calls.
(
  setsid bash -c "
    cd /home/z/my-project
    MAX_WAIT=560 timeout 580 bun scripts/vlm-inspect/run-scenarios.ts $OUT_DIR > $OUT_DIR/vlm-gate.log 2>&1
    echo DONE > $OUT_DIR/ready
  " >/dev/null 2>&1 &
) >/dev/null 2>&1 &

# Wait up to 12s for the log file to appear
for i in {1..12}; do
  if [ -f "$OUT_DIR/vlm-gate.log" ]; then
    echo "[ok] VLM gate started, log: $OUT_DIR/vlm-gate.log"
    exit 0
  fi
  sleep 1
done
echo "[fail] VLM gate did not start in 12s"
exit 1
