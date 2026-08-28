#!/bin/bash
# Phase C E2E: full restart-survival cycle in one shot (the sandbox reaps
# background processes between tool calls, so server + probes must live
# within a single invocation).
set -u
cd /home/z/my-project

start_dev() {
  setsid nohup bun run dev > dev.log 2>&1 < /dev/null &
  for i in $(seq 1 60); do
    sleep 2
    if curl -s -m 3 -o /dev/null "http://localhost:3003/socket.io/?EIO=4&transport=polling"; then
      # socket service up; give the app route a moment to compile
      sleep 3
      return 0
    fi
  done
  echo "SERVER FAILED TO START"; tail -5 dev.log; exit 1
}

stop_dev() {
  pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null
  sleep 4
}

echo "=== boot #1 ==="
start_dev
echo "=== phase A ==="
bun scripts/e2e-phase-c-probe.ts
A=$?

stop_dev
echo "=== boot #2 (the RESTART) ==="
start_dev
echo "=== phase B ==="
bun scripts/e2e-phase-c-probe.ts --phase2
B=$?

echo "=== A exit:$A  B exit:$B ==="
exit $(( A + B ))
