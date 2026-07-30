// Shared pairing-code approval flow for DM-only remote-messaging plugins
// (issue #265): telegram-bridge.js and discord-bot.js each had a
// near-identical copy of this exact logic (pending/approved JSON stores,
// generatePairingCode, isApproved/listPending/listApproved/approvePairing,
// and handleIncomingMessage's pairing gate) -- the only real differences
// were the id field name (chatId vs channelId), the message-length cap,
// and the session-id prefix. Extracted here rather than a broader
// "ChannelPlugin" abstraction over the messaging mechanism itself --
// polling (Telegram) vs. a Gateway websocket (Discord) genuinely differ
// and forcing them into one shape would be speculative generality, not a
// real simplification. This covers exactly the part that was duplicated.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
  // Short, easy to type back from a phone -- 6 uppercase hex characters
  // (16^6 ≈ 16.7M combinations) is plenty of entropy for a short-lived
  // local pairing code (not a long-term secret).
  return crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

// options.dataDir: required, injectable so tests don't write into a real
// data directory (same pattern as acp-memory-store.js/cron-scheduler.js).
// options.idField: required -- the property name used in listPending()/
// listApproved()'s returned entries and in the "X is required" error,
// matching each channel's own existing terminology ("chatId", "channelId").
// options.maxTextChars: required -- the channel's own message-length cap.
// options.sessionPrefix: required -- becomes `${sessionPrefix}-${id}` for
// the reply pipeline's sessionId.
// options.replyFn: (text, {sessionId}) => Promise<string>, same injection
// pattern each existing bridge already used.
function createChannelPairingBridge(options = {}) {
  const dataDir = options.dataDir;
  const idField = options.idField;
  const maxTextChars = options.maxTextChars;
  const sessionPrefix = options.sessionPrefix;
  const replyFn = options.replyFn || null;
  if (!dataDir) throw new Error("dataDir is required");
  if (!idField) throw new Error("idField is required");
  if (!maxTextChars) throw new Error("maxTextChars is required");
  if (!sessionPrefix) throw new Error("sessionPrefix is required");

  const pendingPath = path.join(dataDir, "pending.json");
  const approvedPath = path.join(dataDir, "approved.json");

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

  function isApproved(id) {
    return Boolean(loadApproved()[String(id)]);
  }

  function listPending() {
    return Object.entries(loadPending()).map(([id, entry]) => ({ [idField]: id, ...entry }));
  }

  function listApproved() {
    return Object.entries(loadApproved()).map(([id, entry]) => ({ [idField]: id, ...entry }));
  }

  // Approves whichever id most recently requested `code`. Returns the
  // approved id, or null if the code doesn't match any pending entry.
  function approvePairing(code) {
    const pending = loadPending();
    const match = Object.entries(pending).find(([, entry]) => entry.code === code);
    if (!match) return null;

    const [id, entry] = match;
    const approved = loadApproved();
    approved[id] = { approvedAt: new Date().toISOString(), name: entry.name || null };
    saveApproved(approved);

    delete pending[id];
    savePending(pending);
    return id;
  }

  // The entry point for one incoming DM. An unapproved id gets back a
  // one-time pairing code instead of a real reply; an approved id's
  // message is routed through the normal reply pipeline. DM-only by
  // design -- there's no group-chat handling here at all, matching the
  // pairing model's one-user-per-approved-id assumption.
  async function handleIncomingMessage({ id, text, senderName }) {
    const cleanText = String(text || "").trim().slice(0, maxTextChars);
    if (!id) throw new Error(`${idField} is required`);

    if (!isApproved(id)) {
      const pending = loadPending();
      const existing = pending[String(id)];
      const code = existing?.code || generatePairingCode();
      pending[String(id)] = {
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
    return replyFn(cleanText, { sessionId: `${sessionPrefix}-${id}` });
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

module.exports = { createChannelPairingBridge };
