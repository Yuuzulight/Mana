# telegram-bridge

Message Mana remotely from a phone over Telegram, without exposing any port
or webhook to the internet. Disabled by default (Settings > Plugins).

## Pairing, not an allowlist config

A Telegram chat can message *any* bot's username it finds, so the plugin
can't trust a chat ID just because a message arrived from it. The first DM
from an unrecognized chat gets back a one-time 6-character pairing code
instead of a real reply; whoever owns Mana approves it with
`POST /telegram/approve { code }`. Only approved chats get routed through
the real reply pipeline. DM-only -- group chats are ignored outright, since
the pairing model assumes one approved chat per user.

## Long-polling, not a webhook

Mana runs locally with no public HTTPS endpoint for Telegram to call back
into, so this uses `getUpdates` long-polling instead -- nothing needs to be
exposed to the internet at all. Set `MANA_TELEGRAM_BOT_TOKEN` to enable it;
`MANA_TELEGRAM_POLL_INTERVAL_MS` (default 3000) controls the poll interval.

## Routes

- `GET /telegram/pending` -- chats that have messaged but aren't approved yet.
- `GET /telegram/approved` -- currently approved chats.
- `POST /telegram/approve` -- `{ code }`, approves whichever pending chat
  most recently generated that code.

## Verification note

No real Telegram bot token was available in the environment that built
this, so `createTelegramClient`'s `getUpdates`/`sendMessage` HTTP calls were
never exercised against the live Telegram API. `telegram-bridge.js`'s actual
logic (pairing-code generation/reuse, approval, DM-only filtering, message
routing) is verified directly in tests via a fake `replyFn` and a fake
`client` object with the same `{getUpdates, sendMessage}` shape
`createTelegramClient` returns.
