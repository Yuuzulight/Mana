# Issue 154: Video-Watching Capability

## Goal

Give Mana a video-watching path built on pieces she already has: `ffmpeg`
(already a runtime dependency, used for audio format conversion), local
Whisper STT, and vision support in `llama-server-runtime.js`. Caption-first,
Whisper fallback -- both free, no external API key required, unlike the
reference implementation this was built from.

## Status: Implemented (`plugins/video-watch/`, toggleable, off by default)

- **`video-watch.js`**: `computeFrameBudget(durationSeconds)` -- ~1 frame/5s,
  hard-capped at 20 frames and by a hard 2fps ceiling (which wins over the
  8-frame floor for very short clips -- a 2-second video can't produce 8
  distinct frames). These numbers were revised after real manual testing
  found the original ones broken against a local vision model -- see
  "Manual verification found and fixed two real bugs" below.
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

## Manual verification found and fixed two real bugs

The original build (above) disclosed that no real `yt-dlp`/`ffmpeg`/
`whisper-cli`/vision-model run had been exercised -- only injected
`spawnFn` fakes. A later manual verification pass ran the plugin
end-to-end against two real YouTube videos (a 39-second clip and a
~20-minute one) through the actual local stack (real `yt-dlp` install,
real `ffmpeg`/`whisper-cli`, real `llama-server` with Qwen2.5-VL-3B).
Both failed on the first pass, and both failures were real, not test
artifacts:

1. **Frame budget/resolution vastly exceeded the local vision model's
   context window.** The original numbers (12-30 frames for a short
   clip, up to 100 for longer ones) were carried over from the reference
   implementation's cloud-model assumptions and never checked against a
   real local model's context size. Measured directly against this
   codebase's own default local vision setup (llama-server's default
   `-c 4096`): a full-resolution 1280x720 frame costs **~1210 prompt
   tokens** -- so even the 8-12 frame floor would blow the entire context
   on images alone. The 39-second test video (13 frames at full
   resolution) failed at 30,301 tokens; the 20-minute one (100 frames)
   failed at 299,045 tokens. Fixed by downscaling every extracted frame
   to 336px wide by default (`DEFAULT_FRAME_MAX_DIMENSION`, configurable
   via `frameMaxDimension`/`MANA_VIDEO_FRAME_MAX_DIMENSION`) -- measured
   at ~88 tokens/frame at that resolution -- and lowering `MIN_FRAMES`/
   `MAX_FRAMES` from 12/100 to 8/20 to match what a small local context
   window can actually afford, not what a cloud model with a huge context
   window could.
2. **The transcript had no length cap before being embedded in the vision
   prompt.** Even after fixing (1), the 20-minute video still failed --
   this time at 31,465 tokens, almost entirely transcript text. YouTube's
   auto-generated captions repeat most of each line 2-3 times across
   overlapping caption windows (visible directly in this plugin's own
   transcript output), so a long video's transcript can run to tens of
   thousands of characters. `answerAboutVideo` now truncates the copy of
   the transcript sent to the model at `MAX_TRANSCRIPT_CHARS_FOR_PROMPT`
   (4000 chars) -- the full, untruncated transcript is still returned to
   the API caller in the route response; only the model-facing copy is
   capped.

Both videos now complete successfully end-to-end after both fixes,
including a real grounded, in-persona answer from the vision model
describing each video's actual content.

## Verified

- **Real end-to-end runs** against two live YouTube videos (39s and
  ~20min) through the actual local stack (real `yt-dlp`, `ffmpeg`,
  `whisper-cli`, and `llama-server` with Qwen2.5-VL-3B) -- both now
  return `200` with a coherent, grounded answer. This is the manual
  verification the original build disclosed as missing.
- `plugins/video-watch/test/video-watch.test.js` (26 tests): frame-budget
  math (ceiling, floor, conservative target, long-video cap), WEBVTT caption
  parsing (including inline tag stripping and empty-cue skipping),
  timestamp formatting, URL-vs-local-path detection, `yt-dlp`/`ffprobe`/
  `ffmpeg`/`whisper-cli` invocation and error handling (each verified via
  a fake `spawnFn`), frame downscaling (default and custom
  `frameMaxDimension`), `watchVideo`'s captions-vs-whisper branching, and
  `answerAboutVideo`'s prompt construction including transcript
  truncation.
- `plugins/video-watch/test/video-watch-capability.test.js` (4 tests):
  the route's required-field validation, a full local-file-through-
  whisper-fallback request against a fake `spawnFn` and a fake
  `runVisionReply`, plugin metadata shape, and `getHealth`'s configured/
  unavailable states.
- `node-bot/test/health-components.test.js` (3 tests): updated snapshot
  for the new `videoWatch` component key.
- `node-bot/test/server-routes.test.js`: full regression pass after
  adding `runVisionReply` to the shared capability context.
