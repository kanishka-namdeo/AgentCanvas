#!/bin/bash
# convert-core-videos.sh — transcode the 2 core workflow capture MP4s into
# distribution MP4 + GIF. Same high-quality pipeline as convert-demos.sh
# (palettegen stats_mode=full + paletteuse sierra2_4a + lanczos).
#
# Run: bash scripts/video-demos/convert-core-videos.sh
set -euo pipefail

OUT_DIR="/home/z/my-project/download/video-demos"
cd "$OUT_DIR"

GIF_WIDTH=900
MP4_WIDTH=1280
FPS=18   # slightly lower for these longer clips to keep GIF size sane

PALETTE="$(mktemp /tmp/_palette.XXXXXX.png)"

for name in core-agent-chat core-trust-loop; do
  cap="${name}.mp4"
  [ -f "$cap" ] || { echo "✗ $cap missing, skipping"; continue; }

  mp4_dist="${name}_dist.mp4"
  gif="${name}.gif"

  echo "→ $cap"

  # Distribution MP4 — H.264 medium CRF 20
  ffmpeg -y -i "$cap" \
    -an \
    -vf "scale=${MP4_WIDTH}:-2" \
    -c:v libx264 -preset medium -crf 20 \
    -profile:v high -pix_fmt yuv420p \
    -movflags +faststart \
    "$mp4_dist" 2>/dev/null
  echo "    ✓ $mp4_dist ($(du -h "$mp4_dist" | cut -f1))"

  # GIF — palettegen (stats_mode=full) + paletteuse (sierra2_4a dither)
  ffmpeg -y -i "$cap" \
    -vf "fps=${FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,palettegen=stats_mode=full" \
    "$PALETTE" 2>/dev/null
  ffmpeg -y -i "$cap" -i "$PALETTE" \
    -filter_complex "fps=${FPS},scale=${GIF_WIDTH}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle" \
    "$gif" 2>/dev/null
  echo "    ✓ $gif ($(du -h "$gif" | cut -f1))"
done

rm -f "$PALETTE"
echo ""
echo "=== done ==="
ls -lh core-*_dist.mp4 core-*.gif 2>/dev/null | awk '{print $5, $9}'
