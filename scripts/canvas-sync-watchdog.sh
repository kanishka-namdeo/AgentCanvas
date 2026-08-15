#!/bin/bash
# Watchdog for canvas-sync service — respawns if it dies.
# This script itself runs in the foreground; the parent launcher
# backgrounds it with setsid.

cd /home/z/my-project/mini-services/canvas-sync

while true; do
  echo "[watchdog] starting canvas-sync..."
  bun index.ts 2>&1
  EXIT_CODE=$?
  echo "[watchdog] canvas-sync exited with code $EXIT_CODE, restarting in 2s..."
  sleep 2
done
