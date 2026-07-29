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
