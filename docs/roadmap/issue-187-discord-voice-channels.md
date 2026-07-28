# Issue 187: Discord Voice Channel Support

## Goal

Let Mana join a Discord voice channel, listen per-speaker, transcribe with
Whisper, reply through her existing text pipeline, and speak the reply back
via TTS -- with barge-in, so a new speaker interrupts playback instead of
waiting behind it. Extends `plugins/discord-bot/` (issue #151/#185)
alongside its existing DM pairing flow, not replacing it.

## Status: Implemented (`plugins/discord-bot/discord-voice-*.js`, plugin(off) by default, same `discordBot` plugin as the DM bridge)

## Prior art found: huggingface/speech-to-speech

Before building, the issue was updated with findings from
[huggingface/speech-to-speech](https://github.com/huggingface/speech-to-speech)
and a batch of related posts: shared choices (Silero VAD, Kokoro-class TTS)
confirmed the general shape was sound, and its `interrupt_response` concept
is exactly what this issue's barge-in requirement needed -- see below for how
it was achieved without taking the dependency.

## A wrong assumption in the issue's own text, corrected by reading the real API

The issue as originally scoped assumed Discord voice has "no reusable
server-side endpointing" and that Mana would need her own energy-based or
timeout-based silence detector to know when a user stopped talking. That
turned out to be wrong: `@discordjs/voice`'s `VoiceReceiver.subscribe(userId,
{end: {behavior: EndBehaviorType.AfterSilence, duration}})` already ends a
user's audio stream automatically after a configurable silence gap, driven
by Discord's own Gateway speaking-start/speaking-stop signals. Confirmed by
reading the package's `.d.ts` directly, not by trusting the issue text --
same "verify against the real API, not the ticket" approach this project
used for #183's tool-calling loop. Result: no custom VAD needed at all,
which cut a whole subsystem out of the design.

**Barge-in came free from the same signal.** Discord's speaking-start event
fires the moment a user starts talking, VAD or no VAD. If a reply is
mid-playback (`playing === true`) when a new speaking-start event arrives,
`discord-voice-session.js` calls `player.stop(true)` -- interrupting output
without any new detection logic, mirroring speech-to-speech's
`interrupt_response` idea using a signal Discord already provides.

## Architecture

- **`plugins/discord-bot/pcm-to-wav.js`** -- prepends a 44-byte RIFF/WAVE
  header to raw PCM (Discord's fixed 48kHz/stereo/16-bit format) so
  whisper-cli can read it directly; no intermediate encoding library.
- **`plugins/discord-bot/whisper-queue.js`** -- a new async, FIFO-serialized
  queue around whisper-cli. The existing `/transcribe` route's `runWhisper`
  in `server.js` is genuinely blocking (`spawnSync` + `Atomics.wait`
  polling), which would freeze the whole process if reused for voice.
  Rather than touch that route (still used by its own callers, unchanged),
  this is a separate async spawn wrapped in a one-at-a-time queue --
  serialized, not parallelized, since whisper-cli is a single CPU/GPU-bound
  process regardless of how many users are talking.
- **`plugins/discord-bot/discord-voice-session.js`** -- one session per
  joined voice channel: subscribes to each speaker via
  `receiver.speaking`'s `"start"` event, pipes their Opus stream through
  `prism-media`'s decoder into PCM, converts to WAV, transcribes, replies
  through the injected `replyFn` (the same `buildAssistantReply` wrapping
  DM text already uses, `sessionId: discord-voice-<channelId>`), then
  speaks the reply back via the injected `synthesizeReply` and
  `@discordjs/voice`'s `AudioPlayer`.
- **`plugins/discord-bot/discord-voice-commands.js`** -- `!join <channelId>`
  / `!leave` as plain DM text commands, not slash commands or embeds --
  the issue's own scope explicitly rules out Discord-specific UI. A bare
  channel ID (via Discord's Developer Mode "Copy Channel ID") resolves
  directly through `client.channels.fetch()`; no guild ID needed since
  channel IDs are globally unique.
- **`plugins/discord-bot/discord-bot.js`** -- `handleDiscordMessage` now
  checks `bridge.isApproved(channelId)` before offering the message to
  `voiceCommands.tryHandle()`. Joining voice is an action *within* an
  already-approved DM pairing, not a new trust decision -- the pairing
  itself is the trust boundary, same as it already is for text replies. An
  unapproved channel can't bypass pairing by sending `!join`.
- **`node-bot/server.js`** -- `capabilityContext` now also exposes
  `synthesizeReply` (previously only `buildAssistantReply` was there), so
  voice sessions speak replies through the *full* pipeline (gaming-aware
  TTS provider switching, VTube reactions, captions) instead of a bare
  `ttsRuntime.synthesizeReply` call.

## npm dependency hygiene: an optional peer dependency almost reintroduced a critical CVE chain

`@discordjs/voice` needs an Opus codec. `@discordjs/opus` (a native binding)
pulls in `@discordjs/node-pre-gyp`, which drags in unpatched
**"No fix available"** critical `tar`/`rimraf`/`glob`/`brace-expansion`
CVEs. Switched to `opusscript` (pure JS, no native build) instead -- but
`@discordjs/opus` kept reappearing after being uninstalled, because
`prism-media` (a `@discordjs/voice` dependency) declares it as an
**optional peer dependency**, which npm auto-installs by default regardless
of what the top-level project depends on. Fixed with `node-bot/.npmrc`
(`omit=optional`) plus a full fresh `package-lock.json`/`node_modules`
reinstall (a partial `npm uninstall` left stale, still-vulnerable entries in
the lockfile even after the physical files were gone). `npm audit
--omit=dev` now reports 0 vulnerabilities. Note: neither `ci.yml` nor
`heavy-ci.yml` actually gates on `npm audit` (`npm ci --no-audit`), so this
was proactive hygiene, not an unblocking fix -- consistent with this
project's existing care around Dependabot alerts (#111).

## Deliberate simplifications

- **Text commands, not slash commands.** Matches the issue's own scope.
- **Single active voice session per DM channel.** `!join` while already
  connected destroys the old session before starting a new one -- one
  voice conversation per pairing at a time, not a stack.
- **No custom VAD/endpointing** -- Discord's own `AfterSilence` end
  behavior covers it (see above).
- **No Settings UI toggle for voice specifically** -- it's gated by the
  same `discordBot` plugin enable/disable as the DM bridge; a dedicated
  voice-only toggle can be added later if that granularity turns out to
  matter.

## Out of scope

- Multi-user simultaneous "conversation" mixing (each speaker is
  transcribed independently; overlapping speech from two users produces two
  separate transcribe-reply-speak cycles, not a merged one).
- Music/soundboard playback -- this is a conversational voice channel
  client, not a music bot.

## Verified

- `plugins/discord-bot/test/pcm-to-wav.test.js` (4 tests): header
  correctness, format fields, data-length fields, empty-buffer handling.
- `plugins/discord-bot/test/whisper-queue.test.js` (6 tests): JSON-output
  parsing, non-zero exit rejection, stdout fallback, strict one-at-a-time
  serialization under concurrent calls, queue survives a failed
  transcription, required-option validation.
- `plugins/discord-bot/test/discord-voice-session.test.js` (7 tests):
  speaking-start subscribes with `EndBehaviorType.AfterSilence`, a full
  utterance is transcribed/replied/spoken, an empty transcript produces no
  reply or playback, an empty reply produces no playback, barge-in stops
  in-progress playback on a new speaker, `destroy()` tears down cleanly,
  required-dependency validation -- all against fake `@discordjs/voice`
  primitives (a real `EventEmitter`-based fake `AudioPlayer`, a fake
  receiver/connection), no real Discord connection or audio hardware.
- `plugins/discord-bot/test/discord-voice-commands.test.js` (10 tests):
  command parsing, successful join, non-voice-channel rejection, unfetchable
  channel, `entersState` timeout/rejection cleanup, leave with/without an
  active session, join replacing an existing session, non-command
  passthrough, required-dependency validation.
- `plugins/discord-bot/test/discord-bot.test.js` (+3 tests): voice commands
  only reach `tryHandle` for already-approved channels, never for
  unapproved ones (pairing can't be bypassed via a voice command), and
  normal text reply routing still happens when `tryHandle` returns `false`.
- Full `node-bot` + `plugins/discord-bot` + `plugins/browser-automation`
  suites (one process per file): no regressions.
