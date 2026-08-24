#!/usr/bin/env bash
# endpoint-switch-verify.sh — verify + ship the default-endpoint switch
# (custom OpenAI-compatible server: kimi-k2-5 via pinggy tunnel).
#
# Design constraints:
#   - NEVER exits early: every step reports PASS/FAIL and we keep going.
#   - Appends everything to scripts/endpoint-switch-verify.log.
#   - Idempotent: safe to re-run (log grows, git steps become no-ops).
#   - Masks any credential-looking string (github_pat_*, URL user:pass@)
#     before it reaches the log.
#   - Intended to be launched ORPHANED:
#       ( setsid bash scripts/endpoint-switch-verify.sh >/dev/null 2>&1 & )

ROOT=/home/z/my-project
LOG="$ROOT/scripts/endpoint-switch-verify.log"
cd "$ROOT" || true

mask() {
  sed -E \
    -e 's/github_pat_[A-Za-z0-9_]+/github_pat_***MASKED***/g' \
    -e 's#(https?://[^:/@[:space:]]+):[^@[:space:]]+@#\1:***MASKED***@#g'
}

log() { printf '%s\n' "$*" >> "$LOG"; }
stamp() { date -u +'%Y-%m-%d %H:%M:%S UTC'; }

log ""
log "=================================================="
log "=== START $(stamp) ==="
log "=================================================="

# ---- (a) DB setup: generate Prisma client --------------------------------
# The /api/sessions route imports src/lib/db.ts, which imports
# @prisma/client, which requires the generated client at
# node_modules/.prisma/client/default. If that's missing (e.g. after a
# fresh `bun install` that didn't run `prisma generate`), every GET
# /api/sessions returns HTTP 500 with
# "Cannot find module '.prisma/client/default'". Regenerating the client
# here ensures the dev server's turbopack picks up the files on the next
# request — fixing the 500 without needing to restart the dev server.
log ""
log "--- DB-SETUP: bun run db:generate (prisma generate) ---"
if timeout 120 bun run db:generate >> "$LOG" 2>&1; then
  log "DB-SETUP: PASS"
else
  log "DB-SETUP: FAIL (exit $? — see output above)"
fi

# ---- (b) Health: dev server up? -------------------------------------------
HC=$(curl -s --max-time 30 -o /dev/null -w '%{http_code}' http://localhost:3000 || true)
log "HEALTH: GET / -> ${HC:-000}"
case "$HC" in
  200|204|301|302|307|308) log "HEALTH: PASS" ;;
  *) log "HEALTH: FAIL" ;;
esac

# ---- (c) Compile check (recent dev.log window) -----------------------------
if [ -f "$ROOT/dev.log" ] && tail -c 200000 "$ROOT/dev.log" 2>/dev/null | grep -q 'Failed to compile'; then
  log "COMPILE: FAIL ('Failed to compile' present in recent dev.log)"
  tail -c 200000 "$ROOT/dev.log" 2>/dev/null | grep -A 4 'Failed to compile' | tail -24 >> "$LOG"
else
  log "COMPILE: OK (no 'Failed to compile' in recent dev.log)"
fi

# ---- (d) Default-LLM verification (REAL completion through pinggy) ---------
log ""
log "--- VERIFY-LLM: bun scripts/verify-default-llm.ts ---"
if timeout 240 bun scripts/verify-default-llm.ts >> "$LOG" 2>&1; then
  log "VERIFY-LLM: PASS"
else
  log "VERIFY-LLM: FAIL (exit $? — see output above)"
fi

# ---- (e) API smoke test: POST /api/agent with NO settings field ------------
# Uses the new defaults end-to-end (route -> runner-native -> resolver ->
# synthetic custom Model -> pinggy endpoint). Looks for assistant text
# deltas and tool_call events vs agent:error.
log ""
log "--- API SMOKE: POST /api/agent (no settings field) ---"
SMOKE_OUT=$(mktemp)
SMOKE_BODY=$(mktemp)
printf '%s' '{"documentId":"endpoint-switch-smoke","prompt":"Create a rectangle anywhere on the canvas with fill #3b82f6 and title SmokeTest, then reply with exactly: DONE"}' > "$SMOKE_BODY"
SHTTP=$(curl -s --max-time 150 -o "$SMOKE_OUT" -w '%{http_code}' \
  -X POST http://localhost:3000/api/agent \
  -H 'content-type: application/json' \
  --data-binary "@$SMOKE_BODY" || true)
log "API-SMOKE HTTP: ${SHTTP:-000}"
log "--- first ~2500 chars of NDJSON stream ---"
head -c 2500 "$SMOKE_OUT" >> "$LOG"
log ""
log "--- end of stream excerpt ---"
NDELTA=$(grep -c 'agent:message_delta' "$SMOKE_OUT" 2>/dev/null || true)
NTOOL=$(grep -c 'agent:tool_call_start' "$SMOKE_OUT" 2>/dev/null || true)
NPATCH=$(grep -c '"type":"patch"' "$SMOKE_OUT" 2>/dev/null || true)
NERR=$(grep -c 'agent:error' "$SMOKE_OUT" 2>/dev/null || true)
log "API-SMOKE counts: message_delta=${NDELTA:-0} tool_call_start=${NTOOL:-0} patch=${NPATCH:-0} agent:error=${NERR:-0}"
if grep -q 'agent:error' "$SMOKE_OUT" 2>/dev/null; then
  log "API-SMOKE: FAIL (agent:error in stream)"
  grep -o '"type":"agent:error"[^}]*' "$SMOKE_OUT" 2>/dev/null | head -5 >> "$LOG"
elif [ "${NPATCH:-0}" -le 0 ]; then
  # Task 7-g Fix 4 — TIGHTENED PASS criteria. The old logic was
  # `NDELTA>0 || NTOOL>0 || NPATCH>0` (OR-disjunction), which caused a FALSE
  # POSITIVE in Task 7-f: the agent text-responded (NDELTA=135) but produced
  # ZERO patches (NPATCH=0) — empty canvas. The new criteria requires
  # NPATCH > 0 as a MANDATORY check (real shape creation) so a text-only
  # response with no shapes fails.
  log "API-SMOKE: FAIL (agent produced no shapes — canvas empty, patch count = 0; NDELTA=${NDELTA:-0} NTOOL=${NTOOL:-0})"
elif [ "${NDELTA:-0}" -gt 0 ] || [ "${NTOOL:-0}" -gt 0 ]; then
  log "API-SMOKE: PASS (agent ran end-to-end through the default endpoint + produced ${NPATCH:-0} shape patch(es))"
else
  log "API-SMOKE: FAIL (no agent activity evidence in stream)"
fi
if [ "${NTOOL:-0}" -gt 0 ]; then
  log "API-SMOKE-TOOLCALLS: YES (function calling works through the tunnel)"
else
  log "API-SMOKE-TOOLCALLS: NO"
fi
rm -f "$SMOKE_OUT" "$SMOKE_BODY"

# ---- (f) Typecheck ----------------------------------------------------------
log ""
log "--- TYPECHECK: bun run typecheck ---"
if timeout 300 bun run typecheck >> "$LOG" 2>&1; then
  log "TYPECHECK: PASS"
else
  log "TYPECHECK: FAIL (exit $? — see output above)"
fi

# ---- (g) Tests ---------------------------------------------------------------
log ""
log "--- TESTS: bun run test ---"
if timeout 480 bun run test >> "$LOG" 2>&1; then
  log "TESTS: PASS"
else
  log "TESTS: FAIL (exit $? — see output above)"
fi

# ---- (h) Git: commit + push --------------------------------------------------
log ""
log "--- GIT ---"
log "--- git status --short (first 40 lines) ---"
git status --short 2>/dev/null | head -40 | mask >> "$LOG"
git add -A >> "$LOG" 2>&1 || true
if git commit -m "feat(llm): switch default inference endpoint to custom OpenAI-compatible server (kimi-k2-5)" >> "$LOG" 2>&1; then
  log "COMMIT: OK $(git rev-parse --short HEAD 2>/dev/null || true)"
else
  log "COMMIT: NOTHING-TO-COMMIT (or commit failed — see git output above)"
fi

git_push_once() {
  local out st
  out="$(git push origin HEAD 2>&1)"; st=$?
  printf '%s\n' "$out" | mask >> "$LOG"
  return $st
}
if git_push_once; then
  log "PUSH: PASS"
else
  log "PUSH: first attempt failed — retrying after git pull --rebase origin HEAD"
  POUT="$(git pull --rebase origin HEAD 2>&1)"; PST=$?
  printf '%s\n' "$POUT" | mask >> "$LOG"
  if [ "$PST" -eq 0 ]; then
    if git_push_once; then
      log "PUSH: PASS (after rebase)"
    else
      log "PUSH: FAIL"
    fi
  else
    log "PUSH: FAIL (git pull --rebase failed)"
  fi
fi
log "GIT HEAD: $(git log -1 --format='%h %s' 2>/dev/null | mask)"

# ---- (i) Persistence archive --------------------------------------------------
log ""
log "--- ARCHIVE: bash scripts/setup-zai-sandbox.sh --archive ---"
if timeout 300 bash scripts/setup-zai-sandbox.sh --archive >> "$LOG" 2>&1; then
  if tail -n 20 "$LOG" | grep -q '\[PASS\] persisted project'; then
    log "ARCHIVE: PASS"
  else
    log "ARCHIVE: PASS (script exited 0; [PASS] line not detected — check output above)"
  fi
else
  log "ARCHIVE: FAIL (exit $?)"
fi

# ---- (j) Done ------------------------------------------------------------------
log ""
log "=================================================="
log "=== DONE $(stamp) ==="
log "=================================================="
