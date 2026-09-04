#!/bin/bash
# convert-demos.sh — convert WebM recordings to small MP4 + optimized GIF.
#
# Why both:
#   - GitHub README renders animated GIFs via ![alt](path) — always works.
#   - MP4 (H.264) is ~10x smaller and sharper; some renderers support
#     <video> tags. We embed the GIF in the README for guaranteed rendering
#     and keep the MP4 alongside for users who want a higher-quality copy.
#
# Palette trick: ffmpeg's gif codec looks awful without a palette. The standard
# two-pass approach generates a stats file from the source, then uses it as a
# filter to produce a clean 256-color GIF.
#
# Refs:
#   - https://ffmpeg.org/ffmpeg-filters.html#palettegen-1
#   - https://trac.ffmpeg.org/wiki/Create%20animated%20GIF%20with%20FFmpeg
set -euo pipefail

OUT_DIR="${1:-/home/z/my-project/download/video-demos}"
cd "$OUT_DIR"

FPS=12          # smooth enough for UI demos, keeps GIF small
SCALE=900       # width in px — fits GitHub's README column
PALETTE="/tmp/_palette_$$ .png"

shopt -s nullglob
for webm in *.webm; do
  base="${webm%.webm}"
  mp4="${base}.mp4"
  gif="${base}.gif"

  echo "→ $webm"

  # 1) MP4 (H.264 + AAC, faststart for progressive web playback)
  ffmpeg -y -i "$webm" \
    -an \
    -vf "scale=${SCALE}:-2" \
    -c:v libx264 -profile:v high -preset veryfast -crf 26 \
    -movflags +faststart \
    -pix_fmt yuv420p \
    "$mp4" 2>/dev/null
  echo "    ✓ $mp4 ($(du -h "$mp4" | cut -f1))"

  # 2) GIF — palettegen + paletteuse two-pass
  ffmpeg -y -i "$webm" \
    -vf "fps=${FPS},scale=${SCALE}:-1:flags=lanczos,palettegen=stats_mode=diff" \
    "$PALETTE" 2>/dev/null
  ffmpeg -y -i "$webm" -i "$PALETTE" \
    -filter_complex "fps=${FPS},scale=${SCALE}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    "$gif" 2>/dev/null
  rm -f "$PALETTE"
  echo "    ✓ $gif ($(du -h "$gif" | cut -f1))"
done

echo ""
echo "=== done. files in $OUT_DIR ==="
ls -lh *.mp4 *.gif 2>/dev/null | awk '{print $5, $9}'
