const { createDiscordBridge, handleDiscordMessage } = require("./discord-bot");
const { createVoiceCommandHandler } = require("./discord-voice-commands");
const { createWhisperQueue } = require("./whisper-queue");

// Module-level singletons, same pattern as telegram-bridge's -- one
// bridge/client/voice-command-handler shared across every route and the
// Gateway connection.
let bridge = null;
let client = null;
let voiceCommands = null;

function getBridge(deps = {}) {
  if (!bridge) {
    bridge = createDiscordBridge({
      dataDir: deps.dataDir,
      replyFn:
        deps.replyFn ||
        (async (text, { sessionId }) => {
          if (typeof deps.buildAssistantReply !== "function") {
            throw new Error("no buildAssistantReply function available");
          }
          return deps.buildAssistantReply(text, "", "", "default", sessionId);
        }),
    });
  }
  return bridge;
}

// Issue #187: lazily built only once a real client exists (voice needs a
// real discord.js Client to resolve channels by ID). Whisper binary/model
// resolution reuses node-bot's own whisper-discovery.js -- same source of
// truth server.js's /transcribe route already uses, so "is Whisper
// configured" never silently disagrees between the two.
function getVoiceCommands(deps, realClient) {
  if (voiceCommands) return voiceCommands;

  const env = deps.env || process.env;
  const whisperDiscovery = deps.whisperDiscovery || require("../../node-bot/whisper-discovery");
  const whisperBin = whisperDiscovery.findWhisperBin({ env });
  const whisperModel = whisperDiscovery.findWhisperModel({ env });
  if (!whisperBin || !whisperModel) {
    console.warn("discord-bot: Whisper not configured -- voice commands (!join/!leave) will fail until it is.");
  }

  const voice = deps.voiceModule || require("@discordjs/voice");
  const opus = deps.opusModule || require("prism-media").opus;
  const whisperQueue =
    deps.whisperQueue || (whisperBin && whisperModel ? createWhisperQueue({ whisperBin, whisperModel }) : null);

  voiceCommands = createVoiceCommandHandler({
    client: realClient,
    voice,
    opus,
    whisperQueue: whisperQueue || {
      transcribe: async () => {
        throw new Error("Whisper is not configured -- set WHISPER_BIN/WHISPER_MODEL");
      },
    },
    replyFn:
      deps.replyFn ||
      (async (text, { sessionId }) => {
        if (typeof deps.buildAssistantReply !== "function") {
          throw new Error("no buildAssistantReply function available");
        }
        return deps.buildAssistantReply(text, "", "", "default", sessionId);
      }),
    synthesizeReply:
      deps.synthesizeReply ||
      (async () => {
        throw new Error("no synthesizeReply function available");
      }),
  });
  return voiceCommands;
}

// Real discord.js Client: Gateway websocket, not polling -- Discord has no
// long-poll REST equivalent to Telegram's getUpdates. Partials.Channel/
// Partials.Message let DM events through for channels the client hasn't
// cached yet (the normal case right after startup).
function startClient(deps) {
  const env = deps.env || process.env;
  if (!env.MANA_DISCORD_BOT_TOKEN || client) return;

  const activeBridge = getBridge(deps);
  const { Client, GatewayIntentBits, Events, Partials } = deps.discordjs || require("discord.js");
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  });
  const activeVoiceCommands = getVoiceCommands(deps, client);
  client.on(Events.MessageCreate, (message) => {
    handleDiscordMessage({ message, bridge: activeBridge, voiceCommands: activeVoiceCommands }).catch((e) =>
      console.warn("discord-bot: message handling failed:", e && e.message ? e.message : e),
    );
  });
  client.login(env.MANA_DISCORD_BOT_TOKEN).catch((e) =>
    console.warn("discord-bot: login failed:", e && e.message ? e.message : e),
  );
}

function registerDiscordBotRoutes(app, deps = {}) {
  const activeBridge = getBridge(deps);

  if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
    startClient(deps);
  }

  app.get("/discord/pending", (req, res) => {
    return res.json({ pending: activeBridge.listPending() });
  });

  app.get("/discord/approved", (req, res) => {
    return res.json({ approved: activeBridge.listApproved() });
  });

  app.post("/discord/approve", (req, res) => {
    const channelId = activeBridge.approvePairing(req.body?.code);
    if (!channelId) {
      return res.status(404).json({ error: "no pending pairing matches that code" });
    }
    return res.json({ ok: true, channelId });
  });
}

module.exports = {
  key: "discordBot",
  name: "Discord Bot",
  category: "Messaging",
  defaultEnabled: false,
  description:
    "Message Mana remotely via Discord DMs, gated by a pairing-code approval so an unknown channel can't reach her. DM-only. Also supports joining a voice channel (\"!join <channelId>\" / \"!leave\") for realtime voice conversation, added alongside the Telegram bridge as a second remote-messaging option.",
  registerRoutes: registerDiscordBotRoutes,
  getHealth: (deps = {}) => {
    const env = deps.env || process.env;
    const configured = Boolean(env.MANA_DISCORD_BOT_TOKEN);
    return {
      status: configured ? "configured" : "unavailable",
      configured,
      message: configured
        ? "Discord bot configured and connected"
        : "No bot token configured -- set MANA_DISCORD_BOT_TOKEN",
    };
  },
  // Test-only escape hatch to reset the module-level singletons between
  // test files/runs -- production code never calls this.
  _resetForTests: () => {
    if (client) client.destroy().catch(() => {});
    if (voiceCommands) {
      for (const { session } of voiceCommands.sessions.values()) {
        session.destroy();
      }
    }
    bridge = null;
    client = null;
    voiceCommands = null;
  },
};
