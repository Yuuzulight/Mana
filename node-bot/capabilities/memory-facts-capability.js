const rateLimit = require("express-rate-limit");

const KEY = "memoryFacts";

// server.js already applies an app-wide rate limiter before
// registerCapabilities runs, so these routes are covered in practice --
// but CodeQL's static analysis doesn't trace that indirection through
// registerRoutes(app, context), and flags routes registered this way as
// unprotected. A route-local limiter closes the gap CodeQL can actually see.
const adminMemoryRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.MANA_RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
});

// Issue #324: admin surface for acp-memory-store.js's remembered-fact store
// (memory__remember/rememberFact) -- the one carrying unverifiedSource
// (issue #317), status, and correction history. Previously the only way to
// inspect any of that was reading facts.json by hand. Distinct from
// background-memory-capability.js, which admins a different memory system
// entirely (Mana's own compacted summary/audit log).
function registerMemoryFactsRoutes(app, context = {}) {
  const checkAdminAuth = context.checkAdminAuth;
  const acpMemoryStore = context.acpMemoryStore;

  app.get("/admin/memory/facts", adminMemoryRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      return res.json({ ok: true, facts: acpMemoryStore.listFacts() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Reuses rememberFact's existing "archive" action (issue #277) -- marks a
  // still-true fact as no-longer-worth-auto-surfacing without deleting it,
  // same as the model itself can already do via the memory tool.
  app.post("/admin/memory/facts/:key/archive", adminMemoryRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const result = acpMemoryStore.rememberFact({
        key: req.params.key,
        action: "archive",
        source: "human",
      });
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });
}

const memoryFactsCapability = {
  key: KEY,
  registerRoutes: registerMemoryFactsRoutes,
  getHealth: () => ({
    status: "configured",
    configured: true,
    message: "Memory facts admin routes are available (list, archive).",
  }),
};

module.exports = {
  registerMemoryFactsRoutes,
  memoryFactsCapability,
};
