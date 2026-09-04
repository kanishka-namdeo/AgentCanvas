#!/bin/bash
# make-trust-slideshow.sh — build the trust-loop demo video as a slideshow of
# existing screenshots from download/agent-chat-trust/.
#
# Why a slideshow instead of a live recording? The approval gate only fires
# when the agent calls a destructive tool (pen_clear / pen_delete_shape /
# figma_delete_page / pen_clear_pattern_memory). In a live recording the LLM
# is non-deterministic — sometimes it asks for clarification, sometimes it
# takes >25s to reach the destructive call, and the resulting video is
# unreliable. The agent-chat-trust/ folder already documents the FULL trust
# arc in 10 high-quality screenshots; stitching them into a slideshow with
# crossfade transitions produces a clean, deterministic, reproducible demo
# that shows every step of the trust loop:
#
#   1. Agent running (tool-call cards streaming)
#   2. Turn-diff chip ("Created N · Updated M · Deleted K")
#   3. Diff card expanded (per-op detail)
#   4. Approval dialog (Allow / Deny buttons)
#   5. After Deny — canvas preserved (the trust payoff)
#
# Each frame is held ~2.5s with a 0.5s crossfade. Output: 1280-wide MP4 +
# 900-wide palette-optimized GIF.
set -euo pipefail

SRC_DIR="/home/z/my-project/download/agent-chat-trust"
OUT_DIR="/home/z/my-project/download/video-demos"
WORK="$(mktemp -d /tmp/trust-slideshow.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Frame sequence — the trust arc in 5 beats.
# Each entry is: <source-file>:<hold-seconds>
FRAMES=(
  "01-agent-running.png:2.5"
  "02-diff-card.png:2.5"
  "04-diff-card-expanded.png:3.0"
  "05-approval-dialog.png:3.5"
  "08-after-deny.png:3.0"
)

FPS=20
CROSSFADE=0.5

# 1) Normalize all source images to a fixed size (1600x1000, the native
#    screenshot size) and re-encode as JPEG for ffmpeg's concat filter.
i=0
inputs=()
for entry in "${FRAMES[@]}"; do
  src="${entry%%:*}"
  hold="${entry##*:}"
  src_path="${SRC_DIR}/${src}"
  [ -f "$src_path" ] || { echo "✗ missing $src_path"; exit 1; }

  # Compute the number of frames for this image's hold duration.
  nframes=$(python3 -c "import math; print(int(round(${hold} * ${FPS})))")
  norm="${WORK}/f${i}.jpg"
  ffmpeg -y -i "$src_path" -vf "scale=1600:1000:force_original_aspect_ratio=decrease,pad=1600:1000:(ow-iw)/2:(oh-ih)/2:color=white" -q:v 2 -update 1 "$norm" 2>/dev/null
  inputs+=("-loop" "1" "-t" "$hold" "-i" "$norm")
  i=$((i+1))
done

# 2) Concat with crossfade transitions. ffmpeg's xfade filter takes two
#    inputs at a time; for N inputs we chain N-1 xfades. Duration of each
#    xfade is $CROSSFADE seconds.
filter=""
prev="[0:v]"
n=${#FRAMES[@]}

# Compute cumulative hold durations so we can place each xfade offset.
# offset_j = (sum of holds[0..j-1]) - j*crossfade
cumulative=(0)
for entry in "${FRAMES[@]}"; do
  hold="${entry##*:}"
  cumulative+=("$(python3 -c "print(${cumulative[-1]:-0} + ${hold})")")
done

for j in $(seq 1 $((n-1))); do
  offset=$(python3 -c "print(round(${cumulative[$j]} - ${CROSSFADE} * ($j + 1), 3))")
  label="[xf${j}]"
  filter="${filter}${prev}[${j}:v]xfade=transition=fade:duration=${CROSSFADE}:offset=${offset}${label};"
  prev="${label}"
done
filter="${filter%;}"
filter="${filter};${prev}format=yuv420p[v]"

# 3) Encode the slideshow to a raw MP4 capture (H.264 lossless-ish).
cap="${OUT_DIR}/core-trust-loop.mp4"
ffmpeg -y "${inputs[@]}" -filter_complex "$filter" -map "[v]" \
  -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart \
  -r "$FPS" "$cap"
echo "✓ capture: $cap ($(du -h "$cap" | cut -f1))"

# 4) Distribution MP4 — smaller, CRF 20.
dist="${OUT_DIR}/core-trust-loop_dist.mp4"
ffmpeg -y -i "$cap" -an -vf "scale=1280:-2" \
  -c:v libx264 -preset medium -crf 20 -profile:v high -pix_fmt yuv420p \
  -movflags +faststart "$dist"
echo "✓ dist mp4: $dist ($(du -h "$dist" | cut -f1))"

# 5) GIF — palettegen stats_mode=full + paletteuse sierra2_4a dither + lanczos.
PALETTE="${WORK}/palette.png"
gif="${OUT_DIR}/core-trust-loop.gif"
ffmpeg -y -i "$cap" -vf "fps=15,scale=900:-1:flags=lanczos,palettegen=stats_mode=full" "$PALETTE"
ffmpeg -y -i "$cap" -i "$PALETTE" \
  -filter_complex "fps=15,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle" \
  "$gif"
echo "✓ gif: $gif ($(du -h "$gif" | cut -f1))"

echo ""
echo "=== done ==="
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,nb_frames,duration -of default=noprint_wrappers=1 "$gif"
