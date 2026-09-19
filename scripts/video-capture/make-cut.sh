#!/usr/bin/env bash
# make-cut.sh — landing cut from a captured take.
#
# Usage: bash scripts/video-capture/make-cut.sh <take.mp4> <out.mp4> <startS> <durationS> [crf]
#
# Re-encodes (never stream-copies: the cut must start on a keyframe and stay
# clean), web-grade H.264 yuv420p / 30fps / +faststart / no audio, keeps the
# source resolution, and writes:
#   <out.mp4>                    the cut
#   <out-basename>-poster.png    frame at 10% in (poster / LCP image)
#   <out-dir>/qa-check/*.png     4 verification frames (first, 33%, 66%, last)
# The take itself carries 0.4s fades; pick start/end OUTSIDE them.

set -euo pipefail

src="${1:?usage: make-cut.sh <take.mp4> <out.mp4> <startS> <durationS> [crf]}"
out="${2:?usage}"
ss="${3:?usage}"
dur="${4:?usage}"
crf="${5:-20}"

mkdir -p "$(dirname "$out")"
# Per-cut QA dir — several cuts share one output folder, and a shared dir
# silently overwrites the frames you are about to judge.
qaDir="$(dirname "$out")/qa-check-$(basename "${out%.mp4}")"
mkdir -p "$qaDir"

# -ss/-t BEFORE -i = fast input seek; the re-encode still starts on a keyframe.
ffmpeg -y -v error -ss "$ss" -t "$dur" -i "$src" \
  -c:v libx264 -pix_fmt yuv420p -crf "$crf" -preset slow \
  -r 30 -movflags +faststart -an \
  "$out"

# Poster at 10% in (past the first beat, still representative).
poster="${out%.mp4}-poster.png"
ffmpeg -y -v error -ss "$(awk -v d="$dur" 'BEGIN{printf "%.2f", d*0.10}')" -i "$out" -frames:v 1 "$poster"

# Verification frames: first / 33% / 66% / last.
i=0
for frac in 0 0.33 0.66 1; do
  i=$((i + 1))
  t=$(awk -v d="$dur" -v f="$frac" 'BEGIN{printf "%.2f", d*f - (f==1 ? 0.05 : 0)}')
  ffmpeg -y -v error -ss "$t" -i "$out" -frames:v 1 "$(printf '%s/check-%d.png' "$qaDir" "$i")"
done

bytes=$(stat -c%s "$out")
dur_out=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$out")
dims=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$out")
echo "cut: $out | ${dur_out}s ${dims} $((bytes / 1024))KB crf=$crf | poster=$poster"
