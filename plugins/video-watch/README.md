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

## Frame budget: duration-scaled, hard 2fps ceiling

`computeFrameBudget(durationSeconds)` targets roughly 1 frame per 3
seconds for the first two minutes (matching the reference
implementation's "~12-30 frames for a short clip"), tapering to roughly 1
frame per 10 seconds beyond that, capped at 100 frames total. A hard 2fps
ceiling always wins for very short clips. This matters more for Mana than
for a cloud model -- every frame is a local GPU vision inference, not
just a context token.

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

No real `yt-dlp`/`ffmpeg`/`whisper-cli` binaries were invoked in the
environment that built this -- every external process is injected as a
`spawnFn` in tests (same DI pattern the rest of Mana's plugins use for
network/filesystem access), so the actual download/extraction/
transcription commands are verified for correctness of their arguments
and output parsing, not against real video files. Worth a manual
end-to-end run (a real YouTube URL and a local .mp4) before relying on
this.
