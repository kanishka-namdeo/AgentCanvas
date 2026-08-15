#!/bin/bash
# Persistent canvas-sync service launcher.
set -e
cd /home/z/my-project/mini-services/canvas-sync

pkill -9 -f "canvas-sync" 2>/dev/null || true
pkill -9 -f "bun.*mini-services/canvas-sync" 2>/dev/null || true
sleep 1

# Same pattern that works for the dev server: setsid + bash -c + exec + disown.
setsid bash -c '
  cd /home/z/my-project/mini-services/canvas-sync
  exec bun run dev > /home/z/my-project/.zscripts/canvas-sync.log 2>&1
' < /dev/null &
disown

for i in {1..10}; do
  sleep 1
  if ss -tlnp 2>&1 | grep -q ":3003"; then
    echo "canvas-sync ready after ${i}s"
    ss -tlnp 2>&1 | grep 3003
    exit 0
  fi
done

echo "canvas-sync failed to start in 10s"
tail -20 /home/z/my-project/.zscripts/canvas-sync.log 2>&1
exit 1
