#!/bin/bash
# verify-setup.sh — End-to-end verification that AgentCanvas runs in this sandbox.
# Starts the dev server (same way .zscripts/dev.sh does at boot), polls until
# ready, exercises the page + APIs + canvas-sync service, then shuts down.

set -uo pipefail
cd /home/z/my-project

PASS=0; FAIL=0
ok()   { echo "[PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }

echo "=== Starting Next.js dev server (foreground supervisor) ==="
rm -f dev.log
bun run dev &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null; pkill -P $DEV_PID 2>/dev/null; true' EXIT

echo "Waiting for port 3000..."
READY=0
for i in $(seq 1 90); do
  if curl -s --connect-timeout 1 --max-time 3 -o /dev/null http://localhost:3000; then
    READY=1; echo "Server up after ~${i}s"; break
  fi
  sleep 1
done
[ "$READY" = "1" ] && ok "dev server listening on :3000" || { bad "dev server never came up"; exit 1; }

echo "=== Page check ==="
BODY=$(curl -s --max-time 60 http://localhost:3000)
if echo "$BODY" | grep -q "<title>"; then
  TITLE=$(echo "$BODY" | grep -o "<title>[^<]*</title>" | head -1)
  ok "page served with $TITLE"
else
  bad "page has no <title>"
fi
if echo "$BODY" | grep -q "AgentCanvas\|agent\|canvas" -i; then ok "page body looks like AgentCanvas"; else bad "page body unexpected"; fi

echo "=== API checks ==="
SESS=$(curl -s --max-time 30 http://localhost:3000/api/sessions)
if echo "$SESS" | grep -q "\[" || echo "$SESS" | grep -q "sessions"; then ok "GET /api/sessions -> $SESS"; else bad "GET /api/sessions -> $SESS"; fi

echo "=== canvas-sync (Socket.IO :3003) check ==="
# instrumentation.ts boots the in-process canvas-sync service alongside Next.js
SIO=$(curl -s --max-time 10 "http://localhost:3003/socket.io/?EIO=4&transport=polling")
if echo "$SIO" | grep -q "sid"; then ok "canvas-sync socket.io handshake OK"; else bad "canvas-sync handshake: $SIO"; fi

echo "=== DB check ==="
if [ -f /home/z/my-project/db/custom.db ]; then ok "SQLite db present at db/custom.db"; else bad "db missing"; fi

echo "=== dev.log errors ==="
if grep -qi "error\|failed to compile" dev.log | grep -v "telemetry\|Attention"; then
  bad "errors found in dev.log (see above)"
else
  ok "no compile errors in dev.log"
fi

echo ""
echo "=========================================="
echo "RESULT: $PASS passed, $FAIL failed"
echo "=========================================="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
