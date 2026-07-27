# video-watch

Give Mana a video-watching path: download a video (`yt-dlp`) or accept a
local file, pull captions first (free) and only fall back to local
Whisper transcription when the source has none, extract a duration-scaled
set of frames, and hand transcript + frames to the existing local vision
pipeline for a grounded answer. Disabled by default (Settings > Plugins).

## No external API key required for the common case

Captions cost nothing to pull, and the Whisper fallback runs locally
(same `whisper-cli`/model Mana's voice pipeline already uses) -- neither
path needs a Groq/OpenAI key, unlike the reference implementation this
was built from.

## External dependencies

- **`yt-dlp`** (new): downloads a video (and its captions, if any) from a
  URL. `MANA_YTDLP_PATH` overrides the bare `yt-dlp` PATH lookup.
- **`ffmpeg`/`ffprobe`**: already a runtime dependency (used for audio
  format conversion in the voice pipeline). Reused here for frame
  extraction and duration probing. `MANA_FFMPEG_PATH`/`MANA_FFPROBE_PATH`
  override the bare PATH lookup.
- **Whisper**: reuses `node-bot/whisper-discovery.js`'s existing
  `WHISPER_BIN`/`WHISPER_MODEL` auto-detection -- no separate setup beyond
  what the voice pipeline already needs.

## Frame budget: duration-scaled, hard 2fps ceiling, downscaled

`computeFrameBudget(durationSeconds)` targets roughly 1 frame per 5
seconds, capped at 20 frames total (8 at minimum). A hard 2fps ceiling
always wins for very short clips. Every extracted frame is also
downscaled to 336px wide by default (`DEFAULT_FRAME_MAX_DIMENSION`,
override via `frameMaxDimension`/`MANA_VIDEO_FRAME_MAX_DIMENSION`).

These numbers -- and the downscaling -- exist because a local vision
model pays real context-window cost per frame, unlike a cloud model with
a huge context window: measured directly against this codebase's own
default local vision setup (Qwen2.5-VL-3B, llama-server's default `-c
4096`), a full-resolution 1280x720 frame costs ~1210 prompt tokens (so
even a handful of frames blows the entire context on images alone),
while a frame downscaled to 336px wide costs ~88 tokens. The original
numbers here were carried over from the reference implementation's
cloud-model assumptions and confirmed broken via real manual testing
before being fixed -- see `docs/roadmap/issue-154-video-watch.md`.

## Keyframe-only by default, optional scene-change mode

Default frame extraction uses `-skip_frame nokey` -- a fast/cheap pass,
since ffmpeg never fully decodes non-keyframes. An optional `mode:
"scene"` (per-request, not yet exposed as a route parameter -- see below)
trades speed for picking visually-distinct frames via a scene-change
filter instead of whatever the encoder happened to keyframe on.

## Route

- `POST /video/watch` -- `{ source, question }`. `source` is a URL or a
  local file path. Returns `{durationSeconds, frameCount,
  transcriptSource, transcript, answer}`. `transcriptSource` is
  `"captions"` or `"whisper"` depending on which path was used.

## Deliberate simplifications

- **Pre-recorded video only.** No live/streaming support, per the issue's
  scope.
- **Not wired into Deep Research.** A future "transcribe any linked
  video" integration is explicitly left for once this capability is
  proven standalone, per the issue.
- **Scene-change mode isn't exposed as a route parameter yet** -- the
  core `extractFrames`/`watchVideo` support a `mode: "scene"` option, but
  `POST /video/watch` always uses the default keyframe-only pass. Add a
  `mode` field to the route body when a real need for it shows up.
- **No persistence.** Each request's downloaded video/frames/audio live
  in a temp directory that's cleaned up after the response, win or lose --
  this is a one-shot "watch and answer," not a video library.

## Verification note

Verified with real end-to-end runs against two live YouTube videos (a
39-second clip and a ~20-minute one) through the actual local stack
(real `yt-dlp`, `ffmpeg`, `whisper-cli`, and `llama-server` with
Qwen2.5-VL-3B) -- both succeed and produce a grounded, in-persona answer.
This surfaced and fixed two real bugs (oversized frame budget/resolution,
unbounded transcript length in the prompt -- see
`docs/roadmap/issue-154-video-watch.md`) that unit tests with injected
`spawnFn` fakes couldn't have caught on their own.
