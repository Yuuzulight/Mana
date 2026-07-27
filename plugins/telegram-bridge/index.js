const {
  createTelegramBridge,
  createTelegramClient,
  pollOnce,
} = require("./telegram-bridge");

// Module-level singleton, same pattern as cron-scheduler/image-generation
// -- one bridge/poll-loop shared across every route and the background
// polling interval.
let bridge = null;
let pollTimer = null;
let pollOffset = 0;

function getBridge(deps = {}) {
  if (!bridge) {
    bridge = createTelegramBridge({
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

function startPolling(deps) {
  const env = deps.env || process.env;
  if (!env.MANA_TELEGRAM_BOT_TOKEN || pollTimer) return;

  const client = deps.telegramClient || createTelegramClient({ botToken: env.MANA_TELEGRAM_BOT_TOKEN });
  const activeBridge = getBridge(deps);
  const intervalMs = Number(env.MANA_TELEGRAM_POLL_INTERVAL_MS) || 3000;

  pollTimer = setInterval(() => {
    pollOnce({ client, bridge: activeBridge, lastOffset: pollOffset })
      .then((nextOffset) => {
        pollOffset = nextOffset;
      })
      .catch((e) =>
        console.warn("telegram-bridge: poll failed:", e && e.message ? e.message : e),
      );
  }, intervalMs);
  if (typeof pollTimer.unref === "function") pollTimer.unref();
}

function registerTelegramBridgeRoutes(app, deps = {}) {
  const activeBridge = getBridge(deps);

  if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
    startPolling(deps);
  }

  app.get("/telegram/pending", (req, res) => {
    return res.json({ pending: activeBridge.listPending() });
  });

  app.get("/telegram/approved", (req, res) => {
    return res.json({ approved: activeBridge.listApproved() });
  });

  app.post("/telegram/approve", (req, res) => {
    const chatId = activeBridge.approvePairing(req.body?.code);
    if (!chatId) {
      return res.status(404).json({ error: "no pending pairing matches that code" });
    }
    return res.json({ ok: true, chatId });
  });
}

module.exports = {
  key: "telegramBridge",
  name: "Telegram Bridge",
  category: "Messaging",
  defaultEnabled: false,
  description:
    "Message Mana remotely via Telegram, gated by a pairing-code approval so an unknown chat can't reach her. DM-only, text-only, long-polling (no public webhook needed).",
  registerRoutes: registerTelegramBridgeRoutes,
  getHealth: (deps = {}) => {
    const env = deps.env || process.env;
    const configured = Boolean(env.MANA_TELEGRAM_BOT_TOKEN);
    return {
      status: configured ? "configured" : "unavailable",
      configured,
      message: configured
        ? "Telegram bridge configured and polling"
        : "No bot token configured -- set MANA_TELEGRAM_BOT_TOKEN",
    };
  },
  // Test-only escape hatch to reset the module-level singleton between
  // test files/runs -- production code never calls this.
  _resetForTests: () => {
    if (pollTimer) clearInterval(pollTimer);
    bridge = null;
    pollTimer = null;
    pollOffset = 0;
  },
};
