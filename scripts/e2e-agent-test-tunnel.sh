#!/bin/bash
# e2e-agent-test-tunnel.sh — Test B: TRUE default-client settings.
#
# Simulates what the browser sends with DEFAULT_SETTINGS (provider 'custom',
# kimi-k2-5 @ the legacy pinggy tunnel, placeholder key '123456'). Expected:
# the resolver's preflight probe detects the dead tunnel and swaps to the
# z.ai sandbox (glm-4.7), the turn produces tool calls + patches, and the
# run finalizes honestly.
set -uo pipefail
OUT=/tmp/agent_e2e_tunnel.ndjson
DOC_ID="demo-tunnel"
PROMPT='Design a high-fidelity mobile login screen with logo, email/password fields, and a sign-in button.'
START=$(date +%s)

curl -sN --max-time 540 -X POST http://localhost:3000/api/agent \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"$PROMPT\",\"documentId\":\"$DOC_ID\",\"settings\":{\"llmProvider\":\"custom\",\"apiBaseUrl\":\"https://irhnglwoxe.a.pinggy.link/v1\",\"modelName\":\"kimi-k2-5\",\"apiKey\":\"123456\",\"thinkingLevel\":\"low\"}}" \
  -o "$OUT"
END=$(date +%s)

echo "=== stream duration: $((END-START))s ==="
python3 - "$OUT" <<'PY'
import json, sys, collections
counts = collections.Counter()
patches = 0
tools = collections.Counter()
errors = []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    if obj.get('type') == 'patch':
        patches += 1
        counts['patch'] += 1
    elif obj.get('type') == 'agent_event':
        ev = obj.get('event', {})
        t = ev.get('type', '?')
        counts[t] += 1
        if t == 'agent:model_info':
            print(f"  MODEL: {ev.get('provider')}/{ev.get('modelId')} usedFallback={ev.get('usedFallback')}")
        elif t == 'agent:tool_call_start':
            tools[ev.get('toolName', '?')] += 1
        elif t == 'agent:error':
            errors.append(ev.get('message', '')[:120])
for k, v in sorted(counts.items()):
    print(f"  {k}: {v}")
print("tools:", dict(tools))
print("patch total:", patches)
print("errors:", errors[:4])
PY
