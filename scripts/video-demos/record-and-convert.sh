#!/bin/bash
# record-and-convert.sh — one-shot: record every AgentCanvas feature demo,
# then convert each WebM into MP4 + palette-optimized GIF.
#
# Prereqs:
#   - dev server alive on http://127.0.0.1:3000 (run `bash scripts/start-dev.sh` if not)
#   - chromium at /home/z/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome
#   - ffmpeg on PATH
#   - bun (project uses bun run for tsx)
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== 1/3 sanity ==="
if ! curl -sf --max-time 5 http://127.0.0.1:3000/ > /dev/null; then
  echo "✗ dev server not responding on :3000 — starting it..."
  bash scripts/start-dev.sh
fi

echo ""
echo "=== 2/3 record (Playwright → WebM) ==="
bun run scripts/video-demos/record-demos.ts

echo ""
echo "=== 3/3 convert (ffmpeg → MP4 + GIF) ==="
bash scripts/video-demos/convert-demos.sh

echo ""
echo "✓ done. GIFs + MP4s are in download/video-demos/"
