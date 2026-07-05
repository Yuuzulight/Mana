#!/usr/bin/env bash
# Simple downloader for large assets. Provide ASSET_BASE_URL or pass first arg as base URL
BASE_URL=${1:-${ASSET_BASE_URL}}
OUT_DIR=${2:-.}
set -euo pipefail
if [ -z "$BASE_URL" ]; then
  echo "ERROR: No base URL provided. Set ASSET_BASE_URL or pass it as first arg."
  exit 1
fi
files=(
  "ggml-tiny.en.bin:tools/whisper/models/ggml-tiny.en.bin"
  "test.wav:tools/whisper/test.wav"
  "mana-younger-sister-voice-test.wav:mana-younger-sister-voice-test.wav"
  "tts-english.wav:tts-language-tests-single-voice/english.wav"
)
mkdir -p "$OUT_DIR"
for mapping in "${files[@]}"; do
  name=${mapping%%:*}
  path=${mapping#*:}
  target="$OUT_DIR/$path"
  mkdir -p "$(dirname "$target")"
  url="$BASE_URL/$name"
  echo "Downloading $url -> $target"
  if ! curl -L --fail --progress-bar -o "$target" "$url"; then
    echo "Failed to download $url" >&2
  fi
done
echo "Done"
