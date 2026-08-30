#!/bin/bash
# AgentCanvas visual stress-test harness — sourced by test driver calls.
# Uses agent-browser CLI against the gateway (live sync) at :81.

GW="http://localhost:81"
SHOTS="/home/z/my-project/download/stress-test/shots"
RESULTS="/home/z/my-project/download/stress-test/results.md"

# ---- helpers ----------------------------------------------------------

ab() { agent-browser "$@"; }

# Authoritative busy check: textarea placeholder swaps while a turn is running.
busy() {
  local ph
  ph=$(timeout 25 agent-browser eval "document.querySelector('textarea').placeholder" 2>/dev/null | tail -1)
  [ "$ph" = '"Queue a follow-up message… it sends when this turn finishes"' ]
}

# Wait until agent idle (busy flag false for N consecutive seconds).
# usage: wait_idle <max_seconds> [settle_seconds]
wait_idle() {
  local max=${1:-360} settle=${2:-15}
  local start=$(date +%s) stable=0
  while true; do
    local now=$(date +%s); local elapsed=$((now - start))
    if [ $elapsed -gt $max ]; then echo "TIMEOUT(${max}s)"; return 1; fi
    if ! busy; then
      stable=$((stable + 10))
      if [ $stable -ge $settle ]; then echo "IDLE(${elapsed}s)"; return 0; fi
      sleep 10
    else
      stable=0
      sleep 10
    fi
  done
}

# Rendered canvas layer count
layers() {
  timeout 25 agent-browser eval "document.querySelectorAll('[data-node-id]').length" 2>/dev/null | tail -1
}

# Type a prompt into the agent textarea and send (Enter).
send_prompt() {
  agent-browser find first "textarea" fill "$1" >/dev/null 2>&1
  sleep 1
  agent-browser press Enter >/dev/null 2>&1
  sleep 2
}

# Clear the canvas via /clear chat command, then wait for idle + empty canvas.
clear_canvas() {
  send_prompt "/clear"
  wait_idle 120 10
}

# Screenshot the workspace.
shot() {
  agent-browser screenshot "$SHOTS/$1.png" >/dev/null 2>&1
  echo "shot: $1.png"
}

# Console errors since last check.
console_errors() {
  agent-browser errors 2>/dev/null | tail -5
}

# Extract last agent message text (best effort: last non-user message block).
last_agent_text() {
  agent-browser eval "(() => { const el = document.querySelector('[data-agent-final], .ac-agent-final'); return el ? el.innerText.slice(0,400) : 'n/a'; })()" 2>/dev/null | tail -1
}

# Timestamped log line
log() { echo "[$(date +%H:%M:%S)] $*"; }
