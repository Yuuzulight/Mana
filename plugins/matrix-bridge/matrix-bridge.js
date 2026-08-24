// Remote messaging over Matrix, gated by pairing-code approval so a stray
// message from a stranger can't reach Mana -- same shape as
// plugins/telegram-bridge/telegram-bridge.js (issue #151), added alongside
// it and discord-bot.js rather than replacing either (issue #435). Matrix's
// Client-Server API is plain REST with a long-poll `/sync` endpoint,
// structurally the same polling shape as Telegram's getUpdates -- not
// Discord's websocket Gateway -- so this follows telegram-bridge.js's
// plain-fetch client instead of adding a matrix-js-sdk/matrix-bot-sdk
// dependency for what a few fetch calls already do.
//
// Auth is a pre-generated access token only (MANA_MATRIX_ACCESS_TOKEN), not
// a username/password login flow -- the common pattern for a self-hosted
// bot user, and it matches Telegram's own botToken-only config.
//
// SCOPE BOUNDARY -- no E2EE: this bridge only handles unencrypted rooms.
// Matrix end-to-end encryption (Olm/Megolm) is a genuinely complex
// cryptographic session-management protocol -- device keys, one-time keys,
// per-device Olm sessions, Megolm group sessions -- that can't be
// reasonably built or verified without a live encrypted room and multiple
// test client sessions to exercise the crypto against. Discord/Telegram's
// own bridges here don't implement any bridge-specific encryption either
// (transport TLS only); this bridge matches that precedent and relies on
// Matrix's transport TLS. An encrypted room's messages arrive as opaque
// `m.room.encrypted` events -- syncOnce() below skips them outright rather
// than trying to decrypt (or crash on) them.
const path = require("path");
const crypto = require("crypto");
const { createChannelPairingBridge } = require("../shared/channel-pairing-bridge");

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "..", "node-bot", "data", "matrix-bridge");
// Matrix's own PDU size ceiling is 65536 bytes for the whole event JSON
// (sender/room_id/signatures/etc included, not just the message body) --
// 60000 leaves headroom for that envelope.
const MAX_TEXT_CHARS = 60000;
const SYNC_TIMEOUT_MS = 30000;

// options.dataDir: injectable so tests don't write into node-bot's real
// data directory (same pattern as telegram-bridge.js/discord-bot.js).
// options.replyFn: (text, {sessionId}) => Promise<string>, same injection
// pattern the other two bridges use.
//
// The actual pairing-store logic (issue #265) lives in the shared
// channel-pairing-bridge.js -- see telegram-bridge.js's createTelegramBridge
// for the fuller rationale. This wrapper keeps a roomId-shaped API
// (handleIncomingMessage({roomId, ...})) matching Matrix's own terminology
// (a Matrix "DM" is just a 1:1 room; any room the bot joins, DM or group,
// goes through the same pairing gate -- same looseness the other two
// bridges already treat "any chat that DMs the bot" with).
function createMatrixBridge(options = {}) {
  const shared = createChannelPairingBridge({
    dataDir: options.dataDir || DEFAULT_DATA_DIR,
    idField: "roomId",
    maxTextChars: MAX_TEXT_CHARS,
    sessionPrefix: "matrix",
    replyFn: options.replyFn,
  });

  return {
    dataDir: shared.dataDir,
    isApproved: shared.isApproved,
    listPending: shared.listPending,
    listApproved: shared.listApproved,
    approvePairing: shared.approvePairing,
    handleIncomingMessage: ({ roomId, text, senderName }) =>
      shared.handleIncomingMessage({ id: roomId, text, senderName }),
  };
}

// Real Matrix client: plain fetch against a self-hosted homeserver's
// Client-Server API. Not exercised against a live homeserver in this
// codebase -- verified via mocked HTTP calls in tests instead (no
// homeserver was available to test against this session).
//
// Room IDs come back from `/sync` (server-controlled, but Matrix rooms can
// be federated from other servers, so treat them as external input) --
// encodeURIComponent() on every path segment built from one guards against
// a malformed/hostile room ID smuggling extra path segments into a request.
function createMatrixClient({ homeserverUrl, accessToken, fetchImpl = fetch } = {}) {
  if (!homeserverUrl) {
    throw new Error("a homeserver URL is required");
  }
  if (!accessToken) {
    throw new Error("an access token is required");
  }
  // Not a regex trim (CodeQL flagged /\/+$/ as a polynomial-time regex on
  // uncontrolled input) -- a plain loop is linear-time regardless of how
  // many trailing slashes a misconfigured homeserver URL has.
  let base = homeserverUrl;
  while (base.endsWith("/")) base = base.slice(0, -1);

  async function authedFetch(urlPath, options = {}) {
    return fetchImpl(`${base}${urlPath}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.headers || {}),
      },
    });
  }

  async function sync(since) {
    const params = new URLSearchParams({ timeout: String(SYNC_TIMEOUT_MS) });
    if (since) params.set("since", since);
    const response = await authedFetch(`/_matrix/client/v3/sync?${params.toString()}`);
    if (!response.ok) {
      // Never include the access token in an error message -- it's not in
      // the URL or these fields, but keep the message minimal on purpose.
      throw new Error(`sync failed: ${response.status}`);
    }
    return response.json();
  }

  async function joinRoom(roomId) {
    const response = await authedFetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      throw new Error(`join failed: ${response.status}`);
    }
  }

  async function sendMessage(roomId, text) {
    // Matrix requires a client-generated transaction id per send (unlike
    // Telegram) -- a random UUID per call so a retried send never reuses a
    // txnId and gets silently deduped by the homeserver.
    const txnId = crypto.randomUUID();
    const response = await authedFetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "m.text", body: text }),
      },
    );
    if (!response.ok) {
      throw new Error(`send failed: ${response.status}`);
    }
  }

  return { sync, joinRoom, sendMessage };
}

// Fetches one `/sync` batch, auto-joins any pending invites, and replies to
// each new message -- the unit the sync loop (index.js) calls repeatedly.
// botUserId filters out the bot's own messages: Matrix rooms echo back
// everything sent into them (including the bot's own replies), unlike
// Telegram/Discord where a bot doesn't receive its own messages back.
async function syncOnce({ client, bridge, botUserId, since }) {
  const data = await client.sync(since);
  const rooms = data.rooms || {};

  const invites = rooms.invite || {};
  for (const roomId of Object.keys(invites)) {
    try {
      await client.joinRoom(roomId);
    } catch (e) {
      console.warn(`matrix-bridge: failed to auto-join ${roomId}:`, e && e.message ? e.message : e);
    }
  }

  const joinedRooms = rooms.join || {};
  for (const [roomId, room] of Object.entries(joinedRooms)) {
    const events = room?.timeline?.events || [];
    for (const event of events) {
      if (!event || event.sender === botUserId) continue;
      // Out of scope by design -- see the file header's E2EE note. Skip
      // rather than try to read ciphertext as if it were plaintext.
      if (event.type === "m.room.encrypted") continue;
      if (event.type !== "m.room.message") continue;
      if (event.content?.msgtype !== "m.text") continue;

      const reply = await bridge.handleIncomingMessage({
        roomId,
        text: event.content.body,
        senderName: event.sender || null,
      });
      if (reply) {
        await client.sendMessage(roomId, reply);
      }
    }
  }

  // Matrix always returns a next_batch token, even on an empty sync --
  // falling back to the previous `since` only guards a malformed response.
  return data.next_batch || since;
}

module.exports = {
  MAX_TEXT_CHARS,
  SYNC_TIMEOUT_MS,
  createMatrixBridge,
  createMatrixClient,
  syncOnce,
};
