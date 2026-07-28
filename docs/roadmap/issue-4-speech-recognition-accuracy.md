# Issue 4: Speech Recognition Accuracy

## Goal

Improve Mana's speech recognition accuracy and reliability during normal use
and while games are running, without abandoning the local/offline
`whisper.cpp` design.

## Status: Implemented (scoped subset -- see below)

Covers the concretely implementable, testable subset of the issue's 9
"areas to investigate":

1. **Fuzzy wake-word matching.** `windows-launcher/renderer/speech-filters.js`
   gained `fuzzyMatchesWakeWord` (edit-distance-1 against the existing
   `WAKE_WORDS` list), used as a fallback in `extractWakeCommand` when the
   exact regex match fails. Catches single-letter Whisper mis-transcriptions
   ("Manaa", "Mona") the static list can't enumerate by hand, without
   growing that list indefinitely.
2. **Configurable Whisper model profiles.** `node-bot/whisper-discovery.js`
   gained `WHISPER_MODEL_PROFILES` (`tiny`/`base`/`small`/`medium`) and a
   `WHISPER_MODEL_PROFILE` env var -- a friendlier knob than hunting down a
   raw `ggml-*.bin` path, matching the existing `LLAMA_MODEL_PROFILES`
   pattern in `ai/local-ai.js`. Falls back to the existing
   `PREFERRED_NAME_ORDER`/first-found auto-detection for any tier whose
   files aren't present, so requesting an unmet profile never means "no
   model" when one exists.
3. **Quiet speech / noise-rejection tuning made configurable.**
   `MIN_SPEECH_RMS`, `MIN_SPEECH_PEAK`, and `MAX_CLICKY_ZERO_CROSSING_RATE`
   in `renderer.js` are now overridable via `MANA_MIN_SPEECH_RMS`,
   `MANA_MIN_SPEECH_PEAK`, `MANA_MAX_CLICKY_ZCR` -- same override pattern
   already established for `MANA_SILENCE_BUFFER_MS`.
4. **Microphone gain normalization.** A new `applySpeechGain` step in
   `prepareSpeechWavBlob` boosts a quiet clip's peak amplitude (clamped to
   avoid clipping) toward `MANA_SPEECH_GAIN_TARGET_PEAK` (capped at
   `MANA_SPEECH_GAIN_MAX_BOOST`) before stats/reject-checks run and before
   Whisper ever sees the audio -- rescues quiet-but-real speech without
   loosening the reject thresholds themselves (which would also admit more
   noise). The pure gain-factor math (`computeGainFactor`) lives in
   `speech-filters.js`; applying it to a live `AudioBuffer` stays in
   `renderer.js` since that part is genuinely Web-Audio-API-coupled.
5. **Per-session transcription debug log.** `logSpeechDebug` now also sends
   every event over IPC to a new `main.js` handler
   (`log-speech-debug` -> `logs/speech-debug.log`, JSON lines), mirroring
   the existing `log-voice-crash` pattern -- only fires when
   `SPEECH_DEBUG_ENABLED` is on, so it's a no-op file by default. Lets a
   "why didn't Mana hear me" report be diagnosed after the fact instead of
   only live with devtools open.
6. **Synthetic-signal test harness.** `getSpeechRejectReason` was extracted
   into `speech-filters.js` as a pure function (thresholds passed in, not
   imported) so it's covered by the same test file as everything else here.
   New tests synthesize sine-wave "speech", near-silence, and a
   high-frequency "clicky noise" signal and run them through the real
   reject-decision logic -- the closest thing to the issue's own "sample
   WAV files" ask that's possible without real recorded audio in this
   environment.

## Deliberately deferred (with reasoning)

- **Empirically testing larger/different Whisper models for accuracy vs.
  latency.** No real microphone/room audio or comparison hardware exists in
  this environment to measure this honestly -- fabricating benchmark
  numbers would be worse than not claiming them. Item 2 above makes model
  choice a one-line config switch instead; an actual A/B measurement is
  real future work once there's audio to test against.
- **Per-noise-type tuning (keyboard/mouse/fan/game-specific).** Would need
  labeled noisy-audio datasets to tune meaningfully rather than guess
  universal magic numbers. Item 3's configurability is the honest ceiling
  without that data -- a user can tune `MANA_MAX_CLICKY_ZCR` for their own
  room/keyboard rather than Mana guessing a one-size-fits-all value.
- **Language-specific model profiles.** Already effectively covered:
  `WHISPER_MODEL` (or now `WHISPER_MODEL_PROFILE` combined with placing the
  right file) already lets a user point at any language-specific
  `ggml-*.bin`, including non-`.en` multilingual variants -- no new
  mechanism needed.
- **A Settings UI panel for the new env-var knobs.** Not requested by the
  issue's own acceptance criteria (only "documented in the README" was
  required); real added UI/store scope with no acceptance-criterion asking
  for it.

## Verified

- `windows-launcher/test/speech-filters.test.js` (18 tests, 14 new):
  Levenshtein distance, fuzzy wake-word matching (including the
  multi-word-phrase exclusion), gain-factor computation (boost, cap,
  no-op cases), and the synthetic-signal reject-reason harness.
- `node-bot/test/whisper-discovery.test.js` (14 tests, 5 new):
  `WHISPER_MODEL_PROFILE` preference, case-insensitivity, fallback when the
  requested tier's files aren't present, and an unrecognized profile value
  being ignored safely.
- Full `windows-launcher` suite (11 files, one process per file): no
  regressions.
