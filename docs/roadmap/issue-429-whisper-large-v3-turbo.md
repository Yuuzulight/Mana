# Issue 429: Add Whisper large-v3-turbo Model Profile

## Goal

Add a faster Whisper option to the existing model-profile list.

## Why

Pruned-decoder Whisper variant (32->4 decoder layers), ~7x faster than
large-v3 with a modest accuracy tradeoff, GGML weights already exist for
whisper.cpp -- same runtime Mana already uses. See
`docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Proposed Scope

- Add `large-v3-turbo` to `WHISPER_MODEL_PROFILES` in
  `node-bot/whisper-discovery.js`.
- Same auto-detection/fallback pattern as the existing tiny/base/small/
  medium profiles.

## Acceptance Criteria

- `WHISPER_MODEL_PROFILE=large-v3-turbo` selects the new profile when the
  model file is present.
- Falls back to existing auto-detection when the file isn't present, same
  as other profiles.
- No change to existing profile behavior.

## Related

#4
