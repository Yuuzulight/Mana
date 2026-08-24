# Native launcher: core voice loop (#479 sub-project 1)

## Context

Issue #479 tracks replacing the Electron `windows-launcher` with a native
Windows tray app (`windows-native-launcher/`, C#/.NET 8), to cut Mana's
runtime RAM/VRAM footprint. A scaffold already exists — tray icon,
transparent click-through overlay, process management for `node-bot` and
Kokoro TTS, and a `/perf/status` HTTP client — but none of the actual voice
pipeline (`docs/native_launcher_plan.md`'s six next-implementation-steps)
exists in C# yet. Scoping the full pipeline (mic capture, wake-word,
non-streaming replies, streaming replies, barge-in, avatar
expression/lip-sync) surfaced four separable, dependency-ordered pieces:

1. **Core voice loop** (this document): mic capture, Silero VAD-based
   silence detection, wake-word text matching, session-awake state,
   non-streaming `/reply` + `/synthesize` + playback, basic idle/talking
   avatar state.
2. Streaming replies: swap the non-streaming reply/synthesize call for
   `/reply/stream`'s NDJSON per-sentence pipeline. Builds on (1)'s
   playback mechanism.
3. Barge-in: interrupt playback when VAD detects the user talking over
   Mana. Needs (1)'s VAD running continuously (not just for recording)
   and a playback path to interrupt.
4. Avatar expression/lip-sync: RMS/MFCC audio analysis driving real
   expression states, replacing the static idle/talking swap. Needs (1)'s
   real audio stream to analyze.

This document covers only (1). The Electron `windows-launcher` remains the
supported full launcher until the native launcher reaches feature parity
(`docs/native_launcher_plan.md`'s own "Fallback" section) — this sub-project
does not force a cutover.

## Existing scaffold (unchanged by this sub-project)

- `ManaBackendClient.cs` — one `HttpClient` at `http://127.0.0.1:5005`,
  currently only `GetPerformanceStatusAsync()` (`GET /perf/status`).
- `ManaProcessManager.cs` — starts/health-checks `node-bot/server.js` on
  `127.0.0.1:5005` and Kokoro TTS on `127.0.0.1:5011`.
- `AvatarOverlayForm.cs` — `AvatarState { Idle, Talking }`, `SetState()`
  swaps a `PictureBox.Image` between two static PNGs. No animation, no
  expression system, no lip-sync hook.
- `ManaApplicationContext.cs` — tray menu, currently drives
  `AvatarOverlayForm.SetState()` manually via menu items.
- No NuGet packages beyond stock `net8.0-windows` + WinForms.

## What the Electron app does today (the behavior this sub-project ports)

- **Mic capture**: `getUserMedia` + `MediaRecorder` (webm), continuous
  recording gated by Silero VAD speech probability (RMS-threshold
  fallback only if the WASM VAD fails to load) — `voice-endpointing.js`'s
  `shouldStopRecording()` owns the silence-buffer stop-timing math.
- **Silero VAD**: `onnxruntime-web`, model fetched at build time from a
  public GitHub URL into a gitignored `assets/vad/silero_vad.onnx` (not
  committed to the repo). Fixed-shape streaming interface: 512-sample
  @16kHz float32 frames + 64-sample context, recurrent `[2,1,128]` state
  carried between calls.
- **Wake-word**: text-based fuzzy match (`fuzzyMatchesWakeWord()`) run
  **after** transcription, on the Whisper transcript — not real-time
  acoustic wake-word detection. `extractWakeCommand()` tries an
  exact/regex match first, then a fuzzy match on the first 3 words.
- **Session-awake state**: a single one-way latch (`let awake = false`),
  set `true` once a wake command is recognized, never reset for the
  process lifetime. Utterances are ignored while not awake.
- **`/transcribe-only`**: `POST multipart/form-data`, accepts any file —
  `node-bot/server.js`'s `normalizeUploadedAudio()` shells out to `ffmpeg`
  to produce a WAV (no explicit sample-rate/channel enforcement), falling
  back to the raw upload if ffmpeg is unavailable. The Whisper binary's
  own tested/expected input is 16kHz mono 16-bit PCM WAV.
- **`/reply`**: `POST application/json {text, modelProfile}` → JSON
  `{reply}` (non-streaming; this sub-project's path).
- **`/synthesize`**: `POST application/json {text}` → WAV blob.
- **Playback**: an `<audio>` element; `setAvatarState()` is called before
  playback starts, driving the avatar window over IPC.

## Design

### Component architecture & threading

Three new pieces, added to the existing scaffold, all `async`/`Task`-based
off the WinForms UI thread (matching `ManaBackendClient`/
`ManaProcessManager`'s existing pattern). New NuGet dependencies: `NAudio`
(WASAPI capture/playback) and `Microsoft.ML.OnnxRuntime` (VAD inference).

- **`SileroVadRunner.cs`** (new) — wraps `Microsoft.ML.OnnxRuntime`, ports
  `silero-vad.js`'s exact contract: 512-sample @16kHz float32 frames +
  64-sample context + recurrent `[2,1,128]` state carried between calls.
  Input shape mismatches must throw, not silently return near-zero
  probability (unlike the JS version's documented silent-failure note) —
  a C# port should fail loud on a wiring bug rather than degrade quietly.
- **`VoiceLoop.cs`** (new) — owns the state machine: continuous NAudio
  capture → per-frame VAD → speech-segment assembly → on segment end,
  calls the backend pipeline. Owns the `awake` latch (session-scoped,
  never resets, matches Electron's one-way behavior). Runs continuously
  from app start to app exit — VAD does not start/stop around individual
  conversation turns, so sub-project 3 (barge-in) can reuse the same
  always-on instance for detecting speech during playback without
  rework.
- **`ManaBackendClient.cs`** (extended) — three new methods,
  `TranscribeAsync(byte[] wavBytes)` → `POST /transcribe-only`,
  `ReplyAsync(string text)` → `POST /reply`,
  `SynthesizeAsync(string text)` → `POST /synthesize`, all reusing the
  existing `HttpClient` instance and base address. No new client class —
  this is additive to the established pattern.
- **`AudioPlayer.cs`** (new) — thin NAudio `WasapiOut`/`WaveFileReader`
  wrapper. Plays one WAV clip start-to-finish; no queueing, no
  per-sentence chunking (that's sub-project 2), no lip-sync analysis tap
  (that's sub-project 4).

`AvatarOverlayForm` is unchanged by this sub-project — still just
idle/talking, now driven by `AudioPlayer` playback events instead of only
the tray menu.

### VAD model sourcing

Mirrors `windows-launcher/scripts/fetch-silero-vad.js` exactly: a
build-time fetch step (an MSBuild `Target` or a small helper script)
pulling the same public URL
(`https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx`)
into `windows-native-launcher/assets/vad/silero_vad.onnx`, gitignored the
same way as both Electron apps' copies (`.gitignore` already has
`windows-launcher/assets/vad/` and `desktop-client/assets/vad/`; this adds
a third entry). The binary is not committed — same rationale as the
existing two copies: it's a large, publicly-fetchable, non-source asset.

### Capture flow (`VoiceLoop.cs`)

1. NAudio `WasapiCapture` opens the default microphone in shared mode,
   which returns audio at the device's own mix format (typically 44.1kHz
   or 48kHz, not an arbitrarily requested rate — shared-mode WASAPI
   doesn't let a client dictate the capture format the way exclusive mode
   does, and exclusive mode isn't worth its device-lock/compatibility
   cost here). Captured samples are resampled to 16kHz mono via NAudio's
   `MediaFoundationResampler` (or an equivalent `ISampleProvider` chain)
   before anything downstream sees them — both the VAD frames (step 2)
   and the WAV sent to `/transcribe-only` are post-resample 16kHz mono,
   matching Whisper's tested input format and Silero VAD's fixed
   contract. This is one required conversion step, not "no resampling
   needed" as an earlier draft of this section assumed.
2. Incoming (post-resample) samples are buffered and sliced into
   512-sample frames, each
   run through `SileroVadRunner` with the carried-forward `state`/context,
   producing a per-frame speech probability.
3. A segment-assembly loop (porting `voice-endpointing.js`'s
   `shouldStopRecording`/silence-buffer logic) accumulates frames into a
   growing WAV buffer while probability stays above threshold, closing
   the segment once probability stays low for the configured silence
   buffer duration.
4. Closed segment → `TranscribeAsync(wavBytes)`. If `!awake`: run the
   fuzzy wake-word check (porting `fuzzyMatchesWakeWord()`) against the
   transcript. No match → discard the segment, keep listening. Match
   found → set `awake = true`, strip the wake phrase from the transcript,
   continue to step 5. If already `awake`: skip straight to step 5 with
   the full transcript.
5. Non-empty (post-wake-word-strip) transcript → `ReplyAsync(text)` →
   `SynthesizeAsync(reply)` → playback (below) → loop back to step 1.

### Playback & avatar state

- `SynthesizeAsync` returns raw WAV bytes. `AudioPlayer` plays them via
  `WasapiOut` + `WaveFileReader`.
- Before playback starts: `AvatarOverlayForm.SetState(AvatarState.Talking)`.
  On natural playback completion (NAudio's `PlaybackStopped` event — this
  sub-project only handles the natural-end case; interrupt/cancel
  handling is sub-project 3's barge-in work): `SetState(AvatarState.Idle)`.
- One segment in flight at a time — no streaming/queueing (sub-project 2).

### Error handling

- Each HTTP call (`TranscribeAsync`/`ReplyAsync`/`SynthesizeAsync`) wraps
  in try/catch; a failure logs (matching `ManaProcessManager`'s existing
  console logging style) and the loop returns to listening rather than
  crashing — one bad turn must never kill `VoiceLoop`.
- VAD/ONNX Runtime load failure at startup (missing model file, runtime
  init error) is a hard failure surfaced via the tray icon's existing
  status mechanism. Deliberately no silent RMS fallback here, unlike
  Electron: Electron's fallback exists because a browser can sometimes
  fail to load WASM for reasons outside the app's control; a native
  .NET ONNX Runtime load failure means something is actually broken
  (missing model file, corrupt download, missing runtime) and should
  surface as an error, not silently degrade to a worse detector.

## Testing

- `SileroVadRunner` and the segment-assembly logic in `VoiceLoop` are the
  two genuinely algorithmic pieces — unit-tested against recorded fixture
  audio, reusing/porting the WAV fixture pattern from
  `node-bot/test/transcribe-partial-real-whisper.test.js` (~0.3s of
  near-silence at 16kHz mono 16-bit PCM as a baseline "should not trigger
  speech" fixture; a real speech clip as a "should trigger" fixture).
- `ManaBackendClient`'s three new methods are tested against a fake HTTP
  handler (matching whatever pattern, if any, existing `.cs` files use for
  testing — if none exists yet, a minimal `HttpMessageHandler` stub is
  sufficient; this scaffold has no xunit/nunit project yet, so the
  plan will need to add one).
- Capture/VAD-to-HTTP glue and playback are integration-tested by hand,
  per the plan doc's own testing precedent for this project — no existing
  automated harness covers real microphone/speaker hardware.

## Explicitly out of scope here

- Streaming replies (`/reply/stream`, NDJSON, per-sentence TTS) —
  sub-project 2.
- Barge-in (interrupting playback when the user talks over Mana) —
  sub-project 3. This sub-project's `VoiceLoop` runs its VAD continuously
  specifically so sub-project 3 can reuse it without restructuring.
- Avatar expression states and lip-sync (RMS/MFCC-driven, beyond
  idle/talking) — sub-project 4.
- Hotkey-triggered clip capture, screen-sensing triggers, gaming-mode
  idle-pause tuning, or any other `awake`-setting entry point beyond the
  wake-word path — these exist in the Electron app (`renderer.js` lines
  2925/3008/3077 and gaming-mode tuning at 3383-3400) but are separate
  features layered on top of the core voice loop, not part of it.
- RMS-threshold VAD fallback — deliberately not built (see Error handling
  above).
- Any change to `node-bot`'s HTTP endpoints, Whisper/Kokoro process
  management, or the existing `windows-launcher`/`desktop-client` Electron
  apps.
