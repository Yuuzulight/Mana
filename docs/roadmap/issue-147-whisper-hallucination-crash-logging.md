# Issue 147: Whisper Hallucination Filter + Crash-Forensic Logging

## Goal

Two small, targeted additions to `windows-launcher`'s voice pipeline: filter
out Whisper's known short "phantom" transcriptions, and leave a structured
local log entry when the recording path fails, instead of console-only.

## Status: Implemented

### Hallucination filter

- **`windows-launcher/renderer/speech-filters.js`** (new): pure, DOM-free
  module -- same pattern as `avatar/live2d-logic.js` -- so it's directly
  unit-testable, unlike `renderer.js` itself (a plain browser script with
  no `module.exports`, relying on `document`/`window` at load time).
  `isLikelyWhisperHallucination(normalizedTranscript, durationSeconds)`
  only flags a match when the recorded clip was very short
  (`MAX_HALLUCINATION_AUDIO_SECONDS`, 2.5s) -- a real "thank you" takes
  longer to say than that, so a longer clip with the same wording is
  trusted and passed through untouched.
- **Distinct from the existing `NOISE_ONLY_TRANSCRIPTS` list** (already in
  `renderer.js`): that list is Whisper *honestly describing* non-speech
  audio it heard (`"background noise"`, `"keyboard clicking"`). This issue
  is about Whisper *fabricating* plausible-sounding dialogue that was
  never said at all (`"thank you"`, `"please subscribe"`, `"subtitles by"`)
  -- a different failure mode, so a separate list rather than merging into
  the existing one.
- **`prepareSpeechWavBlob`** now also records `durationSeconds` on the
  stats object it already computes (previously only used for debug
  logging); `transcribeBlob` checks the hallucination filter right after
  getting Whisper's result back, blanking `result.transcript` on a match
  so it flows through the same "empty transcript -> skip" path
  `isNoiseOnlyTranscript`'s empty-string case already uses.

### Crash-forensic logging

- **`windows-launcher/main.js`**: new `ipcMain.handle("log-voice-crash", ...)`
  appends a timestamped JSON line to
  `path.join(app.getPath("userData"), "logs", "voice-crash.log")` --
  `userData`, not the install directory, so it survives an
  uninstall/reinstall (matching desktop-client's local-data placement,
  issue #121).
- **`renderer.js`'s `listenLoop()`** catch block now calls it with the
  error message/stack, which audio backend was active (Silero VAD, RMS
  fallback after a mid-session Silero failure, or VAD disabled via
  `MANA_DISABLE_VAD`), the input device label if available, and the
  `awake`/`listening` state at the time of failure -- instead of only
  `console.error`, which is easy to lose once the window closes.

## Deliberate simplifications

- **No confidence score from Whisper itself.** The backend's
  `/transcribe-only` doesn't currently return a per-word/segment
  confidence value to filter on; recorded-audio duration is the practical
  proxy already available client-side, and it's exactly what the issue's
  acceptance criteria asks for ("very short ... transcriptions").
- **No new log-file dependency.** Plain `fs.promises.appendFile`, same as
  everything else in this codebase that persists local state.

## Verified

- `windows-launcher/test/speech-filters.test.js` (5 tests, new): known
  phrases flagged within the duration threshold, the same wording trusted
  past the threshold, real speech never flagged regardless of duration,
  a missing/non-numeric duration treated as "not enough signal to filter,"
  and every entry in the phrase list actually triggers at the boundary.
- Full existing `windows-launcher` test suite (7 files, 63 tests total
  across compare-mode/doctor-panel/live2d-logic/reply-emotion/silero-vad/
  vision-hotkey/voice-endpointing): 0 failures, run one file at a time.
