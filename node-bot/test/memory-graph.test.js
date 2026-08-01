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
