#!/bin/bash
# e2e-agent-test-zai.sh — tool-calling reliability verification (Task 3).
#
# Runs the login-screen design turn against POST /api/agent with EXPLICIT
# z.ai sandbox settings (provider 'zai' → glm-5.3, skipping the dead pinggy
# tunnel entirely), then summarizes the NDJSON stream:
#   - event-type counts (patches, tool calls, errors)
#   - terminal status (turn_final / turn_end)
#   - persisted shape count for document 'demo-zai'
#
# Usage: bash scripts/e2e-agent-test-zai.sh
set -uo pipefail
OUT=/tmp/agent_e2e_zai.ndjson
DOC_ID="demo-zai"
PROMPT='Design a high-fidelity mobile login screen with logo, email/password fields, and a sign-in button.'
START=$(date +%s)

curl -sN --max-time 540 -X POST http://localhost:3000/api/agent \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"$PROMPT\",\"documentId\":\"$DOC_ID\",\"settings\":{\"llmProvider\":\"zai\",\"thinkingLevel\":\"low\",\"maxDesignCritiqueIterations\":0}}" \
  -o "$OUT"
END=$(date +%s)

echo "=== stream duration: $((END-START))s ==="
echo "=== event type counts ==="
python3 - "$OUT" <<'PY'
import json, sys, collections
counts = collections.Counter()
patches = []
progress = []
errors = []
terminal = []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    if obj.get('type') == 'patch':
        counts['patch'] += 1
        p = obj.get('patch', {})
        patches.append(f"op={p.get('op')} name={p.get('shape',{}).get('name','?')} id={str(p.get('shapeId'))[:12]}")
    elif obj.get('type') == 'agent_event':
        ev = obj.get('event', {})
        t = ev.get('type', '?')
        counts[t] += 1
        if t == 'agent:tool_progress':
            progress.append(ev.get('text', '')[:90])
        elif t == 'agent:tool_call_start':
            counts['tool:' + ev.get('toolName', '?')] += 1
        elif t == 'agent:error':
            errors.append(ev.get('message', '')[:140])
        elif t == 'agent:model_info':
            print(f"  model: {ev.get('provider')}/{ev.get('modelId')} usedFallback={ev.get('usedFallback')}")
        elif t in ('agent:turn_end', 'agent:turn_cancelled', 'agent:turn_final'):
            terminal.append(f"{t} status={ev.get('status', '')} text={ev.get('text', '')[:80]}")

for k, v in sorted(counts.items()):
    print(f"  {k}: {v}")
print("=== patches ===")
for p in patches[:12]:
    print("  " + p)
print("=== progress (first 8) ===")
for p in progress[:8]:
    print("  " + p)
print("=== errors ===")
for e in errors[:5]:
    print("  " + e)
print("=== terminal ===")
for t in terminal[:3]:
    print("  " + t)
PY
echo "=== shape count in DB ==="
bun -e "import {createClient} from '@libsql/client'; const db=createClient({url:'file:/home/z/my-project/db/custom.db'}); const r=await db.execute(\"SELECT COUNT(*) c FROM Shape WHERE documentId='$DOC_ID'\"); console.log('shapes:', r.rows[0].c);" 2>/dev/null || echo "(shape count query skipped)"
