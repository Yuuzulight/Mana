const contextPush = require("./context-push");

// Issue #189: loopback-only, no exceptions -- this route's whole purpose
// is feeding arbitrary page text into Mana's reply context, so it must
// never be reachable from the LAN even if remote exposure is otherwise
// enabled for other routes (issue #14). Same requireLocal shape
// browser-automation's routes already use.
function registerContextPushRoutes(app, deps = {}) {
  const isLocalRequest = deps.isLocalRestartRequest || (() => true);

  function requireLocal(req, res) {
    if (!isLocalRequest(req)) {
      res.status(403).json({ error: "this endpoint is only available from this PC" });
      return false;
    }
    return true;
  }

  app.post("/context/push", (req, res) => {
    if (!requireLocal(req, res)) return;
    try {
      const result = contextPush.store.push(req.body || {});
      return res.json(result);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.get("/context/status", (req, res) => {
    if (!requireLocal(req, res)) return;
    const current = contextPush.store.getCurrent();
    return res.json({
      active: Boolean(current),
      url: current?.url || null,
      title: current?.title || null,
      receivedAt: current?.receivedAt || null,
    });
  });
}

// This is Mana's plugin entry point convention: everything context-push.js
// exports, plus the route registration + metadata a plugin needs to show
// up in GET /plugins and get wired into node-bot's capabilities array.
// See plugins/README.md.
module.exports = {
  ...contextPush,
  key: "contextPush",
  name: "Passive Web Context",
  category: "Knowledge",
  // Off by default -- requires installing the companion browser extension
  // (plugins/context-push-extension/) separately, same "opt-in, needs
  // extra setup" reasoning as telegram-bridge/discord-bot/browser-automation.
  defaultEnabled: false,
  description:
    "Lets Mana reference the page or video you're currently looking at, fed by a companion browser extension that always shows a clear active/off indicator and a one-click off switch. Ephemeral only -- never written to memory storage, expires after 2 minutes.",
  registerRoutes: registerContextPushRoutes,
  getHealth: () => {
    const current = contextPush.store.getCurrent();
    return {
      status: "configured",
      configured: true,
      message: current
        ? `Currently tracking: ${current.title || current.url}`
        : "No active browser context (extension not pushing, or nothing recent)",
    };
  },
};
