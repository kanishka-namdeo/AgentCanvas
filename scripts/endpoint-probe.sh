#!/usr/bin/env bash
# endpoint-probe.sh — raw diagnosis of the custom OpenAI-compatible endpoint
# (https://irhnglwoxe.a.pinggy.link/v1, key 123456, model kimi-k2-5), plus a
# re-run of the end-to-end default-LLM verification in case the earlier empty
# responses were transient (pinggy tunnels are flaky by nature).
# Appends to scripts/endpoint-probe.log. Never exits early.

ROOT=/home/z/my-project
LOG="$ROOT/scripts/endpoint-probe.log"
EP=https://irhnglwoxe.a.pinggy.link/v1
KEY=123456
cd "$ROOT" || true

{
echo ""
echo "=================================================="
echo "=== PROBE START $(date -u +'%Y-%m-%d %H:%M:%S UTC') ==="
echo "=================================================="

echo "--- [P1] GET $EP/models ---"
curl -sS -m 30 -o /tmp/probe-models.json -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $KEY" "$EP/models" 2>&1 || true
head -c 2000 /tmp/probe-models.json 2>/dev/null; echo

echo ""
echo "--- [P2] POST /chat/completions (non-stream, no tools) ---"
curl -sS -m 60 -o /tmp/probe-chat.json -w "HTTP %{http_code}\n" -X POST "$EP/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"kimi-k2-5","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":64}' 2>&1 || true
head -c 3000 /tmp/probe-chat.json 2>/dev/null; echo

echo ""
echo "--- [P3] POST /chat/completions (stream + tools) ---"
curl -sS -m 90 -o /tmp/probe-stream.txt -w "HTTP %{http_code}\n" -X POST "$EP/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"kimi-k2-5","stream":true,"messages":[{"role":"user","content":"Call the add_rectangle tool with x=10, y=10, width=100, height=80, fill=#3b82f6."}],"max_tokens":256,"tools":[{"type":"function","function":{"name":"add_rectangle","description":"Add a rectangle to the canvas","parameters":{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"},"width":{"type":"number"},"height":{"type":"number"},"fill":{"type":"string"}},"required":["x","y","width","height"]}}}]}' 2>&1 || true
echo "SSE bytes: $(wc -c < /tmp/probe-stream.txt 2>/dev/null), lines: $(wc -l < /tmp/probe-stream.txt 2>/dev/null)"
head -c 4000 /tmp/probe-stream.txt 2>/dev/null; echo

echo ""
echo "--- [P4] re-run: bun scripts/verify-default-llm.ts ---"
if timeout 240 bun scripts/verify-default-llm.ts 2>&1; then
  echo "P4 VERIFY-LLM: PASS"
else
  echo "P4 VERIFY-LLM: FAIL"
fi

echo ""
echo "--- [P5] re-run: POST /api/agent smoke (no settings field) ---"
SMOKE_OUT=$(mktemp)
printf '%s' '{"documentId":"endpoint-switch-smoke","prompt":"Create a rectangle anywhere on the canvas with fill #3b82f6 and title SmokeTest, then reply with exactly: DONE"}' > /tmp/probe-smoke-body.json
SHTTP=$(curl -s --max-time 150 -o "$SMOKE_OUT" -w '%{http_code}' \
  -X POST http://localhost:3000/api/agent \
  -H 'content-type: application/json' \
  --data-binary @/tmp/probe-smoke-body.json || true)
echo "P5 HTTP: ${SHTTP:-000}"
echo "P5 counts: message_delta=$(grep -c 'agent:message_delta' "$SMOKE_OUT" 2>/dev/null || echo 0) tool_call_start=$(grep -c 'agent:tool_call_start' "$SMOKE_OUT" 2>/dev/null || echo 0) patch=$(grep -c '\"type\":\"patch\"' "$SMOKE_OUT" 2>/dev/null || echo 0) agent:error=$(grep -c 'agent:error' "$SMOKE_OUT" 2>/dev/null || echo 0)"
echo "--- P5 first 2500 chars ---"
head -c 2500 "$SMOKE_OUT"; echo
echo "--- P5 end ---"
rm -f "$SMOKE_OUT"

echo ""
echo "=== PROBE DONE $(date -u +'%Y-%m-%d %H:%M:%S UTC') ==="
} >> "$LOG" 2>&1
