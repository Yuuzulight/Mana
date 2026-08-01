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

const DEFAULT_DB_PATH = path.join(__dirname, "data", "acp-memory", "memory-graph.db");
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
      PRIMARY KEY (node_a, node_b)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_node_a ON memory_graph_edges(node_a);
    CREATE INDEX IF NOT EXISTS idx_memory_graph_edges_node_b ON memory_graph_edges(node_b);
  `);

  const edgeExistsStmt = db.prepare(
    "SELECT 1 FROM memory_graph_edges WHERE node_a = ? AND node_b = ?",
  );
  const upsertStmt = db.prepare(`
    INSERT INTO memory_graph_edges (node_a, node_b, weight, last_reinforced_at)
    VALUES (?, ?, 1.0, ?)
    ON CONFLICT(node_a, node_b) DO UPDATE SET
      weight = weight + 1,
      last_reinforced_at = excluded.last_reinforced_at
  `);
  const degreeStmt = db.prepare(
    "SELECT COUNT(*) AS count FROM memory_graph_edges WHERE node_a = ? OR node_b = ?",
  );
  const weakestEdgeForNodeStmt = db.prepare(`
    SELECT node_a, node_b FROM memory_graph_edges
    WHERE node_a = ? OR node_b = ?
    ORDER BY weight ASC, last_reinforced_at ASC
    LIMIT 1
  `);
  const deleteEdgeStmt = db.prepare(
    "DELETE FROM memory_graph_edges WHERE node_a = ? AND node_b = ?",
  );
  const totalEdgesStmt = db.prepare("SELECT COUNT(*) AS count FROM memory_graph_edges");
  const pruneLowestStmt = db.prepare(`
    DELETE FROM memory_graph_edges WHERE rowid IN (
      SELECT rowid FROM memory_graph_edges ORDER BY weight ASC, last_reinforced_at ASC LIMIT ?
    )
  `);
  const neighborsStmt = db.prepare(`
    SELECT node_a, node_b, weight FROM memory_graph_edges
    WHERE (node_a = ? OR node_b = ?) AND weight >= ?
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

    // maxDegree is only enforced before a brand-new edge is created --
    // reinforcing an edge that already exists never needs room made for it.
    if (!edgeExistsStmt.get(nodeA, nodeB)) {
      for (const node of [nodeA, nodeB]) {
        const { count } = degreeStmt.get(node, node);
        if (count >= maxDegree) {
          const weakest = weakestEdgeForNodeStmt.get(node, node);
          if (weakest) deleteEdgeStmt.run(weakest.node_a, weakest.node_b);
        }
      }
    }

    upsertStmt.run(nodeA, nodeB, now());

    const { count: total } = totalEdgesStmt.get();
    if (total > maxEdges) {
      pruneLowestStmt.run(total - maxEdges);
    }
  }

  // entities: the same array extractEntities() already produces for one
  // turn -- every pairwise combination gets its edge reinforced. Zero new
  // NLP; this is meant to be called with output the caller already computed
  // for recordEntityMentions().
  function reinforce(entities) {
    if (!Array.isArray(entities) || entities.length < 2) return;
    const unique = [...new Set(entities.map((e) => String(e)))];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        reinforcePair(unique[i], unique[j]);
      }
    }
  }

  // Neighbor entity keys reachable by one edge with weight >= minWeight,
  // best-first, excluding nodeKey itself.
  function getNeighbors(nodeKey, options = {}) {
    const key = String(nodeKey || "").toLowerCase();
    if (!key) return [];
    const minWeight = Math.max(0, Number(options.minWeight) || 0);
    const limit = Math.max(1, Number(options.limit) || 10);
    const rows = neighborsStmt.all(key, key, minWeight, limit);
    return rows.map((row) => ({
      node: row.node_a === key ? row.node_b : row.node_a,
      weight: row.weight,
    }));
  }

  function close() {
    db.close();
  }

  return { reinforce, getNeighbors, close };
}

module.exports = {
  createMemoryGraph,
  DEFAULT_DB_PATH,
  DEFAULT_MAX_EDGES,
  DEFAULT_MAX_DEGREE,
};
