# Issue 619: Port Echo Suppression And Turn-Detection From Electron's Voice Pipeline To The Native Launcher

## Correction notice

A follow-up codebase audit (2026-09-12) found this issue's original
premise was wrong: Electron's `windows-launcher` already ships real echo
cancellation, barge-in, and turn-detection. Only `windows-native-launcher`
is missing them. Scope narrowed accordingly -- see below.

## Goal

Bring `windows-native-launcher`'s voice pipeline up to parity with
`windows-launcher`'s existing echo suppression, barge-in, and
turn-detection, instead of building these from scratch.

## Why

Original research (`docs/roadmap/oss-inspiration-survey-2026-09.md`)
assumed Mana had no echo suppression or turn-detection anywhere. That's
false for Electron:

- **AEC already exists**: `windows-launcher`/`desktop-client` get real
  WebRTC acoustic echo cancellation for free via
  `getUserMedia({audio: true})`'s default `echoCancellation: true`.
- **Barge-in already shipped** (issue #219): `BargeInGate.cs` (native
  side, used elsewhere) and `voice-endpointing.js`'s
  `nextBargeInState()`/`dbfsFromSamples()` implement a
  350ms-hold-above--45dBFS barge-in gate, unit-tested in both C# and JS.
- **Turn-detection heuristic already exists**: `voice-endpointing.js`'s
  `silenceBufferMsForTranscript()`.

The real, narrower gap: `windows-native-launcher`'s `RecordingSegmenter.cs`
captures audio via raw `WasapiCapture()` with **no AEC at all**, and never
calls/ports `silenceBufferMsForTranscript()` -- so the native launcher is
exposed to exactly the self-triggering and abrupt-cutoff problems the
original research described, while Electron already isn't.

Note: issue #219's own doc admits Chromium's built-in AEC was never
verified against real speaker/mic hardware -- worth a real-hardware check
regardless of this issue's native-specific scope.

## Proposed Scope

- Add an AEC-equivalent to `windows-native-launcher`'s `WasapiCapture()`
  capture path (e.g. via `WasapiLoopbackCapture` mixed against the mic
  stream, or a lightweight library equivalent to WebRTC's AEC3) so native
  doesn't hear its own TTS output.
- Port `silenceBufferMsForTranscript()`'s turn-detection logic (or an
  equivalent) into `RecordingSegmenter.cs`.
- Port or reimplement the barge-in gate (`nextBargeInState()`/
  `dbfsFromSamples()`) for native's voice loop if it isn't already wired
  in there.
- Real-hardware verification pass on both Electron's existing AEC and
  native's new AEC -- confirm neither self-triggers with real speakers
  (not headset) in practice, since this was never verified per #219's own
  notes.

## Acceptance Criteria

- `windows-native-launcher` no longer produces false wake-word triggers
  or self-transcription from its own TTS output in a real speaker
  (non-headset) setup, matching Electron's existing behavior.
- `RecordingSegmenter.cs` uses the same (or equivalent) turn-detection
  heuristic as `voice-endpointing.js`.
- A documented before/after false-trigger-rate comparison on native,
  using a simple manual test (play known TTS lines, check whether they
  appear in the wake-word-facing transcript).
- Confirmation (or a documented gap) that Electron's existing AEC has
  been verified against real speaker hardware, not just assumed from
  `getUserMedia`'s default.

## Related

`docs/roadmap/oss-inspiration-survey-2026-09.md`. Complements #618
(dedicated wake-word classifier). Issue #219 (barge-in, Electron-side
prior art).
