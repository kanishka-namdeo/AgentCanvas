#!/bin/bash
# visual-test.sh — Browser-driven visual verification of the agent.
#
# For each visual scenario: reset the canvas (New chat), submit the prompt
# through the REAL UI (socket.io path), wait for the turn to finish (the
# inline Stop button disappears), screenshot, and check console errors.
#
# Usage: bash scripts/agent-eval/visual-test.sh [scenario_id ...]
# Requires: dev server on :3000, agent-browser CLI installed.

set -u
cd "$(dirname "$0")/../.."

OUT_DIR="download/agent-eval"
mkdir -p "$OUT_DIR"

# id|prompt|wait_seconds
ALL_SCENARIOS=(
  "login-hifi|Design a polished, high-fidelity mobile login screen for a fintech app called 'Vaultly' with an email field, a password field, and a Sign In button.|180"
  "wireframe-lofi|Draw a low-fidelity wireframe of a blog homepage: header with nav, one hero article block, and a 3-card article grid.|180"
  "flowchart|Create a flowchart for a document approval process with 4 nodes: Start, Review, Approve, End — connected with arrows.|150"
  "dashboard-hifi|Design a high-fidelity analytics dashboard header bar plus a row of 4 KPI stat cards showing Revenue \$128.4K, Active Users 8,421, Churn 2.1%, and NPS 62.|180"
)

if [ "$#" -gt 0 ]; then
  SELECTED=("$@")
else
  SELECTED=()
fi

matches_selection() {
  local id="$1"
  if [ ${#SELECTED[@]} -eq 0 ]; then return 0; fi
  for s in "${SELECTED[@]}"; do [[ "$s" == "$id" ]] && return 0; done
  return 1
}

echo "== AgentCanvas visual test =="
agent-browser open http://localhost:3000 >/dev/null 2>&1
agent-browser wait --load networkidle >/dev/null 2>&1 || true
agent-browser set viewport 1600 900 >/dev/null 2>&1 || true

PASS=0; FAIL=0
for entry in "${ALL_SCENARIOS[@]}"; do
  IFS='|' read -r id prompt max_wait <<< "$entry"
  matches_selection "$id" || continue

  echo ""
  echo "▶ $id"
  # 1. Fresh canvas: New chat resets the document (EMPTY_DOC).
  agent-browser find role button click --name "New chat" >/dev/null 2>&1 || true
  sleep 2

  # 2. Submit the prompt through the agent panel textarea.
  agent-browser find role textbox fill --name "Ask the agent to design something…  (⌘K for prompts)" "$prompt" >/dev/null 2>&1 \
    || agent-browser eval "(() => { const t = document.querySelector('textarea[placeholder*=\"Ask the agent\"]'); if (!t) return 'no-textarea'; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(t, $(printf '%s' "$(printf '%s' "\"$prompt\"" | sed 's/"/\\"/g')")); t.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()" >/dev/null 2>&1
  sleep 1
  agent-browser press Enter >/dev/null 2>&1

  # 3. Wait for turn completion: the inline Stop button disappears.
  deadline=$(( $(date +%s) + max_wait ))
  stopped=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    n=$(agent-browser get count 'button[title="Stop the agent (Esc also works)"]' 2>/dev/null | tr -d '[:space:]')
    if [ "$n" != "1" ]; then
      # give streaming a moment to start before trusting the absence
      sleep 6
      n2=$(agent-browser get count 'button[title="Stop the agent (Esc also works)"]' 2>/dev/null | tr -d '[:space:]')
      if [ "$n2" != "1" ]; then stopped=1; break; fi
    fi
    sleep 4
  done

  if [ "$stopped" = "1" ]; then
    echo "  turn finished — capturing"
  else
    echo "  WARNING: still streaming after ${max_wait}s — capturing anyway"
  fi

  # 4. Screenshot + console error check.
  shot="$OUT_DIR/$id.png"
  agent-browser screenshot "$shot" >/dev/null 2>&1
  errs=$(agent-browser errors 2>/dev/null | rg -v "^stderr:|launched browser" | head -5)
  if [ -n "$errs" ]; then
    echo "  ❌ console errors:"; echo "$errs"
    FAIL=$((FAIL+1))
  else
    echo "  ✅ no console errors"
    PASS=$((PASS+1))
  fi
  echo "  screenshot: $shot"

  # cooldown between visual runs (rate-limit guard)
  echo "  … cooldown 60s"
  sleep 60
done

agent-browser close >/dev/null 2>&1 || true
echo ""
echo "=========================================="
echo "VISUAL RESULT: $PASS clean, $FAIL with console errors"
echo "Screenshots in $OUT_DIR/"
