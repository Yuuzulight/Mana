# Issue 185: Discord Bot Remote Messaging Bridge

## Goal

A second remote-messaging channel alongside the existing Telegram bridge
(#151), for anyone who has a Discord bot set up instead of (or in addition
to) a Telegram one. Explicit user decision: added alongside
`telegram-bridge`, not a replacement for it -- that plugin is untouched.

## Pairing-code approval, not a static allowlist

Same reasoning as #151: a Discord channel ID isn't a secret, so the bridge
can't trust "this channel messaged Mana" as authorization by itself. The
first DM from an unrecognized channel gets back a one-time 6-character
pairing code instead of a real reply; `POST /discord/approve { code }`
approves whichever pending channel generated that code. Only approved
channels route through the real reply pipeline.

## Gateway websocket, not polling

Unlike Telegram, Discord has no simple long-poll REST equivalent to
`getUpdates` -- receiving messages means holding open a Gateway websocket
connection. Hand-rolling that protocol (heartbeating, session resume,
opcodes) is exactly the kind of thing that quietly grows bugs, so this uses
`discord.js`'s `Client`, the standard library for it, rather than a raw
socket. Added as a new dependency (`node-bot/package.json`) since nothing
already installed speaks Discord's Gateway protocol.

## Status: Implemented (`plugins/discord-bot/`, toggleable, off by default)

- **`discord-bot.js`**: `createDiscordBridge({dataDir, replyFn})` --
  deliberately near-identical in shape to `telegram-bridge.js`'s
  `createTelegramBridge` (pending/approved JSON files, pairing-code
  generation/reuse, `handleIncomingMessage({channelId, text, senderName})`)
  rather than extracted into a shared cross-plugin module -- this codebase
  already has a precedent for independent-per-surface copies over
  cross-cutting shared modules (`artifact-detector.js`/`markdown-render.js`
  duplicated identically between `windows-launcher` and `desktop-client`,
  per issue #148's own roadmap doc), and plugins are meant to stay
  self-contained. `MAX_TEXT_CHARS` is 2000 (Discord's own default message
  ceiling) rather than Telegram's ~4096; `sessionId` is
  `discord-<channelId>` instead of `telegram-<chatId>`.
- **`handleDiscordMessage({message, bridge})`**: the per-event handler
  `index.js`'s Gateway listener calls. Ignores bot messages (including
  Mana's own replies echoing back) and non-DM channels
  (`DISCORD_DM_CHANNEL_TYPE = 1`, matching `discord.js`'s `ChannelType.DM`
  without requiring `discord.js` itself in this file, keeping it testable
  with a plain fake `message` object).
- **`index.js`**: module-level singleton (same pattern as
  `telegram-bridge`/`cron-scheduler`/`image-generation`) wiring a real
  `discord.js` `Client` with `Guilds`/`DirectMessages`/`MessageContent`
  intents and `Partials.Channel`/`Partials.Message` (needed so DM events
  for not-yet-cached channels still arrive complete), gated on
  `MANA_DISCORD_BOT_TOKEN` being set, plus routes `GET /discord/pending`,
  `GET /discord/approved`, and `POST /discord/approve` -- same shape as
  Telegram's three routes.
- **`server.js`**: registered in the `capabilities` array alongside
  `telegramBridgePlugin`.

## Deliberate simplifications

- **DM-only, text-only.** No guild/group channel support, no Discord-
  specific UI (embeds, buttons, slash commands) -- matches Telegram
  bridge's scope exactly, and the issue's own explicit "out of scope."
- **No shared pairing module with `telegram-bridge`.** See above --
  duplication here follows an existing, deliberate project convention
  rather than introducing a new cross-plugin dependency for two otherwise-
  independent, toggleable plugins.
- **No approval UI page.** Same gap `telegram-bridge` already has; left for
  whenever a UI pass touches Settings > Plugins next.

## Verification note

No real Discord bot token was available in the environment that built
this, so the real `discord.js` `Client`'s Gateway connection was never
exercised against the live Discord API (same category of gap as #151's own
still-pending Telegram verification). `discord-bot.js`'s actual logic --
pairing-code generation/reuse, approval, DM-only filtering, bot-message
filtering, message routing through `replyFn` -- is verified directly in
tests via a fake `replyFn` and a fake `message` object matching a real
`discord.js` `Message`'s exact shape (`author.bot`, `channel.type`,
`channel.id`, `channel.send`, `content`). Worth a manual pairing/approve/
reply round-trip against a real bot token before relying on this.

## Verified

- `plugins/discord-bot/test/discord-bot.test.js` (10 tests): pairing-code
  issuance and reuse, approval moving a channel from pending to approved,
  unknown-code rejection, approved-channel replies routed through
  `replyFn` with the right `sessionId`, text truncation at
  `MAX_TEXT_CHARS`, channelId requirement, and `handleDiscordMessage`
  ignoring bot messages, ignoring non-DM channels, pairing a new DM, and
  routing an approved DM through the real reply pipeline.
- `plugins/discord-bot/test/discord-bot-capability.test.js` (5 tests):
  empty pending/approved lists, 404 on an unknown approval code, a full
  pending -> approve -> approved flow through the HTTP routes, plugin
  metadata shape, and `getHealth`'s configured/unavailable states.
