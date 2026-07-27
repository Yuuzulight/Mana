# Issue 151: Telegram Remote Messaging Bridge

## Goal

Message Mana remotely from a phone, without exposing any port or webhook to
the internet, and without letting a stray Telegram DM from a stranger reach
her.

## Pairing-code approval, not a static allowlist

A Telegram chat ID isn't a secret -- anyone can DM a bot's public username
and get a chat ID assigned. So the bridge can't trust "this chat ID is in a
config file" as authorization by itself; it needs a live approval step tied
to something only Mana's owner can complete. The first message from an
unrecognized chat gets back a one-time 6-character pairing code instead of
a real reply; `POST /telegram/approve { code }` (called from wherever the
owner already trusts, e.g. a local Settings page) approves whichever
pending chat generated that code. Only approved chats route through the
real reply pipeline.

## Long-polling, not a webhook

Mana runs locally with no public HTTPS endpoint, so a Telegram webhook
(which requires Telegram to reach *out* to a URL you host) isn't viable
without extra infrastructure (a tunnel, a reverse proxy). Long-polling
(`getUpdates`) needs nothing exposed to the internet -- Mana's poll loop
reaches out to Telegram, not the other way around.

## Status: Implemented (`plugins/telegram-bridge/`, toggleable, off by default)

- **`telegram-bridge.js`**: `createTelegramBridge({dataDir, replyFn})` --
  same injectable-`dataDir`/injectable-function pattern as
  `acp-memory-store.js`/`cron-scheduler.js`, so tests never touch
  `node-bot`'s real data directory. Pending/approved chats persist as JSON
  files (`pending.json`/`approved.json`) under `dataDir`.
  `handleIncomingMessage({chatId, text, senderName})` is the single entry
  point: generates/reuses a pairing code for an unapproved chat, or routes
  an approved chat's message through the injected `replyFn(text,
  {sessionId: 'telegram-<chatId>'})` -- the same per-session-scoped
  sessionId shape every other surface (voice, chat window) already uses.
- **`createTelegramClient({botToken})`**: thin wrapper over Telegram's Bot
  API (`getUpdates`/`sendMessage`), separated from the bridge logic so the
  bridge itself never touches `fetch` directly and stays fully testable.
- **`pollOnce({client, bridge, lastOffset})`**: fetches one batch of
  updates, filters to private (DM) chats only -- group chats are ignored
  outright, matching the one-owner-per-approved-chat pairing model -- and
  routes each through the bridge, sending the reply back via the client.
- **`index.js`**: module-level singleton (same pattern as
  `cron-scheduler`/`image-generation`/`browser-automation`) wiring a
  `setInterval` poll loop (`MANA_TELEGRAM_POLL_INTERVAL_MS`, default
  3000ms) gated on `MANA_TELEGRAM_BOT_TOKEN` being set, plus routes
  `GET /telegram/pending`, `GET /telegram/approved`, and
  `POST /telegram/approve`.

## Deliberate simplifications

- **DM-only.** No group-chat support -- explicitly out of scope; the
  pairing model assumes one approved chat per owner.
- **Text-only.** No photo/voice/document message handling from Telegram's
  side -- matches every other chat surface's current text-first shape.
- **No approval UI page.** `POST /telegram/approve` exists as a route;
  wiring it into a Settings page is left for whenever a UI pass touches
  Settings > Plugins next, same as how `cron-scheduler`'s job UI hasn't
  been built either.

## Verification note

No real Telegram bot token was available in the environment that built
this, so `createTelegramClient`'s `getUpdates`/`sendMessage` HTTP calls
were never exercised against the live Telegram API (same category of gap
as issue #150's "no real browser launched" and #149's "no local SD
backend"). `telegram-bridge.js`'s actual logic -- pairing-code
generation/reuse, approval, DM-only filtering, message routing through
`replyFn` -- is verified directly in tests via a fake `replyFn` and a fake
`client` object matching `createTelegramClient`'s exact
`{getUpdates, sendMessage}` shape. Worth a manual pairing/approve/reply
round-trip against a real bot token before relying on this.

## Verified

- `plugins/telegram-bridge/test/telegram-bridge.test.js` (7 tests):
  pairing-code issuance and reuse, approval moving a chat from pending to
  approved, unknown-code rejection, approved-chat replies routed through
  `replyFn` with the right `sessionId`, text truncation at `MAX_TEXT_CHARS`,
  chatId requirement, and `pollOnce` filtering out a group chat while
  routing and replying to a private one.
- `plugins/telegram-bridge/test/telegram-bridge-capability.test.js` (5
  tests): empty pending/approved lists, 404 on an unknown approval code, a
  full pending -> approve -> approved flow through the HTTP routes, plugin
  metadata shape, and `getHealth`'s configured/unavailable states.
- `node-bot/test/health-components.test.js` (3 tests): updated snapshot for
  the new `telegramBridge` component key.
