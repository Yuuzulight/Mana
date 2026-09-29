const rateLimit = require("express-rate-limit");
const { factTrust } = require("../acp-memory-store");

const KEY = "memoryFacts";
// ponytail: fixed bound so the native view's layout stays readable and
// cheap (<= 2x this many nodes); add paging/zoom if 150 ever hides too much.
const MEMORY_GRAPH_MAX_EDGES = 150;

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
      // Issue #673: trust is derived (factTrust), shown alongside each fact.
      const facts = acpMemoryStore.listFacts().map((fact) => ({ ...fact, trust: factTrust(fact) }));
      return res.json({ ok: true, facts });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Issue #641: read-only data for the native launcher's memory-graph view
  // -- the strongest Hebbian edges (#295), each endpoint's ontology type
  // (#432), and every fact's validity window(s) (#431), superseded ones
  // included so the view can show them on a timeline instead of hiding them.
  app.get("/admin/memory/graph", adminMemoryRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const graph = acpMemoryStore.memoryGraph;
      const allEdges = graph ? graph.listStrongestEdges(MEMORY_GRAPH_MAX_EDGES) : [];
      const keys = [...new Set(allEdges.flatMap((edge) => [edge.a, edge.b]))];
      // Typed as "not a real entity" by the ontology pass -- noise, not memory.
      const nodes = acpMemoryStore.describeEntities(keys).filter((node) => node.type !== "not_an_entity");
      const shown = new Set(nodes.map((node) => node.key));
      const edges = allEdges.filter((edge) => shown.has(edge.a) && shown.has(edge.b));

      const facts = [];
      for (const fact of acpMemoryStore.listFacts()) {
        facts.push({
          key: fact.key,
          text: fact.text,
          validFrom: fact.validFrom || fact.createdAt || null,
          invalidatedAt: fact.invalidatedAt || null,
        });
        for (const past of Array.isArray(fact.history) ? fact.history : []) {
          facts.push({ key: fact.key, text: past.text, validFrom: past.validFrom || null, invalidatedAt: past.invalidatedAt || null });
        }
      }
      // Newest first. Plain string order is time order for ISO timestamps
      // (localeCompare's collation isn't guaranteed to be).
      const from = (fact) => fact.validFrom || "";
      facts.sort((x, y) => (from(x) < from(y) ? 1 : from(x) > from(y) ? -1 : 0));

      return res.json({ ok: true, nodes, edges, facts });
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

  // Issue #673: every logged change to one fact key (facts-log.jsonl),
  // oldest first -- before/after for the diff, origin for the blame.
  // Rolling back is snapshot__restore on a memory-fact snapshot (approval-
  // gated), not a route here.
  app.get("/admin/memory/facts/:key/history", adminMemoryRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      return res.json({ ok: true, key: req.params.key, entries: acpMemoryStore.getFactHistory(req.params.key) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Issue #663: confirm a pending (auto-picked-up) fact, making it active.
  app.post("/admin/memory/facts/:key/confirm", adminMemoryRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const result = acpMemoryStore.rememberFact({
        key: req.params.key,
        action: "confirm",
        source: "human",
      });
      return res.status(result.found ? 200 : 404).json({ ...result, ok: result.found });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Issue #674: pin/unpin a fact so it is injected every turn. Body
  // {pinned: boolean}; anything but a literal true unpins.
  app.post("/admin/memory/facts/:key/pin", adminMemoryRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const result = acpMemoryStore.setFactPinned(req.params.key, req.body?.pinned === true);
      return res.status(result.found ? 200 : 404).json({ ok: result.found, ...result });
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
    message: "Memory facts admin routes are available (list, history, archive, confirm, pin).",
  }),
};

module.exports = {
  registerMemoryFactsRoutes,
  memoryFactsCapability,
};
