#!/usr/bin/env bash
# qa-frames.sh — QA corpus + objective timeline evidence for one captured take.
#
# Usage: bash scripts/video-capture/qa-frames.sh <mp4> <outDir> [frameCount] [cols]
#
# Produces, in <outDir>:
#   fNN.png            evenly spaced frames over the FULL duration (default 12)
#   montage.png        the same frames tiled (cols x rows, 960px-wide tiles)
#   scenes.txt         scene-change timestamps (activity markers)
#   freezes.txt        freezedetect intervals (dead zones, >=0.6s near-static)
#
# Why: a harness PASS says the actions ran, not that the footage is watchable.
# Scene changes + freezes give frame-accurate dead-time evidence before the
# eyes-on pass, and the frame corpus is the eyes-on pass.

set -euo pipefail

mp4="${1:?usage: qa-frames.sh <mp4> <outDir> [frameCount] [cols]}"
out="${2:?usage: qa-frames.sh <mp4> <outDir> [frameCount] [cols]}"
count="${3:-12}"
cols="${4:-4}"

mkdir -p "$out"

dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$mp4")
fps=$(awk -v n="$count" -v d="$dur" 'BEGIN{printf "%.6f", n/d}')

# 1. Evenly spaced frames across the whole take. showinfo records each frame's
#    exact presentation time — the frames corpus is only usable as evidence
#    if you know WHICH second each PNG is (the fps filter's first output is
#    not at t=0 and the offset is easy to get wrong).
ffmpeg -y -v info -i "$mp4" -vf "fps=$fps,showinfo" -frames:v "$count" "$out/f%02d.png" 2>&1 \
  | grep -oE "pts_time:[0-9.]+" | sed 's/pts_time://' | awk '{printf "f%02d  %6.2fs\n", NR, $1}' > "$out/frames-timeline.txt" || true

# 2. Tile them for a single cheap triage image.
rows=$(( (count + cols - 1) / cols ))
ffmpeg -y -v error -i "$out/f%02d.png" -vf "scale=960:-2,tile=${cols}x${rows}" -frames:v 1 "$out/montage.png"

# 3. Scene changes = real visual activity markers (pts_time of each cut/beat).
ffmpeg -v info -i "$mp4" -vf "select='gt(scene,0.02)',metadata=print" -an -f null - 2>&1 \
  | grep -E "pts_time" | sed 's/.*pts_time:\([0-9.]*\).*/\1/' > "$out/scenes.txt" || true

# 4. Near-static stretches = dead time (cursor wobble barely counts as motion).
ffmpeg -v info -i "$mp4" -vf "freezedetect=n=-60dB:d=0.6" -an -f null - 2>&1 \
  | grep -iE "freeze_(start|end)" > "$out/freezes.txt" || true

# 5. Motion-energy curve: mean luma of the frame-to-frame difference at 5Hz.
#    This is the trim-decision instrument — it shows exactly where the
#    footage is alive vs. dead, independent of what the harness claims.
ffmpeg -v info -i "$mp4" \
  -vf "fps=5,scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print:file=${out}/motion_raw.txt" \
  -an -f null - >/dev/null 2>&1 || true

awk '
  /pts_time:/ { split($0, a, "pts_time:"); t = a[2] + 0 }
  /YAVG=/ { split($0, b, "YAVG="); v = b[2] + 0;
            if (t == "") next;
            bars = int(v * 2); if (bars > 40) bars = 40;
            line = sprintf("%6.1f %7.3f |", t, v);
            for (i = 0; i < bars; i++) line = line "#";
            print line }
' "${out}/motion_raw.txt" > "$out/motion.txt" 2>/dev/null || true
rm -f "${out}/motion_raw.txt"

echo "duration=${dur}s frames=${count} -> $out"
