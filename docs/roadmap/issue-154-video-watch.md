# Issue 154: Video-Watching Capability

## Goal

Give Mana a video-watching path built on pieces she already has: `ffmpeg`
(already a runtime dependency, used for audio format conversion), local
Whisper STT, and vision support in `llama-server-runtime.js`. Caption-first,
Whisper fallback -- both free, no external API key required, unlike the
reference implementation this was built from.

## Status: Implemented (`plugins/video-watch/`, toggleable, off by default)

- **`video-watch.js`**: `computeFrameBudget(durationSeconds)` -- ~1
  frame/3s for the first two minutes (matching "~12-30 frames for a short
  clip"), tapering to ~1 frame/10s beyond that, hard-capped at 100 frames
  and by a hard 2fps ceiling (which wins over the 12-frame floor for very
  short clips -- a 5-second video can't produce 12 distinct frames).
  `downloadVideo`/`getVideoDurationSeconds`/`extractFrames`/
  `transcribeVideoAudio` each wrap one external process (`yt-dlp`/
  `ffprobe`/`ffmpeg`/`whisper-cli`) with an injectable `spawnFn`, same DI
  pattern as `acp-memory-store.js`. `watchVideo(source, options)`
  orchestrates the whole pass: downloads if `source` is a URL, probes
  duration, pulls captions if `yt-dlp` found any (`parseCaptions` handles
  the standard WEBVTT cue format), otherwise falls back to
  `transcribeVideoAudio`, then extracts frames. `answerAboutVideo`
  hands the timestamped transcript + frames to the existing
  `runVisionReply` (llama-server-runtime.js) -- no new model-calling code.
- **Route**: `POST /video/watch` -- `{source, question}` -> `{durationSeconds,
  frameCount, transcriptSource, transcript, answer}`. `source` can be a
  URL (routed through `yt-dlp`) or a local file path.
- **`yt-dlp` is a new external dependency**, documented in the plugin's
  README alongside the existing ffmpeg/whisper setup docs.
- Wired into `node-bot/server.js`'s capabilities array; `runVisionReply`
  added to the shared `capabilityContext` (previously only built inline
  per-caller, since video-watch is the first capability-layer consumer of
  it).

## Whisper's timestamps weren't actually being kept anywhere

Auditing before building: `server.js`'s existing `runWhisper(filePath)`
parses whisper-cli's `--output-json` output but only ever joins every
segment's `.text` into one flat string -- it discards the per-segment
timestamps entirely (the voice pipeline that calls it has no use for
them). The issue wants a genuinely timestamped transcript, so
`transcribeVideoAudio` in this plugin does its own whisper-cli invocation
(reusing `whisper-discovery.js`'s bin/model auto-detection, but not
`runWhisper` itself) and keeps each segment's `offsets.from`/`offsets.to`.
This was the smaller, safer path -- rewriting `runWhisper` to
conditionally preserve timestamps would touch the live voice pipeline for
no benefit to it, where a self-contained plugin-local implementation
touches nothing else.

## Deliberate simplifications

- **Pre-recorded video only.** No live/streaming support, per the issue's
  explicit scope.
- **Not wired into Deep Research's source-gathering.** A future "transcribe
  any linked video" integration is explicitly left for once this
  capability exists and is proven standalone, per the issue.
- **Scene-change mode exists in the core module (`mode: "scene"`) but
  isn't exposed as a route parameter yet** -- `POST /video/watch` always
  uses the default keyframe-only (`-skip_frame nokey`) pass. Add a `mode`
  field to the route body if a real need for the higher-detail mode shows
  up; no route change was speculatively added for a mode nothing calls yet.
- **No persistence.** Each request's downloaded video/frames/audio live
  in a temp directory (`os.tmpdir()`) cleaned up after the response,
  win or lose -- this is a one-shot "watch and answer," not a video
  library, matching the issue's scope (no batch/library feature requested).

## Verification note

No real `yt-dlp`/`ffmpeg`/`whisper-cli` binaries were invoked in the
environment that built this -- every external process is injected as a
`spawnFn` in tests, so the actual command construction (arguments,
output-file parsing) is verified directly, but never against a real
video file or a live YouTube URL. Worth a manual end-to-end run (a real
URL and a local .mp4, both with and without captions) before relying on
this.

## Verified

- `plugins/video-watch/test/video-watch.test.js` (23 tests): frame-budget
  math (ceiling, floor, short-clip target, long-video cap), WEBVTT caption
  parsing (including inline tag stripping and empty-cue skipping),
  timestamp formatting, URL-vs-local-path detection, `yt-dlp`/`ffprobe`/
  `ffmpeg`/`whisper-cli` invocation and error handling (each verified via
  a fake `spawnFn`), `watchVideo`'s captions-vs-whisper branching, and
  `answerAboutVideo`'s prompt construction.
- `plugins/video-watch/test/video-watch-capability.test.js` (4 tests):
  the route's required-field validation, a full local-file-through-
  whisper-fallback request against a fake `spawnFn` and a fake
  `runVisionReply`, plugin metadata shape, and `getHealth`'s configured/
  unavailable states.
- `node-bot/test/health-components.test.js` (3 tests): updated snapshot
  for the new `videoWatch` component key.
- `node-bot/test/server-routes.test.js`: full regression pass after
  adding `runVisionReply` to the shared capability context.
