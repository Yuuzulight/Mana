#!/usr/bin/env bash
# Composites the 240fps (4 subframes x 60fps) raw render into the final
# looping 60fps video: tmix averages each disjoint group of 4 subframes for
# motion blur, select keeps one of every 4 (drops the tmix filter's
# overlapping intermediate frames), muxed against the trimmed real-beat-grid
# audio and cut to exactly one loop (LOOP_T seconds).
set -euo pipefail
cd "$(dirname "$0")"

LOOP_T=45.9287   # BAR_DUR(1.9969) * 23 bars, must match showreel.html

ffmpeg -y -framerate 240 -i "raw/sub_%06d.png" \
  -vf "tmix=frames=4,select='not(mod(n\,4))',setpts=N/60/TB" \
  -fps_mode cfr -r 60 \
  -pix_fmt yuv420p -c:v libx264 -crf 16 -preset slow \
  video_noaudio.mp4

ffmpeg -y -i video_noaudio.mp4 -i audio/im-fine-trimmed.wav \
  -c:v copy -c:a aac -b:a 192k -t "$LOOP_T" -shortest \
  showreel_final.mp4

echo "done -> showreel_final.mp4"
