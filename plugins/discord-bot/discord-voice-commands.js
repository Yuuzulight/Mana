// Issue #187: "!join <voiceChannelId>" / "!leave" -- the only trigger for
// voice, since the issue's own scope explicitly rules out Discord-specific
// UI (slash commands, buttons, embeds), plain text only. A channel ID
// (Developer Mode > right-click a voice channel > Copy Channel ID) is
// enough to resolve it directly via client.channels.fetch() -- no guild ID
// needed, channel IDs are globally unique in Discord's ID space.
const { createDiscordVoiceSession } = require("./discord-voice-session");

function parseVoiceCommand(text) {
  const trimmed = String(text || "").trim();
  const joinMatch = trimmed.match(/^!join\s+(\d{5,25})\s*$/i);
  if (joinMatch) return { command: "join", channelId: joinMatch[1] };
  if (/^!leave\s*$/i.test(trimmed)) return { command: "leave" };
  return null;
}

// options.client: the real discord.js Client (for channels.fetch).
// options.voice: {joinVoiceChannel, entersState, VoiceConnectionStatus,
// createAudioPlayer, createAudioResource, AudioPlayerStatus,
// EndBehaviorType} -- injectable @discordjs/voice surface.
// options.opus: prism-media's opus module.
// options.whisperQueue/replyFn/synthesizeReply: forwarded to
// createDiscordVoiceSession per join.
// options.sessions: injectable Map (DM channelId -> {session,
// voiceChannelId}) so tests can inspect/seed active sessions directly.
function createVoiceCommandHandler(options = {}) {
  const {
    client,
    voice,
    opus,
    whisperQueue,
    replyFn,
    synthesizeReply,
    sessions = new Map(),
    createSession = createDiscordVoiceSession,
  } = options;

  if (!client) throw new Error("client is required");
  if (!voice) throw new Error("voice is required");

  function leaveOne(dmChannelId) {
    const existing = sessions.get(dmChannelId);
    if (!existing) return false;
    existing.session.destroy();
    sessions.delete(dmChannelId);
    return true;
  }

  async function handleJoin(message, targetChannelId) {
    leaveOne(message.channel.id);

    const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (!targetChannel || typeof targetChannel.isVoiceBased !== "function" || !targetChannel.isVoiceBased()) {
      await message.channel.send("That doesn't look like a voice channel I can join.");
      return;
    }

    const connection = voice.joinVoiceChannel({
      channelId: targetChannel.id,
      guildId: targetChannel.guild.id,
      adapterCreator: targetChannel.guild.voiceAdapterCreator,
    });
    try {
      await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 15000);
    } catch (e) {
      connection.destroy();
      await message.channel.send(`Couldn't join that channel: ${e.message}`);
      return;
    }

    const session = createSession({
      connection,
      opus,
      whisperQueue,
      replyFn,
      synthesizeReply,
      voice,
      channelId: targetChannel.id,
    });
    sessions.set(message.channel.id, { session, voiceChannelId: targetChannel.id });
    await message.channel.send(`Joined <#${targetChannel.id}>.`);
  }

  async function tryHandle(message) {
    const parsed = parseVoiceCommand(message.content);
    if (!parsed) return false;

    if (parsed.command === "leave") {
      const left = leaveOne(message.channel.id);
      await message.channel.send(left ? "Left the voice channel." : "I'm not in a voice channel right now.");
      return true;
    }

    await handleJoin(message, parsed.channelId);
    return true;
  }

  return { tryHandle, sessions };
}

module.exports = { parseVoiceCommand, createVoiceCommandHandler };
