const KEY = "memoryFacts";

// Issue #324: admin surface for acp-memory-store.js's remembered-fact store
// (memory__remember/rememberFact) -- the one carrying unverifiedSource
// (issue #317), status, and correction history. Previously the only way to
// inspect any of that was reading facts.json by hand. Distinct from
// background-memory-capability.js, which admins a different memory system
// entirely (Mana's own compacted summary/audit log).
function registerMemoryFactsRoutes(app, context = {}) {
  const checkAdminAuth = context.checkAdminAuth;
  const acpMemoryStore = context.acpMemoryStore;

  app.get("/admin/memory/facts", (req, res) => {
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
  app.post("/admin/memory/facts/:key/archive", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const result = acpMemoryStore.rememberFact({
        key: req.params.key,
        action: "archive",
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
