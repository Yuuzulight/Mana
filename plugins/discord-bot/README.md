# discord-bot

Message Mana remotely from a phone over Discord DMs, without exposing any
port to the internet. Added alongside `telegram-bridge` (issue #151) as a
second remote-messaging option (issue #185), not a replacement -- disabled
by default (Settings > Plugins).

## Pairing, not an allowlist config

A Discord channel can message *any* bot it can DM, so the plugin can't
trust a channel ID just because a message arrived from it -- same reasoning
as `telegram-bridge`. The first DM from an unrecognized channel gets back a
one-time 6-character pairing code instead of a real reply; whoever owns
Mana approves it with `POST /discord/approve { code }`. Only approved
channels get routed through the real reply pipeline. DM-only -- guild
channels are ignored outright, since the pairing model assumes one approved
channel per user.

## Gateway websocket, not polling

Discord has no simple long-poll REST equivalent to Telegram's `getUpdates`
-- the Gateway websocket (`discord.js`'s `Client` + a `messageCreate`
listener) is the standard, correct way to receive messages, so this plugin
listens for real-time events instead. Set `MANA_DISCORD_BOT_TOKEN` to
enable it. The bot needs the **Message Content** privileged intent enabled
in the Discord Developer Portal (Bot > Privileged Gateway Intents) -- without
it, `message.content` arrives empty for every DM.

## Routes

- `GET /discord/pending` -- channels that have messaged but aren't approved yet.
- `GET /discord/approved` -- currently approved channels.
- `POST /discord/approve` -- `{ code }`, approves whichever pending channel
  most recently generated that code.

## Verification note

No real Discord bot token was available in the environment that built
this, so the real `discord.js` `Client`'s Gateway connection was never
exercised against the live Discord API. `discord-bot.js`'s actual logic
(pairing-code generation/reuse, approval, DM-only filtering, bot-message
filtering, message routing) is verified directly in tests via a fake
`replyFn` and a fake `message` object with the same shape a real
`discord.js` `Message` has (`author.bot`, `channel.type`, `channel.id`,
`channel.send`, `content`).
