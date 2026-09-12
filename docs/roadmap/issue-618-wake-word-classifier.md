# Issue 618: Add A Dedicated Wake-Word Classifier Ahead Of Continuous Whisper

## Goal

Stop running full whisper.cpp transcription continuously just to catch
the wake phrase. Gate it behind a small, always-on wake-word classifier
that only triggers real STT on a positive hit.

## Why

Mana's wake-word detection currently works by fuzzy-matching continuous
whisper.cpp transcripts -- meaning full ASR inference runs at all times,
not just when someone is talking to Mana. A deep research sweep across
the open-source voice-assistant ecosystem (Home Assistant/Rhasspy's
`openWakeWord`, ESPHome's `micro_wake_word`, `livekit-wakeword`,
Kyutai/Pipecat's semantic turn-detection work) converges on the same
architecture: a tiny (hundreds of KB to a few MB) always-on classifier
running on raw audio features at near-zero CPU, gating a much heavier STT
engine that only wakes up after a hit. This is architecturally distinct
from -- and much cheaper than -- transcribing everything and
pattern-matching the output.

This is the single highest-leverage finding from the research given
Mana's existing first-class constraint of backing off resource usage
during gaming mode: continuous Whisper inference is exactly the kind of
idle draw that constraint is supposed to prevent, and it's currently
happening at all times regardless of whether anyone is talking to Mana.

## Proposed Scope

- Evaluate `openWakeWord` (Apache-2.0, ONNX models a few hundred KB each)
  as the classifier: it ships a one-command training pipeline that
  synthesizes thousands of positive wake-phrase samples from many
  synthetic TTS voices (speed-varied for prosody) mixed with a handful of
  real recordings, and trains a small model in a few hours on a consumer
  GPU.
- Mana already runs local TTS with reference-audio voice cloning (Fish
  Speech) -- investigate reusing that instead of openWakeWord's default
  Kokoro-based synthetic-voice generator to produce wake-phrase training
  data in the user's own cloned voice/accent space.
- Wire the classifier as a cheap always-on gate: whisper.cpp only starts
  real transcription after a positive detection, rather than running
  continuously.
- Keep the existing fuzzy-transcript matcher as a second-pass
  confirmation once full audio does reach whisper.cpp, to avoid
  regressing on false-positive wake triggers during the swap.
- Measure idle CPU/GPU draw before and after on Mana's own hardware,
  including under gaming-mode backoff.

## Acceptance Criteria

- A trained wake-word ONNX model runs as a background classifier with
  measured near-zero idle CPU/GPU cost.
- whisper.cpp is no longer invoked continuously; it starts only after a
  positive wake-word detection.
- Measured idle resource comparison (before/after) on real hardware,
  including under gaming-mode backoff.
- No regression in wake-word reliability versus the current
  fuzzy-transcript-matching approach, checked against a small set of real
  test utterances (true positives, near-miss phrases, silence/ambient
  noise).

## Related

`docs/roadmap/oss-inspiration-survey-2026-09.md` (full research backing).
Complements #619 (echo suppression and turn-detection).
