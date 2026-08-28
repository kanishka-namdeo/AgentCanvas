#!/bin/bash
# Local orphan-safe dev launcher for AgentCanvas cloned into a subfolder.
# Adapts scripts/start-dev.sh to the actual checkout path /home/z/my-project/AgentCanvas.
set -e
APP_DIR="/home/z/my-project/AgentCanvas"
cd "$APP_DIR"

# Kill any existing dev server
pkill -9 -f "next-server" 2>/dev/null || true
pkill -9 -f "next dev" 2>/dev/null || true
pkill -9 -f "bun run dev" 2>/dev/null || true
sleep 1

rm -f "$APP_DIR/dev.log"

# Orphan-to-init pattern: the wrapping subshell exits mid-call, reparenting
# the setsid'd process to PID 1 (tini) so it survives the tool-call shell exit.
(
  setsid bash -c "
    cd '$APP_DIR'
    exec bun run dev > '$APP_DIR/dev.log' 2>&1
  " >/dev/null 2>&1 &
)

# Wait for the server to be ready (Turbopack cold compile can take ~10-30s)
for i in {1..60}; do
  sleep 1
  if curl -sf http://127.0.0.1:3000/ > /dev/null 2>&1; then
    echo "Dev server ready after ${i}s"
    ss -tlnp 2>&1 | grep 3000 || true
    exit 0
  fi
done

echo "Dev server failed to start in 60s"
tail -40 "$APP_DIR/dev.log" 2>&1
exit 1
