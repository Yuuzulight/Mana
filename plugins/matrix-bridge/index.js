const { createMatrixBridge, createMatrixClient, syncOnce } = require("./matrix-bridge");

// Module-level singletons, same pattern as telegram-bridge's -- one
// bridge/client/sync-loop shared across every route and the background
// sync interval.
let bridge = null;
let client = null;
let syncStarted = false;
let syncTimer = null;
let syncSince;

function getBridge(deps = {}) {
  if (!bridge) {
    bridge = createMatrixBridge({
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

// Calls syncOnce and reschedules itself only once that call finishes --
// not a fixed setInterval like telegram-bridge's, deliberately. Matrix's
// `/sync` blocks server-side for up to SYNC_TIMEOUT_MS (30s); an interval
// shorter than that would let two syncs run concurrently and race over
// which one's `since` token wins, silently dropping messages the loser's
// response saw. Rescheduling after completion keeps exactly one `/sync`
// in flight at a time.
function scheduleSync(deps, activeClient, activeBridge, intervalMs, botUserId) {
  syncOnce({ client: activeClient, bridge: activeBridge, botUserId, since: syncSince })
    .then((nextSince) => {
      syncSince = nextSince;
    })
    .catch((e) => console.warn("matrix-bridge: sync failed:", e && e.message ? e.message : e))
    .finally(() => {
      syncTimer = setTimeout(() => scheduleSync(deps, activeClient, activeBridge, intervalMs, botUserId), intervalMs);
      if (typeof syncTimer.unref === "function") syncTimer.unref();
    });
}

function startSyncing(deps) {
  const env = deps.env || process.env;
  if (!env.MANA_MATRIX_HOMESERVER_URL || !env.MANA_MATRIX_ACCESS_TOKEN || !env.MANA_MATRIX_USER_ID) return;
  if (syncStarted) return;
  syncStarted = true;

  client =
    deps.matrixClient ||
    createMatrixClient({
      homeserverUrl: env.MANA_MATRIX_HOMESERVER_URL,
      accessToken: env.MANA_MATRIX_ACCESS_TOKEN,
    });
  const activeBridge = getBridge(deps);
  const intervalMs = Number(env.MANA_MATRIX_POLL_INTERVAL_MS) || 1000;

  scheduleSync(deps, client, activeBridge, intervalMs, env.MANA_MATRIX_USER_ID);
}

function registerMatrixBridgeRoutes(app, deps = {}) {
  const activeBridge = getBridge(deps);

  if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
    startSyncing(deps);
  }

  app.get("/matrix/pending", (req, res) => {
    return res.json({ pending: activeBridge.listPending() });
  });

  app.get("/matrix/approved", (req, res) => {
    return res.json({ approved: activeBridge.listApproved() });
  });

  app.post("/matrix/approve", (req, res) => {
    const roomId = activeBridge.approvePairing(req.body?.code);
    if (!roomId) {
      return res.status(404).json({ error: "no pending pairing matches that code" });
    }
    return res.json({ ok: true, roomId });
  });
}

module.exports = {
  key: "matrixBridge",
  name: "Matrix Bridge",
  category: "Messaging",
  defaultEnabled: false,
  description:
    "Message Mana remotely via a self-hosted Matrix homeserver, gated by a pairing-code approval so an unknown room can't reach her. Unencrypted rooms only -- no E2EE (Olm/Megolm) support; an encrypted room's messages are skipped, not decrypted. Auto-joins on invite.",
  registerRoutes: registerMatrixBridgeRoutes,
  getHealth: (deps = {}) => {
    const env = deps.env || process.env;
    const configured = Boolean(
      env.MANA_MATRIX_HOMESERVER_URL && env.MANA_MATRIX_ACCESS_TOKEN && env.MANA_MATRIX_USER_ID,
    );
    return {
      status: configured ? "configured" : "unavailable",
      configured,
      message: configured
        ? "Matrix bridge configured and syncing"
        : "Not configured -- set MANA_MATRIX_HOMESERVER_URL, MANA_MATRIX_ACCESS_TOKEN, and MANA_MATRIX_USER_ID",
    };
  },
  // Test-only escape hatch to reset the module-level singletons between
  // test files/runs -- production code never calls this.
  _resetForTests: () => {
    if (syncTimer) clearTimeout(syncTimer);
    bridge = null;
    client = null;
    syncStarted = false;
    syncTimer = null;
    syncSince = undefined;
  },
};
