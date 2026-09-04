#!/bin/bash
# convert-demos.sh — transcode capture MP4s into distribution MP4 + GIF.
#
# Input:  capture MP4 at 3840x2400 (DPR 2 from a 1920x1200 viewport),
#         H.264 ultrafast CRF 18 from record-demos.ts.
# Output: small MP4 (~100-200 KB, CRF 20 medium preset, 1280-wide) plus
#         a high-quality palette-optimized GIF (900-wide).
#
# Quality choices (informed by https://blog.pkh.me/p/21-high-quality-gif-with-ffmpeg.html):
#   - palettegen with stats_mode=full — builds the palette from the histogram
#     of EVERY frame (not just diffs). For UI demos where most of the frame
#     stays the same color, this captures the full color range of the canvas
#     instead of just the changed pixels. Result: no banding on flat fills.
#   - paletteuse with dither=sierra2_4a — error-diffusion dither that
#     produces smoother gradients than bayer (no 8x8 crosshatch). The
#     "swarming" artifact the article warns about is acceptable here because
#     our content is mostly static UI chrome; bayer's pattern would be MORE
#     visible on text-heavy UI. diff_mode=rectangle keeps file size sane by
#     only redrawing the changed sub-rectangle per frame.
#   - scale with flags=lanczos — the article specifically recommends lanczos
#     or bicubic over the default bilinear; bilinear makes the input blurry
#     when downsampling, which destroys text crispness.
#   - For the MP4 distribution: libx264 medium crf 20 (visually lossless),
#     yuv420p for universal player support, +faststart for web streaming.
#
# Refs:
#   - https://blog.pkh.me/p/21-high-quality-gif-with-ffmpeg.html
#   - https://trac.ffmpeg.org/wiki/Encode/H.264
#   - https://ffmpeg.org/ffmpeg-filters.html#paletteuse-1
set -euo pipefail

OUT_DIR="${1:-/home/z/my-project/download/video-demos}"
cd "$OUT_DIR"

# Distribution dimensions
GIF_WIDTH=900       # GIF is rendered at README column width on GitHub
MP4_WIDTH=1280      # MP4 is the higher-quality link
FPS=20              # smooth enough for UI demos; keeps GIF frame count reasonable

PALETTE="$(mktemp /tmp/_palette.XXXXXX.png)"

shopt -s nullglob
for cap in *.mp4; do
  # Skip files we already converted (idempotency: skip "_dist.mp4" suffix).
  case "$cap" in *_dist.mp4) continue;; esac

  base="${cap%.mp4}"
  mp4_dist="${base}_dist.mp4"
  gif="${base}.gif"

  echo "→ $cap"

  # 1) Distribution MP4 — H.264 medium CRF 20 (visually lossless, small)
  ffmpeg -y -i "$cap" \
    -an \
    -vf "scale=${MP4_WIDTH}:-2" \
    -c:v libx264 -preset medium -crf 20 \
    -profile:v high -pix_fmt yuv420p \
    -movflags +faststart \
    "$mp4_dist" 2>/dev/null
  echo "    ✓ $mp4_dist ($(du -h "$mp4_dist" | cut -f1))"

  # 2) GIF — palettegen (stats_mode=full) + paletteuse (sierra2_4a dither)
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
echo "=== done. files in $OUT_DIR ==="
ls -lh *_dist.mp4 *.gif 2>/dev/null | awk '{print $5, $9}'
