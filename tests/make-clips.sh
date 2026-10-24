#!/usr/bin/env bash
# Build the test clips used by tests/e2e.mjs and tests/pipeline/*.mjs.
# Needs ffmpeg with libx264/libx265 and one still photo (any JPEG).
#   tests/make-clips.sh photo.jpg web/_clips
set -euo pipefail
src=${1:?photo.jpg}; out=${2:-web/_clips}
mkdir -p "$out"
# 1080p H.264 + AAC, x264 default GOP (250): the slow case for seeking
ffmpeg -v error -y -loop 1 -i "$src" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -filter_complex "[0:v]scale=3840:-2,zoompan=z='1+0.002*on':x='iw/2-(iw/zoom/2)+on*2':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,format=yuv420p[v]" \
  -map "[v]" -map 1:a -t 6 -c:v libx264 -profile:v high -preset fast -crf 20 -c:a aac -b:a 128k -ac 2 -movflags +faststart "$out/dive1080.mp4"
# 4K H.264 in a QuickTime .mov, no sound
ffmpeg -v error -y -loop 1 -i "$src" \
  -filter_complex "[0:v]scale=5400:-2,zoompan=z='1+0.003*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=3840x2160:fps=30,format=yuv420p[v]" \
  -map "[v]" -t 3 -c:v libx264 -preset veryfast -crf 22 "$out/dive4k_noaudio.mov"
# HEVC: decodable only where the browser has HEVC support
ffmpeg -v error -y -i "$out/dive1080.mp4" -t 3 -c:v libx265 -preset fast -tag:v hvc1 -c:a copy "$out/dive1080_hevc.mp4"
cp "$src" "$out/tpr_Ocean_Lights_a.jpg"
ls -l "$out"
