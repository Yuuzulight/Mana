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

**Updated after implementation review — this is what actually shipped,
not the original plan.** `runWhisperCli`'s `spawnSync` is NOT converted
in place. Investigation during implementation found it's shared by more
callers than expected — `/transcribe-only`, `/transcribe`,
`mobile-routes.js`, and `memory-inbox.js`, which has a code comment
explicitly documenting `// options.runWhisper: required, (filePath) =>
string (whisper.cpp is sync).` — converting the shared function would
have silently broken that caller. Instead, a wholly separate
`runWhisperCliPartial`/`spawnWhisperCliAsync` (async `spawn`, resolving
on process exit) was added alongside the untouched original.

A second, related blocking call was found and fixed the same way: the
upload path both routes share, `normalizeUploadedAudio`
(`node-bot/server.js:3382`), unconditionally `spawnSync`s `ffmpeg` on
every call with no format short-circuit — converting only the whisper
call left this one still blocking the event loop on every poll. A
parallel `normalizeUploadedAudioAsync` was added the same way, used only
by `/transcribe-partial`.

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
- Uses a single `AbortController` created once per `recordUntilSilence`
  call, aborted in `cleanup()` — so a poll still in flight when recording
  stops doesn't keep running (and competing for CPU with the real final
  transcription about to start) after the caller has stopped waiting on
  it. Added during implementation review; not in the original plan.
  Deliberately scoped to the client side only — killing the
  server-side whisper-cli/ffmpeg child process on abort is a follow-up,
  not done here (needs more careful engineering to avoid a
  double-response race, and the harm of not doing it — brief CPU
  contention, self-resolving in ~1-2s — is bounded).

### 4. Visible deliverable for this sub-project alone

`partialTranscript` is wired into the existing live status text both
apps already show while recording ("Mana is listening...", "Heard: ...")
— the user sees their words appear as they speak, not only after they
stop. This is real, verifiable value on its own, and is exactly the
callback/state plumbing Sub-project B's classifier will consume later.

## Testing

- `POST /transcribe-partial`: route test matching
  `barge-in-classify-route.test.js`'s `createApp`/`withServer` pattern —
  valid upload returns a transcript, missing file returns 400, a thrown
  whisper error returns 500. `runWhisperPartial` is mocked here — this
  tests the route layer, not the real whisper invocation.
- The real `runWhisperCliPartial`/`spawnWhisperCliAsync` pipeline: a
  separate test (`transcribe-partial-real-whisper.test.js`) with no mock,
  uploading a programmatically-generated short silent WAV (not a
  committed binary fixture, and not pointed at `node-bot/tmp/`, which is
  gitignored scratch that could vanish) through the real endpoint —
  exercises the async spawn, arg construction, JSON-wait loop, and
  parse/cleanup logic end to end. Skips gracefully (does not fail) in a
  checkout without the vendored whisper.cpp binary/model, since those are
  large gitignored files not guaranteed present in every environment
  (e.g. a fresh git worktree).
- Temp-file cleanup (`outJson`, `outBase + ".txt"`, and the uploaded
  audio itself) happens in a `finally` on every code path, not just the
  success path — this endpoint is polled repeatedly per recording
  (~16 times for a full-length utterance), so a leak on the routine
  "empty transcription" case compounds far faster than
  `runWhisperCli`'s one-shot equivalent would.
- Renderer polling loop itself: no automated coverage. This is NOT
  because `recordUntilSilence`'s logic is untested in general —
  `shouldStopRecording`, the pure decision function it's built on, has
  16 unit tests in both apps (`voice-endpointing.test.js`), precisely
  because it was extracted for testability. The untested part is
  specifically the `MediaRecorder`/timer wiring around it, which has no
  test infrastructure in either app — verified via manual run instead.

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
