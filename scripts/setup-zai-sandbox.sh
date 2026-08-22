#!/bin/bash
# setup-zai-sandbox.sh — one-shot bring-up of AgentCanvas in the z.ai sandbox.
#
# Assumes the repo is already checked out at /home/z/my-project (the fresh-sandbox
# clone-and-replace step is documented in docs/zai-sandbox-setup.md).
#
# Usage:
#   bash scripts/setup-zai-sandbox.sh             # env + install + DB + start + verify + persist
#   bash scripts/setup-zai-sandbox.sh --verify    # health checks only
#   bash scripts/setup-zai-sandbox.sh --archive   # refresh /home/sync/repo.tar only
#   bash scripts/setup-zai-sandbox.sh --no-start  # env + install + DB only (no server, no verify)
#
# Process-survival rationale (why start-dev.sh exists): the sandbox host kills
# every descendant of a tool call's shell when the call ends. Only processes
# reparented to PID 1 before the call ends survive. See docs/zai-sandbox-setup.md.

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

SANDBOX_DB_URL="file:/home/z/my-project/db/custom.db"
SYNC_ARCHIVE="/home/sync/repo.tar"

MODE="${1:-all}"

PASS=0; FAIL=0
ok()  { echo "[PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }

ensure_env() {
  log_step "env"
  mkdir -p "$ROOT/db"
  if [ ! -f "$ROOT/.env" ]; then
    echo "DATABASE_URL=\"$SANDBOX_DB_URL\"" > "$ROOT/.env"
    ok ".env created with absolute DATABASE_URL"
  elif grep -q "^DATABASE_URL=$SANDBOX_DB_URL\|^DATABASE_URL=\"$SANDBOX_DB_URL\"" "$ROOT/.env"; then
    ok ".env DATABASE_URL already correct"
  else
    # Fix only the DATABASE_URL line; preserve everything else (API keys etc.).
    sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"$SANDBOX_DB_URL\"|" "$ROOT/.env"
    ok ".env DATABASE_URL rewritten to absolute sandbox path"
  fi
}

install_deps() {
  log_step "bun install"
  bun install
}

setup_db() {
  log_step "prisma generate + db push"
  bun run db:generate
  bun run db:push
}

start_server() {
  log_step "dev server"
  if curl -sf --max-time 3 -o /dev/null http://localhost:3000; then
    ok "port 3000 already serving — keeping the running dev server"
    return 0
  fi
  bash scripts/start-dev.sh
  ok "dev server started via scripts/start-dev.sh (orphan-safe)"
}

verify() {
  log_step "verification"

  local body
  body="$(curl -s --max-time 30 http://localhost:3000)" \
    && echo "$body" | grep -q "AgentCanvas" \
    && ok "GET / -> 200 with AgentCanvas markup" \
    || bad "GET / did not return the app"

  local sess
  sess="$(curl -s --max-time 30 http://localhost:3000/api/sessions)" \
    && echo "$sess" | grep -q "sessions" \
    && ok "GET /api/sessions -> JSON" \
    || bad "GET /api/sessions unhealthy: ${sess:0:120}"

  local sio
  sio="$(curl -s --max-time 10 "http://localhost:3003/socket.io/?EIO=4&transport=polling")" \
    && echo "$sio" | grep -q "sid" \
    && ok "canvas-sync socket.io handshake on :3003" \
    || bad "canvas-sync handshake failed: ${sio:0:120}"

  local gw
  gw="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:81/)" \
    && [ "$gw" = "200" ] \
    && ok "gateway :81 -> 200" \
    || bad "gateway :81 returned $gw"

  if [ -f "$ROOT/dev.log" ] && grep -q "Failed to compile" "$ROOT/dev.log"; then
    bad "dev.log contains compile failures"
  else
    ok "no compile failures in dev.log"
  fi

  echo "------------------------------------------"
  echo "RESULT: $PASS passed, $FAIL failed"
  echo "------------------------------------------"
  [ "$FAIL" = "0" ]
}

archive() {
  log_step "persistence archive"
  if [ ! -d /home/sync ]; then
    echo "[SKIP] /home/sync not mounted — not in the z.ai sandbox?"
    return 0
  fi
  tar cf "$SYNC_ARCHIVE" \
    --exclude='./node_modules' \
    --exclude='./.next' \
    --exclude='./skills' \
    --exclude='./upload' \
    --exclude='./dev.log' \
    --exclude='./server.log' \
    --exclude='./.zscripts/*.log' \
    --exclude='./.zscripts/mini-service-*.log' \
    .
  ok "persisted project to $SYNC_ARCHIVE ($(du -h "$SYNC_ARCHIVE" | cut -f1)) — container restarts will restore it and auto-run .zscripts/dev.sh"
}

log_step() {
  echo ""
  echo "=== $1 ==="
}

case "$MODE" in
  --verify)  verify ;;
  --archive) archive ;;
  --no-start)
    ensure_env; install_deps; setup_db
    echo "Done. Start the server with: bash scripts/start-dev.sh"
    ;;
  all)
    ensure_env; install_deps; setup_db; start_server; verify; archive
    ;;
  *)
    echo "Usage: bash scripts/setup-zai-sandbox.sh [--verify|--archive|--no-start]" >&2
    exit 2
    ;;
esac
