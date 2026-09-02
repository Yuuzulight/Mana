# Issue 493: Audio Podcast Digest Of Deep Research Reports

## Goal

Let a completed Deep Research report be narrated as an audio briefing,
not just read as text.

## Why

Inspired by SurfSense's AI-generated podcasts from research output. Mana
already has local TTS (Fish Speech default, Kokoro/GPT-SoVITS alternates)
wired in for conversational replies -- this is mostly wiring an existing
report into an existing TTS path.

## Proposed Scope

- Add an option to narrate a completed Deep Research report (#47) as
  audio.
- Restructure/summarize the written report into a spoken-friendly script
  before synthesis (a written citation list doesn't read well aloud).
- Save the audio file alongside the written report, don't replace it.

## Acceptance Criteria

- A completed Deep Research report can be converted to an audio file
  using Mana's existing TTS providers.
- The written report is unaffected -- audio is additive.
- No change to Deep Research behavior for users who don't request audio.

## Related

#47
