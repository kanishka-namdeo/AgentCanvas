#!/bin/bash
# final-validation.sh — wait for LLM endpoint recovery, then run the two
# remaining validations unattended:
#   1. wireframe-lofi e2e scenario (round 6) — validates the fidelity=lofi fix
#   2. browser visual tests for 4 scenarios — screenshots to download/agent-eval/
#
# Polls the endpoint every 60s for up to 90 min, then runs everything and
# logs to scripts/agent-eval/results/final-validation.log

set -u
cd "$(dirname "$0")/../.."
LOG=scripts/agent-eval/results/final-validation.log
echo "== final-validation started $(date -Is) ==" >> "$LOG"

probe() {
  python3 - <<'EOF'
import json, urllib.request, sys
try:
    cfg = json.load(open('/etc/.z-ai-config'))
    req = urllib.request.Request(cfg['baseUrl'].rstrip('/') + '/chat/completions', method='POST',
        data=json.dumps({'model':'glm-5.3','messages':[{'role':'user','content':'OK'}],'max_tokens':4,'stream':False}).encode(),
        headers={'Content-Type':'application/json','Authorization':'Bearer '+cfg.get('apiKey','Z.ai'),
                 'X-Token':cfg['token'],'X-User-Id':cfg['userId'],'X-Chat-Id':cfg['chatId'],'X-Z-AI-From':'Z'})
    r = urllib.request.urlopen(req, timeout=30)
    sys.exit(0 if r.status == 200 else 1)
except Exception:
    sys.exit(1)
EOF
}

# 1. Wait for recovery (up to 90 min)
deadline=$(( $(date +%s) + 5400 ))
until probe; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "endpoint never recovered within 90min — aborting $(date -Is)" >> "$LOG"
    exit 1
  fi
  sleep 60
done
echo "endpoint recovered $(date -Is)" >> "$LOG"
sleep 30  # settle

# 2. Round 6: wireframe-lofi scenario (the one fidelity=lofi fix targets)
echo "== round6 wireframe-lofi $(date -Is) ==" >> "$LOG"
bun scripts/agent-eval/run-eval.ts --only=wireframe-lofi --delay=0 --out=results/round6 >> "$LOG" 2>&1
echo "round6 exit=$?" >> "$LOG"

sleep 60  # cooldown before browser runs

# 3. Visual browser tests (screenshots + console-error check)
echo "== visual tests $(date -Is) ==" >> "$LOG"
bash scripts/agent-eval/visual-test.sh login-hifi wireframe-lofi dashboard-hifi flowchart >> "$LOG" 2>&1
echo "visual exit=$?" >> "$LOG"

echo "== final-validation complete $(date -Is) ==" >> "$LOG"
