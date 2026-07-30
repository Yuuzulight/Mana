// Remote messaging over Telegram, gated by pairing-code approval so a
// stray DM from a stranger can't reach Mana. Long-polling (Telegram's
// getUpdates), not a webhook -- Mana runs locally with no public HTTPS
// endpoint to receive a webhook callback on, and polling needs nothing
// exposed to the internet at all.
const path = require("path");
const { createChannelPairingBridge } = require("../shared/channel-pairing-bridge");

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "..", "node-bot", "data", "telegram-bridge");
const MAX_TEXT_CHARS = 4000; // Telegram's own message-length ceiling is ~4096

// options.dataDir: injectable so tests don't write into node-bot's real
// data directory (same pattern as acp-memory-store.js/cron-scheduler.js).
// options.replyFn: (text, {sessionId}) => Promise<string> -- routes an
// approved chat's message through the same reply pipeline every other
// surface already shares; kept as a single injected function so this
// module has no direct knowledge of buildAssistantReply.
//
// The actual pairing-store logic (issue #265) lives in the shared
// channel-pairing-bridge.js, extracted after this and discord-bot.js's
// createDiscordBridge turned out near-identical apart from the id field
// name/message cap/session prefix. This wrapper exists so callers keep
// their existing chatId-shaped API (handleIncomingMessage({chatId, ...}))
// without needing to know about the shared bridge's generic `id` field.
function createTelegramBridge(options = {}) {
  const shared = createChannelPairingBridge({
    dataDir: options.dataDir || DEFAULT_DATA_DIR,
    idField: "chatId",
    maxTextChars: MAX_TEXT_CHARS,
    sessionPrefix: "telegram",
    replyFn: options.replyFn,
  });

  return {
    dataDir: shared.dataDir,
    isApproved: shared.isApproved,
    listPending: shared.listPending,
    listApproved: shared.listApproved,
    approvePairing: shared.approvePairing,
    handleIncomingMessage: ({ chatId, text, senderName }) =>
      shared.handleIncomingMessage({ id: chatId, text, senderName }),
  };
}

// Real Telegram client: long-polls getUpdates, sends replies via
// sendMessage. Not exercised against the real Telegram API in this
// codebase -- verified via mocked HTTP calls in tests instead (no bot
// token was available to test against a live chat this session).
function createTelegramClient({ botToken, fetchImpl = fetch } = {}) {
  if (!botToken) {
    throw new Error("a bot token is required");
  }
  const base = `https://api.telegram.org/bot${botToken}`;

  async function getUpdates(offset) {
    const response = await fetchImpl(`${base}/getUpdates?timeout=0&offset=${offset || 0}`);
    if (!response.ok) {
      throw new Error(`getUpdates failed: ${response.status}`);
    }
    const data = await response.json();
    return data.result || [];
  }

  async function sendMessage(chatId, text) {
    const response = await fetchImpl(`${base}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) {
      throw new Error(`sendMessage failed: ${response.status}`);
    }
  }

  return { getUpdates, sendMessage };
}

// Fetches one batch of updates and replies to each -- the unit the poll
// loop (index.js) calls repeatedly. Only private (non-group) chats are
// handled at all, matching the pairing model.
async function pollOnce({ client, bridge, lastOffset = 0 }) {
  const updates = await client.getUpdates(lastOffset);
  let nextOffset = lastOffset;

  for (const update of updates) {
    nextOffset = Math.max(nextOffset, update.update_id + 1);
    const message = update.message;
    if (!message || message.chat?.type !== "private") continue;

    const reply = await bridge.handleIncomingMessage({
      chatId: message.chat.id,
      text: message.text,
      senderName: message.from?.username || message.from?.first_name || null,
    });
    if (reply) {
      await client.sendMessage(message.chat.id, reply);
    }
  }

  return nextOffset;
}

module.exports = {
  MAX_TEXT_CHARS,
  createTelegramBridge,
  createTelegramClient,
  pollOnce,
};
