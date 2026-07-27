// Remote messaging over Telegram, gated by pairing-code approval so a
// stray DM from a stranger can't reach Mana. Long-polling (Telegram's
// getUpdates), not a webhook -- Mana runs locally with no public HTTPS
// endpoint to receive a webhook callback on, and polling needs nothing
// exposed to the internet at all.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "..", "node-bot", "data", "telegram-bridge");
const MAX_TEXT_CHARS = 4000; // Telegram's own message-length ceiling is ~4096

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function generatePairingCode() {
  // Short, easy to type back from a phone -- 6 uppercase alphanumeric
  // characters is plenty of entropy for a short-lived local pairing
  // code (not a long-term secret).
  return crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

// options.dataDir: injectable so tests don't write into node-bot's real
// data directory (same pattern as acp-memory-store.js/cron-scheduler.js).
// options.replyFn: (text, {sessionId}) => Promise<string> -- routes an
// approved chat's message through the same reply pipeline every other
// surface already shares; kept as a single injected function so this
// module has no direct knowledge of buildAssistantReply.
function createTelegramBridge(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const pendingPath = path.join(dataDir, "pending.json");
  const approvedPath = path.join(dataDir, "approved.json");
  const replyFn = options.replyFn || null;

  function loadPending() {
    ensureDir(dataDir);
    return readJson(pendingPath, {});
  }
  function savePending(pending) {
    ensureDir(dataDir);
    writeJson(pendingPath, pending);
  }
  function loadApproved() {
    ensureDir(dataDir);
    return readJson(approvedPath, {});
  }
  function saveApproved(approved) {
    ensureDir(dataDir);
    writeJson(approvedPath, approved);
  }

  function isApproved(chatId) {
    return Boolean(loadApproved()[String(chatId)]);
  }

  function listPending() {
    return Object.entries(loadPending()).map(([chatId, entry]) => ({ chatId, ...entry }));
  }

  function listApproved() {
    return Object.entries(loadApproved()).map(([chatId, entry]) => ({ chatId, ...entry }));
  }

  // Approves whichever chatId most recently requested `code`. Returns the
  // approved chatId, or null if the code doesn't match any pending entry.
  function approvePairing(code) {
    const pending = loadPending();
    const match = Object.entries(pending).find(([, entry]) => entry.code === code);
    if (!match) return null;

    const [chatId, entry] = match;
    const approved = loadApproved();
    approved[chatId] = { approvedAt: new Date().toISOString(), name: entry.name || null };
    saveApproved(approved);

    delete pending[chatId];
    savePending(pending);
    return chatId;
  }

  // The entry point for one incoming DM. An unapproved chat gets back a
  // one-time pairing code instead of a real reply; an approved chat's
  // message is routed through the normal reply pipeline. DM-only by
  // design -- there's no group-chat handling here at all, matching the
  // pairing model's one-user-per-approved-chat assumption.
  async function handleIncomingMessage({ chatId, text, senderName }) {
    const cleanText = String(text || "").trim().slice(0, MAX_TEXT_CHARS);
    if (!chatId) throw new Error("chatId is required");

    if (!isApproved(chatId)) {
      const pending = loadPending();
      const existing = pending[String(chatId)];
      const code = existing?.code || generatePairingCode();
      pending[String(chatId)] = {
        code,
        name: senderName || existing?.name || null,
        firstSeenAt: existing?.firstSeenAt || new Date().toISOString(),
      };
      savePending(pending);
      return `This chat isn't paired with Mana yet. Give this code to whoever owns Mana to approve it: ${code}`;
    }

    if (!cleanText) return null;
    if (typeof replyFn !== "function") {
      throw new Error("no reply function configured");
    }
    return replyFn(cleanText, { sessionId: `telegram-${chatId}` });
  }

  return {
    dataDir,
    isApproved,
    listPending,
    listApproved,
    approvePairing,
    handleIncomingMessage,
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
