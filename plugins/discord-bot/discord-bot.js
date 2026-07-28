// Remote messaging over Discord, gated by pairing-code approval so a stray
// DM from a stranger can't reach Mana -- same shape as
// plugins/telegram-bridge/telegram-bridge.js (issue #151), added alongside
// it rather than replacing it (explicit user decision, issue #185).
// Discord has no simple long-poll REST equivalent to Telegram's
// getUpdates -- the Gateway websocket (discord.js's Client + a
// messageCreate listener) is the standard, correct way to receive
// messages, so this plugin listens for real-time events instead of
// polling.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "..", "node-bot", "data", "discord-bot");
const MAX_TEXT_CHARS = 2000; // Discord's own default message-length ceiling

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
  return crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

// options.dataDir/replyFn: same injection pattern as createTelegramBridge.
function createDiscordBridge(options = {}) {
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

  function isApproved(channelId) {
    return Boolean(loadApproved()[String(channelId)]);
  }

  function listPending() {
    return Object.entries(loadPending()).map(([channelId, entry]) => ({ channelId, ...entry }));
  }

  function listApproved() {
    return Object.entries(loadApproved()).map(([channelId, entry]) => ({ channelId, ...entry }));
  }

  function approvePairing(code) {
    const pending = loadPending();
    const match = Object.entries(pending).find(([, entry]) => entry.code === code);
    if (!match) return null;

    const [channelId, entry] = match;
    const approved = loadApproved();
    approved[channelId] = { approvedAt: new Date().toISOString(), name: entry.name || null };
    saveApproved(approved);

    delete pending[channelId];
    savePending(pending);
    return channelId;
  }

  // DM-only by design, same as Telegram's pairing model.
  async function handleIncomingMessage({ channelId, text, senderName }) {
    const cleanText = String(text || "").trim().slice(0, MAX_TEXT_CHARS);
    if (!channelId) throw new Error("channelId is required");

    if (!isApproved(channelId)) {
      const pending = loadPending();
      const existing = pending[String(channelId)];
      const code = existing?.code || generatePairingCode();
      pending[String(channelId)] = {
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
    return replyFn(cleanText, { sessionId: `discord-${channelId}` });
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

// Handles one real (or fake) discord.js Message object -- the unit
// index.js's messageCreate listener calls for every event. Ignores bot
// messages (including Mana's own replies) and non-DM channels, matching
// the pairing model's DM-only, single-user-per-channel assumption.
// DISCORD_DM_CHANNEL_TYPE (1) matches discord.js's ChannelType.DM without
// requiring discord.js itself here, so this stays testable with a plain
// fake message object.
const DISCORD_DM_CHANNEL_TYPE = 1;

// Issue #187: "!join <voiceChannelId>" / "!leave" are the only two special
// commands, intercepted before the normal text-reply pipeline -- and only
// for already-approved channels, since joining a voice channel is an
// action within an already-trusted DM relationship, not a new trust
// decision (the existing pairing *is* the trust boundary here, same as it
// already is for text). voiceCommands is optional and kept out of this
// file's own dependency surface (no @discordjs/voice import here) so this
// stays testable with a plain fake message object, same as the rest of
// this module -- index.js wires the real handler.
async function handleDiscordMessage({ message, bridge, voiceCommands }) {
  if (!message || message.author?.bot) return;
  if (message.channel?.type !== DISCORD_DM_CHANNEL_TYPE) return;

  if (voiceCommands && bridge.isApproved(message.channel.id)) {
    const handled = await voiceCommands.tryHandle(message);
    if (handled) return;
  }

  const reply = await bridge.handleIncomingMessage({
    channelId: message.channel.id,
    text: message.content,
    senderName: message.author?.username || null,
  });
  if (reply) {
    await message.channel.send(reply);
  }
}

module.exports = {
  MAX_TEXT_CHARS,
  DISCORD_DM_CHANNEL_TYPE,
  createDiscordBridge,
  handleDiscordMessage,
};
