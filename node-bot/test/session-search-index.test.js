const assert = require("node:assert/strict");
const test = require("node:test");

const { createSessionSearchIndex } = require("../session-search-index");

function makeIndex() {
  return createSessionSearchIndex({ dbPath: ":memory:" });
}

test("indexTurn stores user and assistant text separately, searchable by keyword", () => {
  const index = makeIndex();
  index.indexTurn({
    sessionId: "s1",
    turn: { at: "2026-01-01T00:00:00.000Z", user: "How do I deploy with Docker", assistant: "Use docker compose up" },
  });

  const results = index.search({ query: "docker" });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.role).sort(), ["assistant", "user"]);
  index.close();
});

test("indexTurn skips empty turns and half-empty turns index only the present side", () => {
  const index = makeIndex();
  index.indexTurn({ sessionId: "s1", turn: { at: "t", user: "", assistant: "" } });
  assert.deepEqual(index.search({ query: "anything" }), []);

  index.indexTurn({ sessionId: "s1", turn: { at: "t", user: "just a question", assistant: "" } });
  const results = index.search({ query: "question" });
  assert.equal(results.length, 1);
  assert.equal(results[0].role, "user");
  index.close();
});

test("search supports FTS5 query syntax: phrases, boolean, prefix", () => {
  const index = makeIndex();
  index.indexTurn({ sessionId: "s1", turn: { at: "t1", user: "deploying to kubernetes", assistant: "" } });
  index.indexTurn({ sessionId: "s2", turn: { at: "t2", user: "deploying to docker swarm", assistant: "" } });
  index.indexTurn({ sessionId: "s3", turn: { at: "t3", user: "python unit testing", assistant: "" } });

  assert.equal(index.search({ query: "deploy*" }).length, 2);
  assert.equal(index.search({ query: "kubernetes OR swarm" }).length, 2);
  assert.equal(index.search({ query: "deploying NOT docker" }).length, 1);
  assert.equal(index.search({ query: '"unit testing"' }).length, 1);
  index.close();
});

test("search filters by sessionId and role, and sorts newest/oldest", () => {
  const index = makeIndex();
  index.indexTurn({ sessionId: "s1", turn: { at: "2026-01-01T00:00:00.000Z", user: "topic alpha", assistant: "reply alpha" } });
  index.indexTurn({ sessionId: "s2", turn: { at: "2026-01-02T00:00:00.000Z", user: "topic alpha again", assistant: "" } });

  assert.equal(index.search({ query: "alpha", sessionId: "s1" }).length, 2);
  assert.equal(index.search({ query: "alpha", roleFilter: ["assistant"] }).length, 1);

  const newest = index.search({ query: "alpha", sort: "newest" });
  assert.equal(newest[0].sessionId, "s2");
  const oldest = index.search({ query: "alpha", sort: "oldest" });
  assert.equal(oldest[0].sessionId, "s1");
  index.close();
});

test("search returns [] for an empty/missing query instead of throwing", () => {
  const index = makeIndex();
  assert.deepEqual(index.search({ query: "" }), []);
  assert.deepEqual(index.search({}), []);
  index.close();
});

test("search respects the limit parameter and clamps out-of-range values", () => {
  const index = makeIndex();
  for (let i = 0; i < 5; i += 1) {
    index.indexTurn({ sessionId: "s1", turn: { at: `t${i}`, user: `matchme entry ${i}`, assistant: "" } });
  }
  assert.equal(index.search({ query: "matchme", limit: 2 }).length, 2);
  // 0 is falsy, so `Number(limit) || 20` treats it the same as "unset" --
  // falls back to the default 20 (all 5 matches) rather than erroring.
  assert.equal(index.search({ query: "matchme", limit: 0 }).length, 5);
  index.close();
});

// Issue #263 part 1: hybrid keyword+vector search. embedDim: 4 keeps these
// deterministic and fast -- real usage is 384-dim (all-MiniLM-L6-v2), the
// dimension itself doesn't change any of this module's own logic.
function makeHybridIndex() {
  return createSessionSearchIndex({ dbPath: ":memory:", embedDim: 4 });
}

test("search finds a semantic match with zero keyword overlap when queryEmbedding is provided", (t) => {
  const index = makeHybridIndex();
  // sqlite-vec's platform binary is a genuinely optional dependency (see
  // package.json/CHANGELOG) -- unavailable in this environment means
  // vectorEnabled() is false and every hybrid test below degrades to
  // keyword-only, which is exactly the behavior this skip is confirming
  // rather than working around.
  if (!index.vectorEnabled()) {
    t.skip("sqlite-vec extension unavailable in this environment -- keyword-only fallback covered by other tests");
    index.close();
    return;
  }

  const turn = { at: "t1", user: "How do I deploy with Docker", assistant: "Use docker compose up" };
  index.indexTurn({ sessionId: "s1", turn });
  index.indexEmbedding({ sessionId: "s1", turn, embedding: [1, 0, 0, 0] });

  // "containerization orchestration" shares zero words with the indexed
  // turn, so keyword search alone would find nothing.
  assert.deepEqual(index.search({ query: "containerization orchestration" }), []);

  const hybrid = index.search({ query: "containerization orchestration", queryEmbedding: [0.9, 0.1, 0, 0] });
  assert.equal(hybrid.length, 1);
  assert.equal(hybrid[0].matchType, "semantic");
  assert.equal(hybrid[0].role, "turn");
  assert.match(hybrid[0].text, /docker/i);
  index.close();
});

test("queryEmbedding is ignored (keyword-only behavior) for newest/oldest sort and an explicit roleFilter", () => {
  const index = makeHybridIndex();
  const turn = { at: "t1", user: "unrelated words entirely", assistant: "nothing shared" };
  index.indexTurn({ sessionId: "s1", turn });
  index.indexEmbedding({ sessionId: "s1", turn, embedding: [1, 0, 0, 0] });

  assert.deepEqual(
    index.search({ query: "containerization", queryEmbedding: [1, 0, 0, 0], sort: "newest" }),
    [],
  );
  assert.deepEqual(
    index.search({ query: "containerization", queryEmbedding: [1, 0, 0, 0], roleFilter: ["user"] }),
    [],
  );
  index.close();
});

test("vector search respects the sessionId filter even when the nearest global neighbor is in a different session", (t) => {
  const index = makeHybridIndex();
  if (!index.vectorEnabled()) {
    t.skip("sqlite-vec extension unavailable in this environment");
    index.close();
    return;
  }

  const otherTurn = { at: "t1", user: "s2's own unrelated turn", assistant: "" };
  index.indexTurn({ sessionId: "s2", turn: otherTurn });
  index.indexEmbedding({ sessionId: "s2", turn: otherTurn, embedding: [1, 0, 0, 0] }); // closest to the query

  const ownTurn = { at: "t2", user: "s1's own less-close turn", assistant: "" };
  index.indexTurn({ sessionId: "s1", turn: ownTurn });
  index.indexEmbedding({ sessionId: "s1", turn: ownTurn, embedding: [0.5, 0.5, 0, 0] }); // farther, but the only s1 candidate

  const results = index.search({
    query: "own",
    queryEmbedding: [0.9, 0.1, 0, 0],
    sessionId: "s1",
  });
  assert.ok(results.length >= 1);
  assert.ok(results.every((r) => r.sessionId === "s1"));
  index.close();
});

test("a semantic hit that near-duplicates an already-kept keyword hit is dropped by the diversity filter", (t) => {
  const index = makeHybridIndex();
  if (!index.vectorEnabled()) {
    t.skip("sqlite-vec extension unavailable in this environment");
    index.close();
    return;
  }

  const turn = {
    at: "t1",
    user: "How do I deploy my application with Docker containers",
    assistant: "Run docker compose up to deploy your application",
  };
  index.indexTurn({ sessionId: "s1", turn });
  index.indexEmbedding({ sessionId: "s1", turn, embedding: [1, 0, 0, 0] });

  // Query text keyword-matches the turn directly AND is semantically close
  // to it -- without dedup this would return the same turn's user line
  // (keyword) and its combined-text vector row (semantic) as two "results"
  // that are really the same underlying content.
  const results = index.search({ query: "docker deploy", queryEmbedding: [1, 0, 0, 0], limit: 5 });
  const semanticHits = results.filter((r) => r.matchType === "semantic");
  assert.equal(semanticHits.length, 0, "near-duplicate semantic hit should be filtered out");
  assert.ok(results.some((r) => r.matchType === "keyword"));
  index.close();
});

test("a queryEmbedding with the wrong dimension falls back to keyword-only results instead of throwing", () => {
  const index = makeHybridIndex();
  const turn = { at: "t1", user: "docker deployment question", assistant: "use compose" };
  index.indexTurn({ sessionId: "s1", turn });
  index.indexEmbedding({ sessionId: "s1", turn, embedding: [1, 0, 0, 0] });

  assert.doesNotThrow(() => {
    const results = index.search({ query: "docker", queryEmbedding: [1, 0] });
    assert.ok(results.length >= 1);
    assert.ok(results.every((r) => r.matchType === "keyword"));
  });
  index.close();
});

test("indexEmbedding silently skips an embedding whose dimension doesn't match this index's table", () => {
  const index = makeHybridIndex();
  const turn = { at: "t1", user: "docker deployment question", assistant: "use compose" };
  index.indexTurn({ sessionId: "s1", turn });
  assert.doesNotThrow(() => {
    index.indexEmbedding({ sessionId: "s1", turn, embedding: [1, 0] }); // wrong dim (2, not 4)
  });
  // Nothing indexed -- a query embedding that would match [1,0,0,0]-shaped
  // data finds no semantic hits, only the keyword one.
  const results = index.search({ query: "docker", queryEmbedding: [1, 0, 0, 0] });
  assert.ok(results.every((r) => r.matchType === "keyword"));
  index.close();
});

test("indexEmbedding and vector search are no-ops (never throw) when called before any turn exists, or with missing fields", () => {
  const index = makeHybridIndex();
  assert.doesNotThrow(() => index.indexEmbedding({}));
  assert.doesNotThrow(() => index.indexEmbedding({ sessionId: "s1" }));
  assert.deepEqual(index.search({ query: "anything", queryEmbedding: [1, 0, 0, 0] }), []);
  index.close();
});
