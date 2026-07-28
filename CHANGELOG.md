# Changelog

All notable changes to Mana are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

This file starts tracking from **0.2.0** — Mana has an extensive commit
history before this (`git log` has the full detail), but nothing summarized
it at a release level until now. Earlier work isn't reconstructed
retroactively; `0.1.0` below is a short baseline description, not a full
accounting.

## [Unreleased]

### Security
- Cleared all 98 open Dependabot alerts: bumped `multer` (1.x -> 2.x),
  `electron-builder`/`app-builder-lib`/`builder-util-runtime` (24.x -> 26.x),
  `esbuild`, `requests`, `python-multipart`; overrode the dead-weight
  `gh-pages` transitive dep pulled in by `pixi-live2d-display` and the
  unreachable `@hono/node-server` pulled in by `@modelcontextprotocol/sdk`.
  (`torch` was initially left pinned to `2.6.0` here because
  `chatterbox-tts==0.1.7` hard-required that exact version -- see below,
  since removed, so this no longer applies.)
- Fixed all 70 open CodeQL alerts: added an app-wide rate limiter
  (`express-rate-limit`) covering every node-bot route; gated the
  editor/workspace-control routes (`/zed/*`, `/editors/*`) behind admin auth
  after finding they were reachable unauthenticated with CORS wide open;
  added path-traversal validation to the pending-writes admin routes and
  `resolve_voice_ref` (tts-service); fixed a genuine ReDoS-shaped ambiguous
  regex in the mobile auth header parser and three others; fixed a real
  double-unescaping bug in `web-access.js`'s HTML-entity decoding; switched
  `auth-store.js`'s API-key hashing to salted scrypt with a migration path
  for existing accounts; added explicit `permissions:` blocks to all GitHub
  Actions workflows; and more (see PR for the full list).
- Bumped `electron` from 26.x to 39.8.10 in both `windows-launcher` and
  `desktop-client`, closing the remaining 34 Dependabot alerts. Verified by
  launching both apps and checking for real errors, and a full
  `electron-builder` packaging build for `desktop-client`.

### Removed
- **Chatterbox TTS provider**, at the user's request: deleted
  `tts-service/service.py` and `start.ps1`, and every `chatterbox`
  reference across `tts-runtime.js`, `server.js`, `doctor.js`, the
  `windows-launcher` process-management/UI code, and docs. This also
  freed `tts-service/requirements.txt`'s `torch`/`torchaudio` pins
  entirely (nothing else there needed them -- `kokoro-onnx` only needs
  `onnxruntime`), which is what was blocking the remaining torch
  Dependabot alerts.

### Changed
- `desktop-client`'s sidebar had Avatar/Web access/Market watch/Vision/
  Model/Doctor as top-level buttons alongside Settings; moved them inside
  Settings (a new "Status" section) to match `windows-launcher`, where
  they'd already been nested there since the issue #138 UI overhaul.

### Added
- **Real GGUF metadata parsing** (issue #196): a new `GET /models/gguf-metadata`
  route (on-demand, kept separate from the frequently-polled
  `/models/status` since real header parsing is real file I/O) uses
  `@huggingface/gguf` to read a model's actual architecture, quantization,
  context length, and computed parameter count, instead of only validating
  the 4-byte magic bytes as before. The magic-byte check (issue #125)
  stays the fast first-pass gate, unchanged.
- **Passive web context** (issue #189, `context-push` plugin +
  `context-push-extension` browser extension, both off by default): a new
  Manifest V3 Chrome/Edge extension reads the current page's text (and,
  on YouTube, visible captions) and pushes it to a new loopback-only
  `POST /context/push` route, so Mana can answer "what does this page say"
  or "what am I watching" when asked -- ephemeral only (2-minute expiry,
  never written to memory), and only contributed to a reply when the
  message actually references the current page/video. Always-on once
  enabled, with a non-negotiable indicator (toolbar icon color swap,
  green/grey) and a one-click, restart-persistent off switch, plus a
  first-install onboarding page explaining the behavior before capture
  ever starts.
- **Speech recognition accuracy improvements** (issue #4): fuzzy wake-word
  matching catches close Whisper mis-transcriptions of "Mana" (e.g. "Manaa",
  "Mona") the exact word list can't enumerate; a new microphone gain step
  boosts quiet clips before Whisper sees them, rescuing soft-spoken speech
  without loosening noise-rejection thresholds; those thresholds
  (`MANA_MIN_SPEECH_RMS`/`MANA_MIN_SPEECH_PEAK`/`MANA_MAX_CLICKY_ZCR`) and a
  new `WHISPER_MODEL_PROFILE` (tiny/base/small/medium) knob are now
  configurable via env vars; and a per-session `speech-debug.log` persists
  transcription debug events to disk for after-the-fact diagnosis.
- **Discord voice channel support** (issue #187, `discord-bot` plugin): send
  `!join <channelId>` in an already-paired DM and Mana joins that voice
  channel, transcribes each speaker with Whisper (a new async,
  FIFO-serialized `whisper-queue.js`, since the existing `/transcribe`
  route's `runWhisper` is blocking and unsafe to share), replies through the
  same pipeline DM text already uses, and speaks the reply back with full
  TTS (provider switching, VTube reactions, captions -- newly exposed via
  `capabilityContext.synthesizeReply`). Barge-in comes free from Discord's
  own speaking-start signal (stop in-progress playback the moment a new
  speaker starts) rather than needing new detection logic. Also corrects a
  wrong assumption in the issue's own original scope: `@discordjs/voice`
  already provides silence-based endpointing
  (`EndBehaviorType.AfterSilence`), so no custom VAD needed to be built.
  Along the way, found and fixed an npm optional-peer-dependency trap where
  `prism-media` silently pulled in `@discordjs/opus`'s unpatched critical
  CVE chain even after switching to `opusscript`; `.npmrc`'s `omit=optional`
  plus a fresh lockfile closed it (`npm audit --omit=dev`: 0
  vulnerabilities).
- **Unified tool-execution audit/approval layer** (issue #188): every tool
  call Mana makes during a reply -- local `read_file`, browser-automation,
  or a remote MCP tool (#169) -- now shares one audit trail
  (`GET /tool-calls/recent`, JSON-lines on disk) regardless of source.
  `browser-automation`'s navigate/click/type/snapshot are now also
  available as tool-calling actions (not just HTTP routes), gated behind a
  one-time approval the first time they're used as a tool -- after that,
  calls execute immediately, same as any other already-trusted approval-
  gate action.
- **Outbound MCP client** (issue #169): Mana can now connect *outward* to
  third-party MCP servers and use their tools, not just expose her own
  capabilities as a server (`mcp-server.js`). New `mcp-client-registry.js`
  -- per-server tool allowlisting, an env-var allowlist for stdio-spawned
  servers (starts from the SDK's safe default environment, never
  `process.env`), and registration routed through the approval gate
  (#152) with a uniquely-scoped decision per server. Also fixes a real bug
  found while wiring this in: the tool-calling loop
  (`runToolAwareReply`) called `executeTool()` without awaiting it --
  harmless for the one existing synchronous tool, but would have silently
  corrupted every async MCP tool result into the literal string
  `"[object Promise]"`.
- **Configurable backend URL** (issue #190, `windows-launcher`): the
  hardcoded `http://localhost:5005` (32 occurrences across `main.js` and
  three renderer files) is now a persisted setting (Settings >
  Connection) -- the first step toward pointing the Electron client at a
  remote `node-bot` instead of only a co-located one. `main.js` no longer
  spawns a local `node-bot` child process when the configured backend is
  remote. Takes effect on next launch, not live.
- **"Use Remote AI" brain provider**: a toggle under Model Selection (both
  apps) opening a provider dropdown (OpenAI/OpenRouter/Groq/Ollama/LM
  Studio/Custom, sourced from `GET /models/brain-providers` so the two
  apps' dropdowns can't drift apart), an API key field, and a "Connect"
  button that actually tests the endpoint (`POST /models/brain-provider/test`)
  before saving. `shouldUseRemoteAi` already exempted local/LAN endpoints
  from the remote-AI consent gate; this is the Settings UI for it.
- **`document-reader` plugin**: ingest a local PDF or a specific web page
  into Mana's existing memory retriever, so she can recall and cite it in
  replies. Reuses the retriever end-to-end (no new vector store) and
  `web-access.js`'s SSRF-guarded `fetchPage` for URL ingestion.
- Subtle idle "looking around" drift (head + eyes) for the Live2D avatar,
  in both apps -- separate, independently-configurable knob from the
  existing sleepy idle-tilt (`idleGazeDeg`/`idleGazePeriodMs` in
  `mana-avatar.json`, 0 opts out).
- `acp-memory-store.js`'s `getRelatedFacts()` (issue #141): a bounded,
  on-demand lookup that surfaces facts from *other* sessions when the
  current message names an entity previously discussed elsewhere, reusing
  the existing entity index (issue #78). Capped independently
  (`MANA_RELATED_FACTS_MAX_ENTITIES`/`MANA_RELATED_FACTS_MAX_CHARS`) so it
  never grows with total memory volume -- the on-demand half of the
  two-tier memory design alongside the existing always-injected summary.
- **`tools/script-runner.js`** (issue #142): a general-purpose primitive
  for running a generated script in an isolated child process with a
  whitelisted set of tool functions it can call (round-tripped over IPC to
  the real implementations) -- no `require`/`fs`/network access of its
  own. Not yet wired into a specific capability; see the roadmap doc for
  why Deep Research (the issue's suggested first caller) didn't need it.
- **`persona.js`** (issue #143): Mana's identity now lives in exactly one
  place (`MANA_PERSONA`), replacing four drifting hand-copies scattered
  across `local-llama-runtime.js` and three separate per-mode prompts in
  `server.js`. Adds a session-scoped temporary override
  (`POST /persona/override` / `POST /persona/override/clear`) for a
  one-off mode switch that reverts cleanly without editing the base file.
- **`cron-scheduler` plugin** (issue #144): run a script action or a full
  agent prompt on a fixed interval or daily-at-time schedule, independent
  of chat or idle activity. Results deliver as a chat turn via the
  existing `acpMemoryStore.appendTurn`, visible in the Sessions list UI
  with no new frontend work. Off by default -- enable in Settings > Plugins.
- **`tools/subagent-delegation.js`** (issue #145): a flat, capped-concurrency
  task-delegation primitive. Deep Research's source-reading step now reads
  up to `maxConcurrency` (default 3) sources at once instead of strictly
  one at a time, with citation numbering staying stable regardless of
  which read finishes first.
- **Whisper hallucination filter** (issue #147, `windows-launcher`): known
  short "phantom" transcriptions ("thank you", "please subscribe",
  "subtitles by", ...) are filtered when the recorded clip was very short
  -- a real utterance with the same wording, spoken normally, is trusted.
- **Voice-pipeline crash logging** (issue #147, `windows-launcher`): a
  failed recording attempt now writes a timestamped entry (error, audio
  backend, input device, app state) to a local `voice-crash.log` under
  the app's `userData` directory instead of console-only.
- **Renderable artifacts** (issue #148, both apps): chat replies render as
  sanitized markdown (`marked` + `DOMPurify`) instead of raw text; a large
  or ```` ```html ```` fenced block opens in its own window instead of
  dominating a chat bubble. **Sanitization could not be visually verified
  this session** (Browser pane was unresponsive) -- worth an explicit
  script-injection click-through before/soon after this ships.
- **`image-generation` plugin** (issue #149): text-to-image and
  image-editing, local-first via an Automatic1111-compatible HTTP API
  (`MANA_IMAGE_BACKEND_URL`), with an opt-in external API fallback
  (`MANA_IMAGE_API_KEY`), never a default. No dedicated chat UI needed --
  a result renders inline through issue #148's markdown pipeline. Off by
  default -- enable in Settings > Plugins. No local SD backend was
  available to verify against a live generation this session; the
  Automatic1111 request/response shape is verified via mocked HTTP calls.
- **`browser-automation` plugin** (issue #150): navigate/click/type/read a
  live page for a specific site interaction, distinct from `web-access.js`'s
  search-and-extract. Launches Edge by default (ships on every Windows
  install) via `playwright-core`, no bundled browser download. Ref-based
  element addressing (`data-mana-ref`), text-mode reads by default,
  local-only routes. Off by default -- enable in Settings > Plugins. No
  real browser was launched to verify this session (no Windows/Edge on CI,
  Browser pane unresponsive) -- verified against a fake page-like object.
- **`telegram-bridge` plugin** (issue #151): message Mana remotely over
  Telegram via long-polling (no webhook, nothing exposed to the internet),
  gated by a one-time pairing code so a stranger's DM can't reach her
  without approval (`POST /telegram/approve`). DM-only, text-only. Off by
  default -- enable in Settings > Plugins and set
  `MANA_TELEGRAM_BOT_TOKEN`. No real bot token was available to verify
  against the live Telegram API this session -- verified via a fake
  `getUpdates`/`sendMessage` client.
- **`discord-bot` plugin** (issue #185): a second remote-messaging option
  alongside `telegram-bridge`, added rather than replacing it. Uses
  `discord.js`'s Gateway `Client` (a websocket, since Discord has no
  long-poll equivalent to Telegram's `getUpdates`) with the same
  pairing-code approval gate (`POST /discord/approve`). DM-only,
  text-only. Off by default -- enable in Settings > Plugins and set
  `MANA_DISCORD_BOT_TOKEN`. No real bot token was available to verify
  against the live Discord API this session -- verified via a fake
  `message` object matching `discord.js`'s real `Message` shape.
- **Approval gate for agent-authored content** (issue #152): a shared
  primitive (`approval-gate.js`) both the skills layer (#140) and
  programmatic tool calling (#142) can call into before trusting content
  Mana wrote herself. `POST /skills` now pauses for approval
  (`allow-once`/`always-allow`/`deny` via `POST /approvals/:id/decide`)
  instead of writing immediately; `always-allow` persists per action type
  so it doesn't nag once trusted. Optional off-by-default keyword/pattern
  content scan flags a pending request for the approver's attention.
- **Session trajectory export** (issue #153): `GET /sessions/:id/export`
  writes a session's full turn history as ShareGPT-style JSONL (tool calls
  included as `function_call`/`observation` entries); a new "Export
  (ShareGPT JSONL)" entry in windows-launcher's session sidebar context
  menu saves it via a native dialog. Tool-call metadata is now also
  persisted on each turn going forward (`acp-memory-store.js`'s
  `appendTurn`) -- previously it was only ever logged to console, never
  stored, so there was nothing for an export to preserve.
- **`video-watch` plugin** (issue #154): download (`yt-dlp`) or accept a
  local video, pull captions or fall back to local Whisper transcription
  (both free -- no external API key needed), extract a duration-scaled
  set of frames (keyframe-only by default), and answer a question
  grounded in what's actually shown/said via the existing local vision
  pipeline. New `POST /video/watch` route. Off by default -- enable in
  Settings > Plugins. `yt-dlp` is a new external dependency. No real
  video/binaries were exercised this session -- verified via injected
  fake process calls.
- **Conversational rut detection** (issue #159): a cheap n-gram-similarity
  check (`rut-detection.js`) flags when a reply is too similar to Mana's
  own recent replies. Wired into both Best-of-N's candidate selection
  (prefers a less-repetitive already-generated candidate over the judge's
  blind pick) and the general reply path (one regeneration with a "say
  this differently" nudge). A per-session cooldown stops it from
  triggering constant regeneration once a rut is broken.
  `MANA_RUT_DETECTION_ENABLED` (default on), `MANA_RUT_LOOKBACK`,
  `MANA_RUT_SIMILARITY_THRESHOLD`, `MANA_RUT_COOLDOWN_REPLIES` tune it.
- **Anti-formulaic-phrasing rewrite pass** (issue #160): a hand-curated
  lexicon of Mana's known catchphrases/openers/kaomoji
  (`phrasing-variation.js`) catches one recurring within the last few
  replies and asks the model for one alternate phrasing of just that
  fragment -- not a full regeneration, and never a content/meaning
  change. Pairs with windows-launcher's existing `reply-emotion.js`
  rather than replacing it. `MANA_PHRASING_VARIATION_ENABLED` (default
  on), `MANA_PHRASING_LOOKBACK` tune it.
- **VRM (3D) avatar support** (issue #161): a second avatar renderer
  alongside Live2D (`three` + `@pixiv/three-vrm`), driven by the exact
  same lip-sync/emotion signal pipeline (`avatar/lip-sync.js`, extracted
  and shared between both renderers). VRM is preferred when a `.vrm`
  model is configured (drop it in `windows-launcher/avatar/model/`, or
  set `MANA_VRM_MODEL`); falls back to Live2D otherwise, same as Mana
  already degrades when the Live2D model is missing. Wired into both
  windows-launcher avatar surfaces (the overlay and the inline chat-
  window avatar); `desktop-client` doesn't have it yet, following the
  same incremental path Live2D itself took. See
  `docs/vrm_avatar_setup.md`. No real VRM model/GPU rendering was
  exercised this session -- verified via unit tests on the pure logic and
  confirming the new dependencies load correctly.
- **Multi-round tool-calling loop** (issue #183): `runToolAwareReply` was
  a fixed two-call sequence -- one round of tool calls, then a forced
  final answer, with any *further* tool calls the model requested in that
  final response silently ignored. Now loops (bounded by
  `MANA_TOOL_CALLING_MAX_ROUNDS`, default 4) so a tool's results can
  inform another tool call -- the actual prerequisite for issue #169's
  outbound MCP client support. New caps: per-round tool-call limit
  (`MANA_TOOL_CALLING_MAX_CALLS_PER_ROUND`), a wall-clock budget
  (`MANA_TOOL_CALLING_MAX_MS`), and a consecutive-tool-error backstop --
  hitting any of them forces one final `tool_choice: "none"` completion so
  the reply is always something the model actually generated, never a
  blank or synthetic fallback.

### Fixed
- Session-level conversation memory (`buildPromptMemory`) was computed on
  every turn but never actually appended to the prompt -- `memoryBlock`
  was built and then silently discarded, so Mana's own session summary
  never reached the model. Fixed by appending it to the system prompt,
  matching how `BACKGROUND_MEMORY_BLOCK` was already injected (issue #141).
- `runOpenAIReply` referenced removed `OPENAI_API_KEY`/`OPENAI_BASE_URL`/
  `OPENAI_MODEL` consts left over from the brain-provider refactor above --
  would have thrown at runtime the moment remote AI was actually used.
- The `windows-launcher` overlay always rendered a static SVG sprite first
  and only switched to the Live2D model once/if it finished loading;
  removed the sprite fallback entirely so only the Live2D model ever
  renders, and deleted the leftover placeholder assets.
- The compact 440x460 startup window showed a horizontal scrollbar because
  the underlying sidebar+chat layout (hidden behind the startup overlay,
  but still occupying flex space) didn't shrink below the overlay's width;
  added `overflow-x: hidden` in both apps.
- Model-file loading now checks the actual GGUF magic bytes, not just the
  `.gguf` extension, before handing a file to llama-server; brain-provider
  `baseUrl` is now restricted to `http/https` (was any URL scheme).
- **`video-watch` plugin (issue #154), found via real manual testing**:
  the original frame budget (12-30 frames, up to 100 for long videos) was
  carried over from the reference implementation's cloud-model
  assumptions and never checked against a local vision model's context
  window -- a full-resolution frame costs ~1210 prompt tokens against
  llama-server's default 4096-token context, so even a short test video
  failed with "exceeds context size." Fixed by downscaling extracted
  frames to 336px wide by default (~88 tokens/frame) and lowering the
  frame budget to 8-20. Separately, a long video's transcript had no
  length cap before being embedded in the vision prompt (YouTube's
  auto-captions repeat most lines 2-3 times across overlapping windows,
  so a 20-minute video's transcript ran to 70k+ characters) -- now
  truncated to 4000 chars for the model-facing prompt only; the full
  transcript is still returned to the API caller. Both fixes verified
  against two real YouTube videos end-to-end (real `yt-dlp`/`ffmpeg`/
  `whisper-cli`/`llama-server`), closing the manual-verification gap
  disclosed when this plugin first shipped.

### Docs
- **Issue #146 investigation**: Mana has no outbound MCP *client*
  capability today (`mcp-server.js` is server-only) -- but the already-
  installed `@modelcontextprotocol/sdk` ships a full client module, so
  building one needs no new dependency. Scoped, not built, since it
  depends on the tool-calling loop (issue #51) supporting more than one
  tool/round first; follow-up tracked as issue #169.

## [0.2.2] - 2026-07-27

This release exists primarily to verify the auto-update mechanism
(issue #120) end-to-end against a real published GitHub Release -- it also
folds in everything else that had accumulated on `main` since 0.2.1 but
never shipped in a tagged release.

### Added
- **Auto-update checking for `desktop-client`** via `electron-updater`
  against GitHub Releases. Both download and install are gated behind their
  own confirmation dialog, never automatic; `MANA_AUTO_UPDATE_ENABLED=0`
  disables checks entirely (issue #120).
- **First-run setup wizard for `desktop-client`** (issue #123).
- **Portable Python bundled into the packaged installer**, so a system
  Python install is no longer required (issue #127).
- **Per-plugin enable/disable settings**, exposed in Settings (issue #131).
- **`desktop-client`**: closing screen, session browser, local model picker,
  and plugin toggle UI (issue #134 area).
- **Silero VAD** replaces the RMS-threshold speech/silence heuristic in
  `windows-launcher`'s continuous-listening loop, with a graceful fallback
  if the model is unavailable (issue #135).
- **`windows-launcher` UI overhaul**: popup info bubbles for
  Avatar/Web access/Vision/Model/Doctor, a redesigned horizontal Doctor
  panel, a startup loading screen, the Mana Crystal logo, a fuller Settings
  menu (Logs/Plugins), and a themed scrollbar (issue #138).
- A legally-clean default sample Live2D avatar (`npm run fetch-sample-avatar`),
  downloaded at setup time from Live2D's own CDN under their Free Material
  License -- not bundled into the installer, since that license doesn't
  permit redistribution.

### Changed
- `desktop-client`'s local data relocated out of the install directory,
  so an uninstall/reinstall doesn't touch user data in-place
  (issue #121).
- `desktop-client`'s avatar renderer rewritten to be context-isolation-safe
  (issue #122).
- `desktop-client` reskinned; sidebar nav wired to real functionality
  instead of placeholders.
- `plugins/` bundled into the packaged `desktop-client` build so the
  installed app can actually boot standalone (issue #124).
- Root README brought up to date with the actual current feature set,
  including a real screenshot instead of placeholder art.

### Fixed
- Several small backend/desktop-client reliability bugs (issue #129).
- `vector-rebuild-audit` test no longer clobbers the real audit log.
- Plugin test scripts fixed to survive a Node version change.
- Live2D avatar sizing and startup-timing bugs in `windows-launcher`.

### Docs
- Code-signing options documented for the desktop-client installer
  (groundwork for issue #119; signing itself isn't implemented yet -- builds
  are still unsigned, so both install and update still trigger a SmartScreen
  warning).

## [0.2.1] - 2026-07-14

### Removed
- **Sprite artwork removed from the public repo.** `sprites/` (all rights
  reserved, see `LICENSE-ARTWORK`) is no longer tracked — it's gitignored
  going forward, and its history was purged from the repository entirely.
  The desktop app degrades gracefully without it (the same pattern already
  used for the Live2D avatar model/runtime). This release supersedes
  `v0.2.0`, which has been deleted.

## [0.2.0] - 2026-07-12

### Added
- **Live2D avatar ported into `desktop-client`** (the installer-packaged
  app): same driver as `windows-launcher`, with emotion-reactive states and
  RMS lip sync wired into the reply/audio flow, plus a zoom control and an
  always-visible in-app disclaimer banner. Clearly marked as a temporary
  testing placeholder, not the final avatar — see
  `desktop-client/AVATAR_NOTICE.md` for the miHoYo/HoYoverse attribution.
  Required temporarily enabling `nodeIntegration` for the desktop client's
  main window (documented tradeoff, scoped to this feature).
- **Setup automation script** (`tools/setup-mana.ps1`) for first-run npm
  installs across all three subprojects, `.env` scaffolding, model/binary
  directory creation, and a doctor report.
- **Built-in Live2D avatar** (`windows-launcher`): renders a Cubism model
  directly in the desktop UI instead of requiring VTube Studio. Drives
  emotion-appropriate motions/expressions from reply text (including
  kaomoji/emoji, not just English mood words), real-time lip sync, natural
  randomized blinking, a fixed-width zoom control (whole body / waist-up /
  bust-up), and an idle-tilt correction for models whose idle motion pitches
  back sharply. Every tuning knob (mouth gain, eye-open scale, blink/smile/
  brow parameter ids, idle tilt angles, state→motion/expression mapping) is
  configurable per-model via `mana-avatar.json`, so swapping the model
  folder is a drop-in operation — see `docs/live2d_avatar_setup.md`.
- **Silence-based voice endpointing**: Mana waits for an actual pause
  (~2.2s, tunable) before treating speech as a finished prompt, instead of
  cutting a long sentence off at a fixed duration.
- **Multilingual TTS**: automatic language detection with per-language
  Kokoro voice profiles (English, Chinese, Japanese, Korean), instead of
  always speaking in English regardless of reply language.
- **Speech text normalization**: emoji/kaomoji become short spoken words
  ("smile", "sniff") instead of long Unicode names being read aloud,
  vowel-less interjections get pronounceable spellings, and a trailing "~"
  stretches the last vowel instead of being narrated as "tilde".
- **GPT-SoVITS** wired as an opt-in trial voice-cloning provider alongside
  Kokoro/Chatterbox/Fish Speech.
- **Self-hosted web access**: search, wiki lookups, and reading a page Mana
  is pointed at, backed by a local, single-user SearXNG instance rather than
  a public instance or third-party search API.
- **Persistent llama-server runtime** with CLI fallback, replacing
  spawn-per-request `llama-cli` calls; background memory-indexing jobs now
  run hourly, skip via content hash when nothing changed, and pause while a
  watched game has focus.
- **Local vision support**: screen/image description via a local
  Qwen2.5-VL model (`POST /vision/describe`, `image` field on `POST /reply`).

### Changed
- **Relicensed from PolyForm Noncommercial 1.0.0 to Apache License 2.0**
  for the code, so GitHub's license picker/badge recognizes it. This
  permits commercial use of the code by others, a deliberate tradeoff for
  recognizability. Artwork (`sprites/`, `windows-launcher/avatar/model/`)
  is unaffected — still fully proprietary/all-rights-reserved under
  `LICENSE-ARTWORK`, independent of the code license either way.

### Fixed
- Closed two real gitignore gaps: personal voice-audition/reference audio
  was only untracked by luck (nothing actually ignored it), and Python
  `__pycache__` bytecode had been committed.

## [0.1.0] - 2026 (baseline)

Initial local-first voice assistant: wake-word listening, local speech
transcription (whisper.cpp), local reply generation (llama.cpp + GGUF
models), local TTS playback (Kokoro/Chatterbox), and the Windows Electron
launcher.
