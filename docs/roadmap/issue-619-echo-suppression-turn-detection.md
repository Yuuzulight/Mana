# Issue 619: Add Echo Suppression And Semantic Turn-Detection For TTS Playback And Barge-In

## Goal

Prevent Mana's own TTS output from re-triggering its wake-word/STT
pipeline, and add a real mechanism for detecting when the user has
actually finished speaking (or wants to interrupt Mana mid-sentence).

## Why

Mana plays local Fish Speech TTS out of the same machine that
continuously listens via whisper.cpp for the wake word. If that audio is
audible to the same mic loop (speakers rather than a headset), Mana risks
hearing and mis-transcribing its own voice, causing false wake-word
triggers or the assistant "hearing itself talk." This exact failure mode
-- and its fixes -- recur across nearly every architecturally-similar
open project surveyed: `wyoming-satellite` mutes the mic for a
configurable window around playback; Open-LLM-VTuber and Vocalis run real
acoustic echo cancellation (WebRTC's AEC3, extracted as a standalone
library, is the standard building block) so the mic can stay open;
porokka's JARVIS-OS devlog does a cheap string-match against the
just-spoken TTS text to discard self-heard transcript segments as a
stopgap.

Separately, Mana's fuzzy-transcript wake-word approach has no described
mechanism for distinguishing "user paused to think" from "user is done
talking," which is exactly the problem semantic turn-detection models
solve. Pipecat's Smart Turn v3 (BSD-2, public weights) is a small model
that takes raw waveform and predicts turn-completion from prosody in
~12ms on CPU, decoupled from any specific STT engine -- it drops in
without replacing whisper.cpp.

## Proposed Scope

- Add a cheap first pass: mute/suppress the STT input stream for a short
  configurable window around known TTS playback (the `wyoming-satellite`
  approach), or string-match incoming transcript segments against the
  text just sent to TTS and discard matches (the porokka approach).
  Either is small and should ship first regardless of the AEC work below.
- Evaluate WebRTC AEC3 (standalone extraction) or a lighter alternative
  (e.g. SpeexDSP's echo canceller) feeding the outgoing TTS waveform as
  the far-end reference signal, to allow real open-mic barge-in without a
  hard mute window.
- Evaluate Pipecat's Smart Turn v3 as a drop-in turn-completion classifier
  layered on top of the existing whisper.cpp stream, to reduce false
  "user is done" / false "user is still talking" calls.
- Measure CPU cost of both additions under gaming-mode backoff (Smart
  Turn's ~12ms CPU inference should be cheap enough to keep even then).

## Acceptance Criteria

- Mana's own TTS output no longer produces false wake-word triggers or
  self-transcription in a real speaker (non-headset) setup.
- A documented before/after false-trigger-rate comparison using a simple
  manual test script (play known TTS lines, check whether they appear in
  the wake-word-facing transcript).
- A turn-detection signal is available to the wake-word/dialogue loop,
  with a recommendation on whether it's worth wiring in now or tracked as
  a follow-up.
- Resource cost of both additions measured and acceptable under
  gaming-mode backoff.

## Related

`docs/roadmap/oss-inspiration-survey-2026-09.md` (full research backing).
Complements #618 (dedicated wake-word classifier).
