const {
  ValidationError,
  optionalString,
  requireString,
  sendValidationError,
} = require("../request-validation");
const { exportSessionAsShareGPTJSONL } = require("../session-export");
const { artifactsOf } = require("../artifact-history");

const KEY = "sessions";

function registerSessionsRoutes(app, context = {}) {
  const acpMemoryStore = context.acpMemoryStore;

  // #687: ?q= keeps only the sessions whose stored messages contain every
  // word (session-search-index.js). `query` is echoed so a client can tell
  // this backend understood q. No search index = no matches.
  app.get("/sessions", (req, res) => {
    try {
      const q = typeof req.query?.q === "string" ? req.query.q.trim() : "";
      if (!q) return res.json({ sessions: acpMemoryStore.listSessions() });
      const ids = acpMemoryStore.sessionIdsMatching ? acpMemoryStore.sessionIdsMatching(q) : null;
      const sessions = ids ? acpMemoryStore.listSessions().filter((s) => ids.has(s.sessionId)) : [];
      return res.json({ sessions, query: q });
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

  // Paginated scrollback for the desktop chat log: turns are stored
  // oldest-first, so "before" is a turn-index cursor -- omitted, it
  // returns the most recent page; passing back nextBefore fetches the
  // page immediately before that one.
  app.get("/sessions/:id/turns", (req, res) => {
    try {
      const sessionId = requireString(req.params?.id, "sessionId");
      const limit = req.query?.limit !== undefined ? Number(req.query.limit) : undefined;
      const before = req.query?.before !== undefined ? Number(req.query.before) : undefined;
      const page = acpMemoryStore.getSessionTurnsPage(sessionId, { before, limit });
      if (!page) {
        return res.status(404).json({ error: "session not found" });
      }
      return res.json(page);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  // #1142: a chat's artifacts without their content (artifact-history.js),
  // for the Artifacts panel; ?before= (an ISO time) keeps turns saved
  // earlier. .../artifacts/:turn is one artifact's { language, content }.
  app.get("/sessions/:id/artifacts", (req, res) => {
    try {
      const sessionId = requireString(req.params?.id, "sessionId");
      const session = acpMemoryStore.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "session not found" });
      }
      const before = typeof req.query?.before === "string" ? Date.parse(req.query.before) : NaN;
      return res.json({ artifacts: artifactsOf(session, { before: Number.isNaN(before) ? undefined : before }) });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/sessions/:id/artifacts/:turn", (req, res) => {
    try {
      const sessionId = requireString(req.params?.id, "sessionId");
      const artifact = acpMemoryStore.getSession(sessionId)?.turns?.[Number(req.params?.turn)]?.artifact;
      if (!artifact) {
        return res.status(404).json({ error: "artifact not found" });
      }
      return res.json({ language: artifact.language, content: artifact.content });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  // Issue #153: full turn history as ShareGPT-style JSONL, for the user's
  // own analysis or fine-tuning. Local file output only -- this just
  // returns the JSONL text; the caller (windows-launcher's renderer, via
  // a native save dialog) is what actually writes it to disk.
  app.get("/sessions/:id/export", (req, res) => {
    try {
      const sessionId = requireString(req.params?.id, "sessionId");
      const session = acpMemoryStore.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "session not found" });
      }
      const jsonl = exportSessionAsShareGPTJSONL(session);
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(sessionId)}.jsonl"`,
      );
      return res.send(jsonl);
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
      const hasName = Boolean(req.body) && "name" in req.body;
      // Issue #401: goal is a separate, optional field on the same PATCH --
      // an explicit empty string clears it, same as name's own
      // empty-becomes-null behavior in renameSession.
      const hasGoal = Boolean(req.body) && "goal" in req.body;
      if (!hasName && !hasGoal) {
        throw new ValidationError("name or goal is required");
      }

      let session = null;
      if (hasName) {
        const name = requireString(req.body.name, "name");
        session = acpMemoryStore.renameSession(sessionId, name);
        if (!session) {
          return res.status(404).json({ error: "session not found" });
        }
      }
      if (hasGoal) {
        const goal = optionalString(req.body.goal, "goal");
        session = acpMemoryStore.setSessionGoal(sessionId, goal);
        if (!session) {
          return res.status(404).json({ error: "session not found" });
        }
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
