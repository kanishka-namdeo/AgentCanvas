#!/bin/bash
# e2e-landing-e2e.sh — reproduce the LANDING-PAGE turn (the one that failed
# live at 12:57-13:02 with variantCount validation errors + watchdog stall)
# against /api/agent and summarize the NDJSON stream.
set -uo pipefail
OUT=/tmp/agent_e2e_landing.ndjson
PROMPT='Make a polished web landing page with a gradient hero, features section, and CTA.'
START=$(date +%s)

curl -sN --max-time 540 -X POST http://localhost:3000/api/agent \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"$PROMPT\",\"documentId\":\"demo\"}" \
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
tool_ends = []
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
        patches.append(f"op={p.get('op')} name={p.get('shape',{}).get('name','?')}")
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
        elif t == 'agent:tool_call_end':
            tool_ends.append((ev.get('toolCallId', '')[:14], ev.get('success'), ev.get('summary', '')[:80]))
        elif t in ('agent:turn_end', 'agent:turn_cancelled', 'agent:turn_final'):
            terminal.append(f"{t} status={ev.get('status', '')} text={ev.get('text', '')[:80]}")

for k, v in sorted(counts.items()):
    print(f"  {k}: {v}")
print("=== tool_call_end outcomes ===")
for tc, ok, s in tool_ends[:10]:
    print(f"  {tc} success={ok} {s}")
print("=== patches (first 10) ===")
for p in patches[:10]:
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
