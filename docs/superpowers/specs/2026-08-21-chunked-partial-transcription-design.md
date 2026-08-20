# Chunked partial transcription (#341 Sub-project A)

## Context

Issue #341 wants semantic end-of-turn detection ("still composing" vs.
"done talking") using the partial transcript and prosody, instead of
today's fixed silence timeout in `shouldStopRecording`
(`voice-endpointing.js`). That requires a partial transcript to exist
while the user is still talking — which nothing in Mana currently
produces.

## Investigation findings that shaped this design

- Today's transcription (`runWhisperCli`, `node-bot/server.js:3115-3170`)
  is a single `spawnSync` call against a complete, already-recorded audio
  file, invoked once after `recordUntilSilence` has already decided the
  turn ended. `spawnSync` **blocks the entire node-bot event loop** for
  the duration of the call — calling it repeatedly during a recording is
  not viable without first making it async.
- `tools/whisper/Release/whisper-stream.exe` already exists in this
  repo's vendored whisper.cpp build (no build/vendoring work needed to
  get it), but `--help` confirms it only captures audio itself via a
  `--capture ID` device selector — there is no piped/stdin/file audio
  input mode. It cannot slot into the existing renderer-side capture
  pipeline (`getUserMedia` + Silero VAD + barge-in monitors, built in an
  earlier sub-project) without running as a second, independent process
  reading the same physical mic device, unsynchronized with the
  renderer's own VAD. Rejected for that reason — see "Explicitly out of
  scope" below.
- Both apps' `recordUntilSilence` already accumulates `MediaRecorder`
  chunks progressively via `ondataavailable` (already ticking on
  `SILENCE_METER_INTERVAL_MS`), so a growing-blob snapshot at any point
  during recording is already possible with no new capture mechanism.

## Design

### 1. Backend — async whisper invocation

Convert `runWhisperCli`'s `spawnSync` (`node-bot/server.js:3150`) to an
async `spawn` wrapped in a Promise, resolving on process exit the same
way `spawnSync`'s return value is used today (exit code, stdout, stderr,
then reading the JSON output file). This is a prerequisite regardless of
polling frequency — even the existing single call-per-utterance already
blocks the server for its duration.

### 2. Backend — `POST /transcribe-partial`

New endpoint, same multipart-upload shape as the existing
`POST /transcribe-only` (`node-bot/server-routes.js:96`), running the now-
async whisper call against whatever audio-so-far the renderer sends.
Uses the same auto-detected `WHISPER_MODEL` as final transcription (no
new model file, no new config) — if partial-poll latency proves too slow
in practice on a given machine, that's a tuning knob (poll interval, or
switching `WHISPER_MODEL_PROFILE=tiny`), not a design change.

### 3. Renderer — periodic snapshot-and-poll during recording (both apps)

Inside `recordUntilSilence`'s existing tick loop, add a second timer
(~1200ms interval, a new tunable constant) that:
- Snapshots `new Blob(chunksSoFar, {type: 'audio/webm'})` from whatever
  chunks have accumulated so far (no change to the existing
  `ondataavailable` accumulation).
- POSTs it to `/transcribe-partial`.
- On success, updates a `partialTranscript` value visible to the caller.
- On failure or if a poll is still in flight when the next tick fires,
  skips that poll silently — never blocks or delays the actual
  recording/stop-detection logic (`shouldStopRecording`'s own timing is
  completely unaffected by this).

### 4. Visible deliverable for this sub-project alone

`partialTranscript` is wired into the existing live status text both
apps already show while recording ("Mana is listening...", "Heard: ...")
— the user sees their words appear as they speak, not only after they
stop. This is real, verifiable value on its own, and is exactly the
callback/state plumbing Sub-project B's classifier will consume later.

## Testing

- Async whisper invocation: unit test that the promise-wrapped `spawn`
  resolves with the same shape `spawnSync` did (exit code, stdout,
  parsed JSON transcript), tested against a real short audio fixture,
  matching how `runWhisperCli`'s existing behavior would already need
  fixture-based testing.
- `POST /transcribe-partial`: route test matching
  `barge-in-classify-route.test.js`'s `createApp`/`withServer` pattern —
  valid upload returns a transcript, missing file returns 400.
- Renderer polling loop: no automated coverage, matching this codebase's
  established precedent for `recordUntilSilence`'s own live-recording
  logic (no test infrastructure exists for MediaRecorder-driven timing
  in either app) — verified via manual run.

## Explicitly out of scope

- `whisper-stream.exe` / true SDL2-based mic streaming — rejected above;
  would require a second, independent mic-capture process unsynchronized
  with the existing renderer-side VAD/barge-in pipeline.
- The actual end-of-turn classifier (prosody + partial-transcript-based
  decision replacing the fixed silence timeout) — that's Sub-project B,
  built on top of this sub-project's `partialTranscript` output plus a
  prosody signal not yet designed.
- Any change to `shouldStopRecording`'s current fixed-timeout behavior —
  this sub-project only adds a new, additional signal stream; it does
  not change when recording actually stops.
