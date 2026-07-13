const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");

const KEY = "sessions";

function registerSessionsRoutes(app, context = {}) {
  const acpMemoryStore = context.acpMemoryStore;

  app.get("/sessions", (req, res) => {
    try {
      return res.json({ sessions: acpMemoryStore.listSessions() });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/sessions/:id", (req, res) => {
    try {
      const sessionId = requireString(req.params?.id, "sessionId");
      const session = acpMemoryStore.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "session not found" });
      }
      return res.json(session);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.patch("/sessions/:id", (req, res) => {
    try {
      const sessionId = requireString(req.params?.id, "sessionId");
      const name = requireString(req.body?.name, "name");
      const session = acpMemoryStore.renameSession(sessionId, name);
      if (!session) {
        return res.status(404).json({ error: "session not found" });
      }
      return res.json(session);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.delete("/sessions/:id", (req, res) => {
    try {
      const sessionId = requireString(req.params?.id, "sessionId");
      const deleted = acpMemoryStore.deleteSession(sessionId);
      if (!deleted) {
        return res.status(404).json({ error: "session not found" });
      }
      return res.json({ deleted: true, sessionId });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
}

const sessionsCapability = {
  key: KEY,
  registerRoutes: registerSessionsRoutes,
  getHealth: (context = {}) => {
    const acpMemoryStore = context.acpMemoryStore;
    const sessionCount = acpMemoryStore ? acpMemoryStore.listSessions().length : 0;
    return {
      status: "configured",
      configured: true,
      message: `Session list, rename, and delete routes are available (${sessionCount} session(s) stored).`,
      sessionCount,
    };
  },
};

module.exports = {
  registerSessionsRoutes,
  sessionsCapability,
};
