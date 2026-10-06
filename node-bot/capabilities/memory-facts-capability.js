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
      // #1331: a deleted fact is "stale" -- gone from the list.
      const facts = acpMemoryStore
        .listFacts()
        .filter((fact) => fact.status !== "stale")
        .map((fact) => ({ ...fact, trust: factTrust(fact) }));
      return res.json({ ok: true, facts });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // #1331: add a fact by hand from the launcher. Body {key, text, trigger?};
  // the user's own words, so it's active at once. 400 on a blank key/text or
  // when the key already has a live fact (edit that one instead).
  app.post("/admin/memory/facts", adminMemoryRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      const trigger = typeof req.body?.trigger === "string" ? req.body.trigger.trim() : "";
      if (!key) return res.status(400).json({ ok: false, error: "key can't be empty" });
      if (!text) return res.status(400).json({ ok: false, error: "text can't be empty" });
      const lowerKey = key.toLowerCase();
      const taken = acpMemoryStore
        .listFacts()
        .some((f) => ["active", "pending"].includes(f.status) && f.key.toLowerCase() === lowerKey);
      if (taken) return res.status(400).json({ ok: false, error: "a fact with that key already exists" });
      const result = acpMemoryStore.rememberFact({
        key,
        text,
        action: "insert",
        source: "human",
        origin: { kind: "user_stated" },
        ...(trigger ? { trigger, triggerUserWords: trigger } : {}),
      });
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // #1331: really remove a fact (live or archived) -- unlike archive it
  // doesn't stay in Archived/; the vault sync drops its note.
  app.delete("/admin/memory/facts/:key", adminMemoryRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const result = acpMemoryStore.rememberFact({
        key: req.params.key,
        action: "remove",
        source: "human",
        origin: { kind: "user_stated" },
      });
      return res.status(result.found ? 200 : 404).json({ ...result, ok: result.found });
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
      for (const fact of acpMemoryStore.listFacts().filter((f) => f.status !== "stale")) {
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

  // Q29 (#698): edit a live fact's text -- and a standing intent's trigger
  // -- from Settings. Goes through rememberFact's patch like any other
  // write, so the old value lands in the fact's history and facts-log.
  // A trigger typed here is the user's own words, so it replaces both
  // wordings. Body {text, trigger?}; 404 when no live fact has that key.
  app.patch("/admin/memory/facts/:key", adminMemoryRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const key = String(req.params.key || "").toLowerCase();
      const existing = acpMemoryStore
        .listFacts()
        .find((f) => ["active", "pending"].includes(f.status) && f.key.toLowerCase() === key);
      if (!existing) return res.status(404).json({ ok: false, error: "no live fact with that key" });
      const text = typeof req.body?.text === "string" ? req.body.text : existing.text;
      if (!text.trim()) return res.status(400).json({ ok: false, error: "text can't be empty" });
      const trigger = typeof req.body?.trigger === "string" && existing.trigger ? req.body.trigger.trim() : "";
      const result = acpMemoryStore.rememberFact({
        key: existing.key,
        text,
        action: "patch",
        source: "human",
        origin: { kind: "user_stated" },
        ...(trigger ? { trigger, triggerUserWords: trigger } : {}),
      });
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // #1390: the dry-run plan (what maintenance would do, what it keeps, how
  // big each store is). Changes nothing.
  app.get("/admin/memory/maintenance", adminMemoryRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const maintenance = context.getMemoryMaintenance?.();
    if (!maintenance) return res.status(503).json({ ok: false, error: "memory maintenance isn't available" });
    try {
      return res.json({ ok: true, ...maintenance.plan(), status: maintenance.status() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // #1390: runs the auto steps plus the needs-approval steps named in the
  // body {approve: [stepIds]} -- that list is the approval.
  app.post("/admin/memory/maintenance/run", adminMemoryRateLimiter, async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const maintenance = context.getMemoryMaintenance?.();
    if (!maintenance) return res.status(503).json({ ok: false, error: "memory maintenance isn't available" });
    try {
      const approve = Array.isArray(req.body?.approve) ? req.body.approve.map(String) : [];
      return res.json({ ok: true, ...(await maintenance.run({ mode: "approved", approve })) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Issue #698: pause/resume a standing intent (a fact with a trigger) --
  // a paused one never fires. Body {paused: boolean}, same shape as pin.
  app.post("/admin/memory/facts/:key/pause", adminMemoryRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const result = acpMemoryStore.setFactPaused(req.params.key, req.body?.paused === true);
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
    message: "Memory facts admin routes are available (list, history, edit, archive, confirm, pin, pause).",
  }),
};

module.exports = {
  registerMemoryFactsRoutes,
  memoryFactsCapability,
};
