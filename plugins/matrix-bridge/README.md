# matrix-bridge

Message Mana remotely over a self-hosted Matrix homeserver (Synapse,
Dendrite, etc.), gated by a pairing-code approval. Disabled by default
(Settings > Plugins). Added alongside `telegram-bridge` and `discord-bot`,
not a replacement for either -- see issue #435.

## Scope boundary: no E2EE

This bridge only works in **unencrypted** rooms. Matrix end-to-end
encryption (Olm/Megolm) is a genuinely complex cryptographic
session-management protocol -- device keys, one-time keys, per-device Olm
sessions, Megolm group sessions -- and building/verifying it needs a live
encrypted room and multiple test client sessions to exercise the crypto
against, which this pass didn't have. `telegram-bridge`/`discord-bot` don't
implement any bridge-specific encryption either (transport TLS only); this
bridge matches that precedent. An `m.room.encrypted` event is skipped
outright, not decrypted -- if you invite Mana into an encrypted room, her
replies will simply never arrive.

## Pairing, not an allowlist config

Any Matrix room the bot is invited to can be joined, so the plugin can't
trust a room ID just because a message arrived from it. The first message
from an unrecognized room gets back a one-time 6-character pairing code
instead of a real reply; whoever owns Mana approves it with
`POST /matrix/approve { code }`. Only approved rooms get routed through the
real reply pipeline. A Matrix "DM" is just a 1:1 room -- like the other two
bridges, the pairing gate itself is what controls who Mana actually replies
to, so any room (1:1 or group) the bot joins goes through the same flow.

## Auto-join, and long-polling `/sync` instead of a webhook

Bots must explicitly join a Matrix room after being invited -- there's no
implicit DM-open state like Telegram/Discord have. This bridge auto-joins
on any `m.room.member` invite event it sees.

Mana runs locally with no public HTTPS endpoint for a homeserver to call
back into, so this polls the Client-Server API's `/sync` endpoint (a
genuine long-poll, `timeout=30000`) instead of registering a webhook --
nothing needs to be exposed to the internet. Set `MANA_MATRIX_HOMESERVER_URL`,
`MANA_MATRIX_ACCESS_TOKEN`, and `MANA_MATRIX_USER_ID` to enable it;
`MANA_MATRIX_POLL_INTERVAL_MS` (default 1000) is the pause between one
`/sync` finishing and the next starting.

## Auth: a pre-generated access token, not username/password login

`MANA_MATRIX_ACCESS_TOKEN` is an already-issued access token for the bot's
own Matrix user account -- the common pattern for a self-hosted bot user,
and it matches `telegram-bridge`'s own bot-token-only config. There's no
interactive `/login` flow here.

## Routes

- `GET /matrix/pending` -- rooms that have messaged but aren't approved yet.
- `GET /matrix/approved` -- currently approved rooms.
- `POST /matrix/approve` -- `{ code }`, approves whichever pending room most
  recently generated that code.

## Verification note

No real Matrix homeserver was available in the environment that built
this, so `createMatrixClient`'s `sync`/`joinRoom`/`sendMessage` HTTP calls
were never exercised against a live homeserver. `matrix-bridge.js`'s actual
logic (pairing-code generation/reuse, approval, auto-join, own-message
filtering, encrypted-event skipping, message routing) is verified directly
in tests via a fake `replyFn` and a fake `client` object with the same
`{sync, joinRoom, sendMessage}` shape `createMatrixClient` returns, plus
tests of `createMatrixClient` itself against a mocked `fetch`.
