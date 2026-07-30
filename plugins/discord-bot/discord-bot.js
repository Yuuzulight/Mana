// Remote messaging over Discord, gated by pairing-code approval so a stray
// DM from a stranger can't reach Mana -- same shape as
// plugins/telegram-bridge/telegram-bridge.js (issue #151), added alongside
// it rather than replacing it (explicit user decision, issue #185).
// Discord has no simple long-poll REST equivalent to Telegram's
// getUpdates -- the Gateway websocket (discord.js's Client + a
// messageCreate listener) is the standard, correct way to receive
// messages, so this plugin listens for real-time events instead of
// polling.
const path = require("path");
const { createChannelPairingBridge } = require("../shared/channel-pairing-bridge");

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "..", "node-bot", "data", "discord-bot");
const MAX_TEXT_CHARS = 2000; // Discord's own default message-length ceiling

// options.dataDir/replyFn: same injection pattern as createTelegramBridge.
//
// The actual pairing-store logic (issue #265) lives in the shared
// channel-pairing-bridge.js -- see telegram-bridge.js's createTelegramBridge
// for the fuller rationale. This wrapper keeps the existing channelId-shaped
// API (handleIncomingMessage({channelId, ...})).
function createDiscordBridge(options = {}) {
  const shared = createChannelPairingBridge({
    dataDir: options.dataDir || DEFAULT_DATA_DIR,
    idField: "channelId",
    maxTextChars: MAX_TEXT_CHARS,
    sessionPrefix: "discord",
    replyFn: options.replyFn,
  });

  return {
    dataDir: shared.dataDir,
    isApproved: shared.isApproved,
    listPending: shared.listPending,
    listApproved: shared.listApproved,
    approvePairing: shared.approvePairing,
    handleIncomingMessage: ({ channelId, text, senderName }) =>
      shared.handleIncomingMessage({ id: channelId, text, senderName }),
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
