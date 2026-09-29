const assert = require("node:assert/strict");
const test = require("node:test");

const { createMemoryGraph } = require("../memory-graph");

test("reinforce creates edges between every pairwise combination of entities in one call", () => {
  const graph = createMemoryGraph({ dbPath: ":memory:" });
  graph.reinforce(["Acme Corp", "Beta Corp", "Gamma Corp"]);

  assert.deepEqual(
    graph.getNeighbors("Acme Corp").map((n) => n.node).sort(),
    ["beta corp", "gamma corp"],
  );
  assert.deepEqual(
    graph.getNeighbors("Beta Corp").map((n) => n.node).sort(),
    ["acme corp", "gamma corp"],
  );
  graph.close();
});

test("reinforce is case-insensitive and dedups the node pair regardless of argument order", () => {
  const graph = createMemoryGraph({ dbPath: ":memory:" });
  graph.reinforce(["Acme Corp", "Beta Corp"]);
  graph.reinforce(["beta corp", "ACME CORP"]);

  const neighbors = graph.getNeighbors("Acme Corp");
  assert.equal(neighbors.length, 1);
  assert.equal(neighbors[0].node, "beta corp");
  assert.equal(neighbors[0].weight, 2, "both calls should reinforce the same edge, not create two");
  graph.close();
});

test("reinforce with fewer than 2 entities is a no-op", () => {
  const graph = createMemoryGraph({ dbPath: ":memory:" });
  graph.reinforce([]);
  graph.reinforce(["Solo Corp"]);
  assert.deepEqual(graph.getNeighbors("Solo Corp"), []);
  graph.close();
});

test("reinforce never creates a self-edge when the same entity appears twice", () => {
  const graph = createMemoryGraph({ dbPath: ":memory:" });
  graph.reinforce(["Acme Corp", "Acme Corp", "Beta Corp"]);
  assert.deepEqual(
    graph.getNeighbors("Acme Corp").map((n) => n.node),
    ["beta corp"],
  );
  graph.close();
});

test("getNeighbors respects minWeight and returns best-weight-first", () => {
  const graph = createMemoryGraph({ dbPath: ":memory:" });
  graph.reinforce(["Hub", "Weak"]);
  graph.reinforce(["Hub", "Strong"]);
  graph.reinforce(["Hub", "Strong"]);
  graph.reinforce(["Hub", "Strong"]);

  const all = graph.getNeighbors("Hub");
  assert.deepEqual(all.map((n) => n.node), ["strong", "weak"]);

  const filtered = graph.getNeighbors("Hub", { minWeight: 2 });
  assert.deepEqual(filtered.map((n) => n.node), ["strong"]);
  graph.close();
});

test("getNeighbors respects limit", () => {
  const graph = createMemoryGraph({ dbPath: ":memory:" });
  graph.reinforce(["Hub", "A", "B", "C", "D"]);
  const neighbors = graph.getNeighbors("Hub", { limit: 2 });
  assert.equal(neighbors.length, 2);
  graph.close();
});

test("getNeighbors returns [] for an unknown or empty node key", () => {
  const graph = createMemoryGraph({ dbPath: ":memory:" });
  assert.deepEqual(graph.getNeighbors("Nobody"), []);
  assert.deepEqual(graph.getNeighbors(""), []);
  graph.close();
});

test("maxEdges prunes the lowest-weight edges once the cap is exceeded", () => {
  const graph = createMemoryGraph({ dbPath: ":memory:", maxEdges: 2, maxDegree: 100 });
  graph.reinforce(["A", "B"]);
  graph.reinforce(["A", "B"]); // weight 2, edge A-B
  graph.reinforce(["A", "C"]); // weight 1, edge A-C -- should get pruned once D pushes past cap
  graph.reinforce(["A", "D"]); // weight 1, edge A-D

  const neighbors = graph.getNeighbors("A", { limit: 100 });
  assert.equal(neighbors.length, 2, "total edges must stay at or under maxEdges");
  assert.ok(neighbors.some((n) => n.node === "b"), "the strongest edge must survive pruning");
  graph.close();
});

test("maxDegree evicts a node's own weakest edge before adding a new one past the cap", () => {
  const graph = createMemoryGraph({ dbPath: ":memory:", maxEdges: 1000, maxDegree: 2 });
  graph.reinforce(["Hub", "A"]);
  graph.reinforce(["Hub", "B"]);
  graph.reinforce(["Hub", "B"]); // B now weight 2, A still weight 1 -- Hub at maxDegree (2)
  graph.reinforce(["Hub", "C"]); // must evict Hub's weakest edge (Hub-A) to make room

  const neighbors = graph.getNeighbors("Hub", { limit: 100 });
  assert.equal(neighbors.length, 2);
  assert.ok(neighbors.some((n) => n.node === "b"));
  assert.ok(neighbors.some((n) => n.node === "c"));
  assert.ok(!neighbors.some((n) => n.node === "a"), "the weakest edge (Hub-A) should have been evicted");
  graph.close();
});

test("reinforcing an already-existing edge never triggers maxDegree eviction", () => {
  const graph = createMemoryGraph({ dbPath: ":memory:", maxDegree: 1 });
  graph.reinforce(["Hub", "A"]);
  graph.reinforce(["Hub", "A"]); // same edge again -- Hub is already "at" maxDegree via this edge
  const neighbors = graph.getNeighbors("Hub");
  assert.equal(neighbors.length, 1);
  assert.equal(neighbors[0].weight, 2);
  graph.close();
});

// Issue #620: an evicted edge's validity window is closed, not deleted, and
// survives the pair being reinforced again later.
test("an evicted association stays retrievable as historical via getNeighbors asOf", () => {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const graph = createMemoryGraph({ dbPath: ":memory:", maxDegree: 1, now });
  graph.reinforce(["Hub", "A"]); // t0: Hub-A opens
  graph.reinforce(["Hub", "B"]); // t1: Hub-A closed (maxDegree), Hub-B opens
  graph.reinforce(["Hub", "A"]); // t2: Hub-B closed, Hub-A reopens -- its t0-t1 window must not be overwritten

  assert.deepEqual(graph.getNeighbors("Hub").map((n) => [n.node, n.validFrom, n.invalidatedAt]), [["a", at(2), null]]);
  assert.deepEqual(graph.getNeighbors("Hub", { asOf: at(0) }).map((n) => [n.node, n.validFrom, n.invalidatedAt]), [["a", at(0), at(1)]]);
  assert.deepEqual(graph.getNeighbors("Hub", { asOf: at(1) }).map((n) => [n.node, n.validFrom, n.invalidatedAt]), [["b", at(1), at(2)]]);
  assert.deepEqual(graph.getNeighbors("Hub", { asOf: at(5) }).map((n) => n.node), ["a"]);
  graph.close();
});

test("opening a pre-#620 memory-graph.db migrates it in place without losing edges, and is idempotent", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const Database = require("better-sqlite3");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-graph-620-"));
  const dbPath = path.join(dir, "memory-graph.db");
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE memory_graph_edges (
      node_a TEXT NOT NULL, node_b TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0,
      last_reinforced_at TEXT NOT NULL, PRIMARY KEY (node_a, node_b)
    );
    INSERT INTO memory_graph_edges VALUES ('acme corp', 'beta corp', 3, '2026-01-01T00:00:00.000Z');
  `);
  old.close();

  try {
    for (let i = 0; i < 2; i++) {
      const graph = createMemoryGraph({ dbPath });
      assert.deepEqual(graph.getNeighbors("Acme Corp"), [
        { node: "beta corp", weight: 3, validFrom: "2026-01-01T00:00:00.000Z", invalidatedAt: null },
      ]);
      graph.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maxEdges closes the lowest-weight edge's window, and closed windows are themselves capped", () => {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const graph = createMemoryGraph({ dbPath: ":memory:", maxEdges: 1, maxDegree: 100, now });
  graph.reinforce(["A", "B"]); // t0
  graph.reinforce(["A", "C"]); // t1: A-B closed
  graph.reinforce(["A", "D"]); // t2: A-C closed; A-B's closed window pruned (cap 1)

  assert.deepEqual(graph.getNeighbors("A").map((n) => n.node), ["d"]);
  assert.deepEqual(graph.getNeighbors("A", { asOf: at(1) }).map((n) => [n.node, n.invalidatedAt]), [["c", at(2)]]);
  assert.deepEqual(graph.getNeighbors("A", { asOf: at(0) }), [], "the oldest closed window is past the cap");
  graph.close();
});
