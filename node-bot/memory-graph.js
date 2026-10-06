// Issue #295 (round-2 scoping of #285): a Hebbian associative graph over
// entity keys -- edges get reinforced when entities co-occur in the same
// turn, so retrieval can later surface an associatively-linked memory even
// with zero keyword/semantic overlap with the current query. Uses SQLite
// (better-sqlite3, already a dependency via session-search-index.js) rather
// than a JSON file: entity-index.json's recordEntityMentions() already
// demonstrates the write-amplification cost of a full-file read-modify-write
// on every appendTurn() call, and a graph's edges get reinforced more often
// per turn (every co-occurring pair, not one append per entity) than that
// file's per-entity mention lists -- an atomic SQL upsert avoids the
// read-then-write race entirely instead of making that cost worse.
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

// Beside the rest of memory: MANA_ACP_MEMORY_DIR moves it too.
const DEFAULT_DB_PATH = path.join(
  process.env.MANA_ACP_MEMORY_DIR || path.join(__dirname, "data", "acp-memory"),
  "memory-graph.db",
);
// An order of magnitude above acp-memory-store.js's maxFacts (500) since
// edges are pairs, not single facts -- same "fixed cap, not age-based
// pruning" reasoning as that file's own caps.
const DEFAULT_MAX_EDGES = 5000;
// Stops one hub entity (e.g. "Mana" herself, likely mentioned in nearly
// every turn) from accumulating an edge to everything.
const DEFAULT_MAX_DEGREE = 50;

// options.dbPath: injectable so tests never write into node-bot's real data
// directory (same pattern as session-search-index.js/approval-gate.js).
function createMemoryGraph(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  const maxEdges = Math.max(1, Number(options.maxEdges) || DEFAULT_MAX_EDGES);
  const maxDegree = Math.max(1, Number(options.maxDegree) || DEFAULT_MAX_DEGREE);
  const now = options.now || (() => new Date().toISOString());

  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_graph_edges (
      node_a TEXT NOT NULL,
      node_b TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      last_reinforced_at TEXT NOT NULL,
      valid_from TEXT,
      invalidated_at TEXT,
      PRIMARY KEY (node_a, node_b)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_node_a ON memory_graph_edges(node_a);
    CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_node_b ON memory_graph_edges(node_b);
  `);

  // Issue #620: each edge carries a validity window -- the same
  // validFrom/invalidatedAt pattern #431 gave facts in acp-memory-store.js,
  // applied to this table rather than a second bi-temporal system. An edge
  // is live while invalidated_at IS NULL; eviction (maxDegree/maxEdges)
  // closes the window instead of deleting the row. Additive and idempotent
  // so a pre-#620 memory-graph.db keeps every edge it already has.
  const columns = new Set(db.prepare("PRAGMA table_info(memory_graph_edges)").all().map((c) => c.name));
  if (!columns.has("valid_from")) db.exec("ALTER TABLE memory_graph_edges ADD COLUMN valid_from TEXT");
  if (!columns.has("invalidated_at")) db.exec("ALTER TABLE memory_graph_edges ADD COLUMN invalidated_at TEXT");
  // A pre-#620 edge's creation time was never stored; last_reinforced_at is
  // the earliest moment it's known to have held, so that's its validFrom.
  db.exec("UPDATE memory_graph_edges SET valid_from = last_reinforced_at WHERE valid_from IS NULL");
  // One row per pair in memory_graph_edges (its primary key), so when a
  // closed edge is reinforced again its old window moves here first -- the
  // edge equivalent of a fact's `history` array -- instead of being
  // overwritten by the new window.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_graph_edge_history (
      node_a TEXT NOT NULL,
      node_b TEXT NOT NULL,
      weight REAL NOT NULL,
      valid_from TEXT,
      invalidated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_graph_edge_history_node_a ON memory_graph_edge_history(node_a);
    CREATE INDEX IF NOT EXISTS idx_memory_graph_edge_history_node_b ON memory_graph_edge_history(node_b);
  `);

  const edgeExistsStmt = db.prepare(
    "SELECT 1 FROM memory_graph_edges WHERE node_a = ? AND node_b = ? AND invalidated_at IS NULL",
  );
  const archiveClosedStmt = db.prepare(`
    INSERT INTO memory_graph_edge_history (node_a, node_b, weight, valid_from, invalidated_at)
    SELECT node_a, node_b, weight, valid_from, invalidated_at FROM memory_graph_edges
    WHERE node_a = ? AND node_b = ? AND invalidated_at IS NOT NULL
  `);
  // A closed edge reinforced again starts a fresh window at weight 1, the
  // same as a brand-new edge (its old window was archived just before).
  const upsertStmt = db.prepare(`
    INSERT INTO memory_graph_edges (node_a, node_b, weight, last_reinforced_at, valid_from)
    VALUES (?, ?, 1.0, ?, ?)
    ON CONFLICT(node_a, node_b) DO UPDATE SET
      weight = CASE WHEN invalidated_at IS NULL THEN weight + 1 ELSE 1.0 END,
      valid_from = CASE WHEN invalidated_at IS NULL THEN valid_from ELSE excluded.valid_from END,
      invalidated_at = NULL,
      last_reinforced_at = excluded.last_reinforced_at
  `);
  const degreeStmt = db.prepare(
    "SELECT COUNT(*) AS count FROM memory_graph_edges WHERE (node_a = ? OR node_b = ?) AND invalidated_at IS NULL",
  );
  const weakestEdgeForNodeStmt = db.prepare(`
    SELECT node_a, node_b FROM memory_graph_edges
    WHERE (node_a = ? OR node_b = ?) AND invalidated_at IS NULL
    ORDER BY weight ASC, last_reinforced_at ASC
    LIMIT 1
  `);
  const closeEdgeStmt = db.prepare(
    "UPDATE memory_graph_edges SET invalidated_at = ? WHERE node_a = ? AND node_b = ?",
  );
  const totalEdgesStmt = db.prepare(
    "SELECT COUNT(*) AS count FROM memory_graph_edges WHERE invalidated_at IS NULL",
  );
  const closeLowestStmt = db.prepare(`
    UPDATE memory_graph_edges SET invalidated_at = ? WHERE rowid IN (
      SELECT rowid FROM memory_graph_edges WHERE invalidated_at IS NULL
      ORDER BY weight ASC, last_reinforced_at ASC LIMIT ?
    )
  `);
  // Q28: closed windows are never pruned (no cap); Doctor shows how many
  // there are (getHistorySize).
  const historySizeStmt = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM memory_graph_edges WHERE invalidated_at IS NULL) AS live,
      (SELECT COUNT(*) FROM memory_graph_edges WHERE invalidated_at IS NOT NULL) AS closed,
      (SELECT COUNT(*) FROM memory_graph_edge_history) AS archived
  `);
  const neighborsStmt = db.prepare(`
    SELECT node_a, node_b, weight, valid_from, invalidated_at FROM memory_graph_edges
    WHERE (node_a = ? OR node_b = ?) AND weight >= ? AND invalidated_at IS NULL
    ORDER BY weight DESC
    LIMIT ?
  `);
  // Same window test as acp-memory-store.js's windowCovers(): valid_from <=
  // asOf < invalidated_at. A pair's windows never overlap (a closed edge is
  // only reopened after its closure), so each pair matches at most once.
  const neighborsAsOfStmt = db.prepare(`
    SELECT node_a, node_b, weight, valid_from, invalidated_at FROM (
      SELECT node_a, node_b, weight, valid_from, invalidated_at FROM memory_graph_edges
      UNION ALL
      SELECT node_a, node_b, weight, valid_from, invalidated_at FROM memory_graph_edge_history
    )
    WHERE (node_a = ? OR node_b = ?) AND weight >= ?
      AND valid_from <= ? AND (invalidated_at IS NULL OR invalidated_at > ?)
    ORDER BY weight DESC
    LIMIT ?
  `);

  function pairKey(a, b) {
    const x = String(a).toLowerCase();
    const y = String(b).toLowerCase();
    return x < y ? [x, y] : [y, x];
  }

  function reinforcePair(a, b) {
    const [nodeA, nodeB] = pairKey(a, b);
    if (nodeA === nodeB) return;
    const at = now();

    // maxDegree is only enforced before a brand-new (or reopened) edge is
    // created -- reinforcing a live edge never needs room made for it.
    if (!edgeExistsStmt.get(nodeA, nodeB)) {
      for (const node of [nodeA, nodeB]) {
        const { count } = degreeStmt.get(node, node);
        if (count >= maxDegree) {
          const weakest = weakestEdgeForNodeStmt.get(node, node);
          if (weakest) closeEdgeStmt.run(at, weakest.node_a, weakest.node_b);
        }
      }
      archiveClosedStmt.run(nodeA, nodeB);
    }

    upsertStmt.run(nodeA, nodeB, at, at);

    const { count: total } = totalEdgesStmt.get();
    if (total > maxEdges) closeLowestStmt.run(at, total - maxEdges);
  }

  // entities: the same array extractEntities() already produces for one
  // turn -- every pairwise combination gets its edge reinforced. Zero new
  // NLP; this is meant to be called with output the caller already computed
  // for recordEntityMentions().
  // One transaction per call: a reopened edge's archive + upsert must land
  // together, and it saves a WAL commit per pair.
  const reinforce = db.transaction((entities) => {
    if (!Array.isArray(entities) || entities.length < 2) return;
    const unique = [...new Set(entities.map((e) => String(e)))];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        reinforcePair(unique[i], unique[j]);
      }
    }
  });

  // Neighbor entity keys reachable by one edge with weight >= minWeight,
  // best-first, excluding nodeKey itself. Live edges only, unless
  // options.asOf (an ISO timestamp) asks what nodeKey was associated with
  // at that moment -- closed and archived windows included. An edge still
  // live reports today's weight, not its weight as of asOf.
  function getNeighbors(nodeKey, options = {}) {
    const key = String(nodeKey || "").toLowerCase();
    if (!key) return [];
    const minWeight = Math.max(0, Number(options.minWeight) || 0);
    const limit = Math.max(1, Number(options.limit) || 10);
    const asOf = options.asOf ? String(options.asOf) : "";
    const rows = asOf
      ? neighborsAsOfStmt.all(key, key, minWeight, asOf, asOf, limit)
      : neighborsStmt.all(key, key, minWeight, limit);
    return rows.map((row) => ({
      node: row.node_a === key ? row.node_b : row.node_a,
      weight: row.weight,
      validFrom: row.valid_from,
      invalidatedAt: row.invalidated_at,
    }));
  }

  function close() {
    db.close();
  }

  // Issue #641: the strongest edges overall, for the memory-graph view --
  // bounded by the caller so the view never pulls the whole table.
  const strongestEdgesStmt = db.prepare(`
    SELECT node_a, node_b, weight, last_reinforced_at FROM memory_graph_edges
    WHERE invalidated_at IS NULL
    ORDER BY weight DESC, last_reinforced_at DESC
    LIMIT ?
  `);

  function listStrongestEdges(limit) {
    return strongestEdgesStmt.all(Math.max(1, Number(limit) || 1)).map((row) => ({
      a: row.node_a,
      b: row.node_b,
      weight: row.weight,
      lastReinforcedAt: row.last_reinforced_at,
    }));
  }

  // Q28: live edges, closed windows still in the edges table, and archived
  // windows (memory_graph_edge_history), for Doctor.
  function getHistorySize() {
    return historySizeStmt.get();
  }

  // #1390: closed windows (kept in the edges table or archived) whose closure
  // is older than `iso`. Live edges are never counted or pruned.
  const countHistoryStmt = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM memory_graph_edges WHERE invalidated_at IS NOT NULL AND invalidated_at < ?) AS closed,
      (SELECT COUNT(*) FROM memory_graph_edge_history WHERE invalidated_at < ?) AS history
  `);
  function countHistoryBefore(iso) {
    return countHistoryStmt.get(String(iso), String(iso));
  }

  const pruneHistoryBefore = db.transaction((iso) => {
    const counts = countHistoryStmt.get(String(iso), String(iso));
    db.prepare("DELETE FROM memory_graph_edges WHERE invalidated_at IS NOT NULL AND invalidated_at < ?").run(String(iso));
    db.prepare("DELETE FROM memory_graph_edge_history WHERE invalidated_at < ?").run(String(iso));
    return counts;
  });

  // #1390: a consistent copy of the db (better-sqlite3's online backup); async.
  function backup(destPath) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    return db.backup(destPath);
  }

  return { reinforce, getNeighbors, listStrongestEdges, getHistorySize, countHistoryBefore, pruneHistoryBefore, backup, close };
}

module.exports = {
  createMemoryGraph,
  DEFAULT_DB_PATH,
  DEFAULT_MAX_EDGES,
  DEFAULT_MAX_DEGREE,
};
