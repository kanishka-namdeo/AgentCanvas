#!/bin/bash
# Persistent dev server launcher. Starts Next.js dev server fully detached
# so it survives the parent shell exiting.
set -e
cd /home/z/my-project

# Kill any existing dev server
pkill -9 -f "next-server" 2>/dev/null || true
pkill -9 -f "next dev" 2>/dev/null || true
pkill -9 -f "bun run dev" 2>/dev/null || true
sleep 1

# Truncate old log
rm -f dev.log

# Start dev server with setsid to create a new session, detached from this shell.
# nohup + setsid + disown = maximum detachment.
setsid bash -c '
  cd /home/z/my-project
  exec bun run dev > /home/z/my-project/dev.log 2>&1
' &
disown

# Wait for the server to be ready
for i in {1..20}; do
  sleep 1
  if curl -sf http://127.0.0.1:3000/ > /dev/null 2>&1; then
    echo "Dev server ready after ${i}s"
    ss -tlnp 2>&1 | grep 3000 || true
    exit 0
  fi
done

echo "Dev server failed to start in 20s"
tail -20 /home/z/my-project/dev.log 2>&1
exit 1
