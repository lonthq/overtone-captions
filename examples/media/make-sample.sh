#!/usr/bin/env bash
# Generates the two-speaker sample clip used by the demo and examples/fixtures/sample.overtone.json.
#   examples/media/sample-16x9.mp4  (1280x720)
#   examples/media/sample-9x16.mp4  (720x1280)
# Needs macOS `say` and ffmpeg/ffprobe on PATH. Output is git-ignored (*.mp4).
#
# Every sentence starts at a fixed time (SLOT_STARTS), so the fixture's cue times stay valid even if a
# voice speaks slightly faster or slower on another macOS version.
set -euo pipefail

cd "$(dirname "$0")"

for tool in say ffmpeg ffprobe bc; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: '$tool' not found. This script needs macOS 'say', ffmpeg/ffprobe and bc (brew install ffmpeg)." >&2
    exit 1
  fi
done

RATE=180              # words per minute, fixed so the result does not depend on system settings
DURATION=18           # total length in seconds (matches "duration" in the fixture)
VOICES=("Samantha" "Samantha" "Daniel" "Samantha")
SPEAKERS=("S1" "S1" "S2" "S1")
SLOT_STARTS=("0.5" "4.7" "10.4" "14.1")
SLOT_ENDS=("4.7" "10.4" "14.1" "18")
SENTENCES=(
  "Every year, one in five drivers has some kind of car damage."
  "With DriveCover from Lumora, you're insured from day one, for just \$12 a month."
  "And the best part? You can claim directly in the app."
  "So remember: DriveCover. Drive worry-free."
)

# `say -v Nonexistent` silently falls back to the default voice, so check the voices first.
installed_voices="$(say -v '?')"
for voice in "${VOICES[@]}"; do
  if ! grep -q "^$voice " <<<"$installed_voices"; then
    echo "error: voice '$voice' is not installed (System Settings → Accessibility → Spoken Content → System voice → Manage Voices)." >&2
    exit 1
  fi
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 0.5 s of leading silence, then one padded clip per sentence.
ffmpeg -v error -f lavfi -i anullsrc=r=48000:cl=mono -t "${SLOT_STARTS[0]}" -c:a pcm_s16le "$work/lead.wav"
echo "file '$work/lead.wav'" > "$work/list.txt"

echo "Sentence timings (seconds):"
for i in "${!SENTENCES[@]}"; do
  say -v "${VOICES[$i]}" -r "$RATE" -o "$work/s$i.aiff" "${SENTENCES[$i]}"
  spoken="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$work/s$i.aiff")"
  # LC_ALL=C: keep the decimal point a dot, also under comma-decimal locales (e.g. nl_NL).
  slot="$(echo "${SLOT_ENDS[$i]} - ${SLOT_STARTS[$i]}" | LC_ALL=C bc -l)"
  end="$(echo "${SLOT_STARTS[$i]} + $spoken" | LC_ALL=C bc -l)"
  env LC_ALL=C printf '  %d  %s  %6.3f -> %6.3f  (%s) %s\n' "$((i + 1))" "${SPEAKERS[$i]}" "${SLOT_STARTS[$i]}" "$end" "${VOICES[$i]}" "${SENTENCES[$i]}"
  if (( $(echo "$spoken > $slot" | LC_ALL=C bc -l) )); then
    overrun="$(echo "$spoken - $slot" | LC_ALL=C bc -l)"
    env LC_ALL=C printf "error: sentence %d is %.3fs longer than its %ss slot (spoken %.3fs); the fixture timings would drift. Shorten the sentence or widen the slot.\n" "$((i + 1))" "$overrun" "$slot" "$spoken" >&2
    exit 1
  fi
  ffmpeg -v error -i "$work/s$i.aiff" -af "aresample=48000,atrim=end=$slot,apad=whole_dur=$slot" -ac 1 -c:a pcm_s16le "$work/s$i.wav"
  echo "file '$work/s$i.wav'" >> "$work/list.txt"
done

ffmpeg -v error -f concat -safe 0 -i "$work/list.txt" -c:a pcm_s16le "$work/audio.wav"

render() { # $1 = WxH, $2 = output file
  local width="${1%x*}" height="${1#*x}"
  ffmpeg -v error -y \
    -f lavfi -i "color=c=0x1d2b3a:s=$1:r=30:d=$DURATION" \
    -i "$work/audio.wav" \
    -filter_complex "[1:a]showwaves=s=${width}x$((height / 4)):mode=cline:scale=sqrt:colors=white:r=30,format=rgba,colorchannelmixer=rr=0.37:gg=0.72:bb=0.91[w];[0:v][w]overlay=0:(H-h)/3:format=auto[v]" \
    -map "[v]" -map 1:a -t "$DURATION" \
    -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "$work/$2"
  mv "$work/$2" "$2" # only a finished file ever appears next to the script
  echo "wrote examples/media/$2"
}

render 1280x720 sample-16x9.mp4
render 720x1280 sample-9x16.mp4
