# Issue 430: Evaluate Local Speaker Diarization

## Goal

Figure out who's speaking in a single shared audio stream, for cases
Discord's per-user channels don't cover (video-watch plugin, in-room
multi-person audio on one mic).

## Why

Inspired by pyannote.audio's `speaker-diarization-community-1` pipeline,
local and offline-loadable. See
`docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Costs to weigh

CPU-only diarization is slow (~2.2s compute per 1s audio per published
benchmarks) -- real-time use likely needs GPU. Most plausible use cases
(video-watch) aren't latency-sensitive, so this may be acceptable without
GPU.

## Proposed Scope

- Evaluate pyannote (or an equivalent local model) against the video-watch
  plugin first, where near-real-time isn't required.
- Don't commit to anything latency-sensitive (e.g. live in-room
  conversation) until the CPU-cost question is actually measured on
  target hardware.

## Acceptance Criteria

- A documented evaluation result: viable for video-watch or not, with
  measured latency/accuracy on representative hardware.
- No behavior change to existing Discord per-speaker transcription, which
  doesn't need this.
