const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");

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

// Issue #263 part 1: hybrid keyword+vector search. 4-dim fake vectors keep
// these deterministic and fast -- the table takes whatever dimension the
// embedder returns, so the dimension doesn't change any of this logic.
function makeHybridIndex() {
  return createSessionSearchIndex({ dbPath: ":memory:" });
}

// A fake computeEmbeddingsFn giving every text the same vector.
function fixedEmbedder(vector) {
  return async (texts) => texts.map(() => vector);
}

// The hybrid tests below skip when sqlite-vec can't load, so an install that
// drops its platform binary (node-bot/.npmrc's old omit=optional did exactly
// that) would turn them into silent skips. Fail loudly instead wherever
// sqlite-vec publishes a binary for this platform.
test("sqlite-vec loads wherever it publishes a platform binary", () => {
  const index = makeHybridIndex();
  try {
    const published = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];
    if (published.includes(`${process.platform}-${process.arch}`)) {
      assert.ok(index.vectorEnabled(), "sqlite-vec's platform package is missing -- was it installed with optional deps omitted?");
    }
  } finally {
    index.close();
  }
});

test("search finds a semantic match with zero keyword overlap when queryEmbedding is provided", async (t) => {
  const index = makeHybridIndex();
  // Unsupported platforms (no sqlite-vec binary) degrade to keyword-only;
  // the guard test above keeps this skip from hiding a broken install.
  if (!index.vectorEnabled()) {
    t.skip("sqlite-vec extension unavailable in this environment -- keyword-only fallback covered by other tests");
    index.close();
    return;
  }

  const turn = { at: "t1", user: "How do I deploy with Docker", assistant: "Use docker compose up" };
  index.indexTurn({ sessionId: "s1", turn });
  await index.syncEmbeddings(fixedEmbedder([1, 0, 0, 0]));

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

test("queryEmbedding is ignored (keyword-only behavior) for newest/oldest sort and an explicit roleFilter", async () => {
  const index = makeHybridIndex();
  const turn = { at: "t1", user: "unrelated words entirely", assistant: "nothing shared" };
  index.indexTurn({ sessionId: "s1", turn });
  await index.syncEmbeddings(fixedEmbedder([1, 0, 0, 0]));

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

test("vector search respects the sessionId filter even when the nearest global neighbor is in a different session", async (t) => {
  const index = makeHybridIndex();
  if (!index.vectorEnabled()) {
    t.skip("sqlite-vec extension unavailable in this environment");
    index.close();
    return;
  }

  const otherTurn = { at: "t1", user: "s2's own unrelated turn", assistant: "" };
  index.indexTurn({ sessionId: "s2", turn: otherTurn });
  await index.syncEmbeddings(fixedEmbedder([1, 0, 0, 0])); // closest to the query

  const ownTurn = { at: "t2", user: "s1's own less-close turn", assistant: "" };
  index.indexTurn({ sessionId: "s1", turn: ownTurn });
  await index.syncEmbeddings(fixedEmbedder([0.5, 0.5, 0, 0])); // farther, but the only s1 candidate

  const results = index.search({
    query: "own",
    queryEmbedding: [0.9, 0.1, 0, 0],
    sessionId: "s1",
  });
  assert.ok(results.length >= 1);
  assert.ok(results.every((r) => r.sessionId === "s1"));
  index.close();
});

test("a semantic hit that near-duplicates an already-kept keyword hit is dropped by the diversity filter", async (t) => {
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
  await index.syncEmbeddings(fixedEmbedder([1, 0, 0, 0]));

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

test("a queryEmbedding with the wrong dimension falls back to keyword-only results instead of throwing", async () => {
  const index = makeHybridIndex();
  const turn = { at: "t1", user: "docker deployment question", assistant: "use compose" };
  index.indexTurn({ sessionId: "s1", turn });
  await index.syncEmbeddings(fixedEmbedder([1, 0, 0, 0]));

  assert.doesNotThrow(() => {
    const results = index.search({ query: "docker", queryEmbedding: [1, 0] });
    assert.ok(results.length >= 1);
    assert.ok(results.every((r) => r.matchType === "keyword"));
  });
  index.close();
});

test("syncEmbeddings and vector search are no-ops (never throw) with no turns, no embedder, or an unavailable embedder", async (t) => {
  const index = makeHybridIndex();
  await index.syncEmbeddings(fixedEmbedder([1, 0, 0, 0])); // no turns yet
  await index.syncEmbeddings(undefined);
  assert.deepEqual(index.search({ query: "anything", queryEmbedding: [1, 0, 0, 0] }), []);

  index.indexTurn({ sessionId: "s1", turn: { at: "t1", user: "docker question", assistant: "" } });
  await index.syncEmbeddings(fixedEmbedder(null)); // embedder unreachable
  await index.syncEmbeddings(async () => {
    throw new Error("embedder down");
  });
  let results = index.search({ query: "docker", queryEmbedding: [1, 0, 0, 0] });
  assert.ok(results.length && results.every((r) => r.matchType === "keyword"));

  if (!index.vectorEnabled()) {
    t.skip("sqlite-vec extension unavailable in this environment");
    index.close();
    return;
  }
  // The failed runs left the turn pending, so the next working run embeds it.
  await index.syncEmbeddings(fixedEmbedder([1, 0, 0, 0]));
  results = index.search({ query: "containerization", queryEmbedding: [1, 0, 0, 0] });
  assert.equal(results.length, 1);
  assert.equal(results[0].matchType, "semantic");
  index.close();
});

// Issue #263: every existing install has a 384-dim turns_vec (the old
// hard-coded size) with a few legacy vectors and no model row, next to the
// FTS rows that must never be touched.
function makeLegacyDb(dbPath, turnCount) {
  const db = new Database(dbPath);
  db.loadExtension(require("sqlite-vec").getLoadablePath());
  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(sessionId UNINDEXED, role UNINDEXED, text, at UNINDEXED);
    CREATE VIRTUAL TABLE turns_vec USING vec0(embedding float[384] distance_metric=cosine);
    CREATE TABLE turns_vec_meta (rowid INTEGER PRIMARY KEY, sessionId TEXT, text TEXT, at TEXT);
  `);
  const fts = db.prepare("INSERT INTO messages_fts (sessionId, role, text, at) VALUES (?, ?, ?, ?)");
  fts.run("s0", "user", "a question nobody answered", "t-solo"); // shifts turns across page edges
  for (let i = 0; i < turnCount; i += 1) {
    fts.run("s1", "user", `question about topic${i}`, `t${i}`);
    fts.run("s1", "assistant", `answer number ${i}`, `t${i}`);
  }
  for (let i = 1; i <= 3; i += 1) {
    const info = db
      .prepare("INSERT INTO turns_vec (embedding) VALUES (vec_f32(?))")
      .run(JSON.stringify(Array(384).fill(0.1)));
    db.prepare("INSERT INTO turns_vec_meta (rowid, sessionId, text, at) VALUES (?, ?, ?, ?)")
      .run(info.lastInsertRowid, "s1", `legacy vector ${i}`, `t${i}`);
  }
  db.close();
}

// Read-only look at what's on disk, through a second connection.
function inspect(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      fts: db.prepare("SELECT rowid, sessionId, role, text, at FROM messages_fts ORDER BY rowid").all(),
      vecSql: db.prepare("SELECT sql FROM sqlite_master WHERE name = 'turns_vec'").get()?.sql,
      metaTexts: db.prepare("SELECT text FROM turns_vec_meta ORDER BY rowid").all().map((r) => r.text),
      model: db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'turns_vec_model'").get()
        ? db.prepare("SELECT model, dims, cursor FROM turns_vec_model").get()
        : undefined,
    };
  } finally {
    db.close();
  }
}

// One-hot 1024-dim vectors (Qwen3-Embedding-0.6B's size), keyed by the
// topic number in the text, so a query can find one specific turn.
function oneHot1024(n) {
  const v = Array(1024).fill(0);
  v[n] = 1;
  return v;
}
function topicEmbedder(batchSizes = []) {
  return async (texts) => {
    batchSizes.push(texts.length);
    return texts.map((text) => oneHot1024(Number(/topic(\d+)/.exec(text)?.[1] ?? 1023)));
  };
}

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-session-search-"));
  return { dir, dbPath: path.join(dir, "session-search.db") };
}

test("a DB with today's 384-dim table is rebuilt at the embedder's 1024 dims, FTS rows untouched (#263)", async (t) => {
  const { dir, dbPath } = tempDbPath();
  const probe = createSessionSearchIndex({ dbPath: ":memory:" });
  const vecAvailable = probe.vectorEnabled();
  probe.close();
  if (!vecAvailable) {
    t.skip("sqlite-vec extension unavailable in this environment");
    return;
  }
  makeLegacyDb(dbPath, 20);
  const before = inspect(dbPath);

  const index = createSessionSearchIndex({ dbPath });
  // Opening alone changes nothing about the vectors -- the model is only
  // known once the embedder answers.
  assert.match(inspect(dbPath).vecSql, /float\[384\]/);
  const batchSizes = [];
  await index.syncEmbeddings(topicEmbedder(batchSizes));

  const hits = index.search({ query: "unrelatedword", queryEmbedding: oneHot1024(7) });
  assert.equal(hits[0].matchType, "semantic");
  assert.match(hits[0].text, /topic7\n/);
  assert.match(hits[0].text, /Assistant: answer number 7/);
  assert.equal(index.search({ query: "topic7" })[0].matchType, "keyword");
  index.close();

  const after = inspect(dbPath);
  assert.deepEqual(after.fts, before.fts, "session history (FTS rows) must be untouched");
  assert.match(after.vecSql, /float\[1024\]/);
  assert.equal(after.metaTexts.length, 21, "one vector per turn, no duplicates across pages");
  assert.equal(new Set(after.metaTexts).size, 21);
  assert.ok(!after.metaTexts.some((text) => text.includes("legacy")), "legacy 384-dim rows dropped");
  assert.deepEqual(after.model, { model: "", dims: 1024, cursor: before.fts.length });
  assert.ok(batchSizes.every((n) => n <= 16), `bounded batches, got ${batchSizes}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an interrupted re-index resumes from its cursor, and model switches back and forth never mix vectors (#263)", async (t) => {
  const { dir, dbPath } = tempDbPath();
  let index = createSessionSearchIndex({ dbPath });
  if (!index.vectorEnabled()) {
    t.skip("sqlite-vec extension unavailable in this environment");
    index.close();
    return;
  }
  let turns = 0;
  const addTurn = () => {
    index.indexTurn({
      sessionId: "s1",
      turn: { at: `t${turns}`, user: `question about topic${turns}`, assistant: `answer number ${turns}` },
    });
    turns += 1;
  };
  for (let i = 0; i < 20; i += 1) addTurn();

  // The embedder dies after the first page -- then the process restarts.
  let calls = 0;
  await index.syncEmbeddings(async (texts) => texts.map(() => (calls++ < texts.length ? [1, 0, 0, 0] : null)), () => "llama:a.gguf");
  const firstPage = inspect(dbPath).metaTexts;
  assert.ok(firstPage.length > 0 && firstPage.length < 20);
  index.close();

  index = createSessionSearchIndex({ dbPath });
  const resumedTexts = [];
  await index.syncEmbeddings(async (texts) => {
    resumedTexts.push(...texts);
    return texts.map(() => [1, 0, 0, 0]);
  }, () => "llama:a.gguf");
  assert.ok(!resumedTexts.some((text) => firstPage.includes(text)), "resumed after the cursor, not from the start");
  assert.equal(new Set(inspect(dbPath).metaTexts).size, 20);

  // Switching model (same dims), dims, and back again: the switch shows up
  // with the next turn, and each one rebuilds the whole table for that model.
  for (const [model, vector] of [
    ["llama:b.gguf", [0, 1, 0, 0]],
    ["", [0, 0, 1]],
    ["llama:a.gguf", [1, 0, 0, 0]],
  ]) {
    addTurn();
    await index.syncEmbeddings(fixedEmbedder(vector), () => model);
    const state = inspect(dbPath);
    assert.deepEqual(state.model, { model, dims: vector.length, cursor: turns * 2 });
    assert.match(state.vecSql, new RegExp(`float\\[${vector.length}\\]`));
    assert.equal(state.metaTexts.length, turns);
    assert.equal(new Set(state.metaTexts).size, turns);
    const semantic = (queryModel) =>
      index
        .search({ query: "unrelatedword", queryEmbedding: vector, queryModel })
        .filter((r) => r.matchType === "semantic");
    assert.ok(semantic(model).length > 0);
    assert.equal(semantic("llama:other.gguf").length, 0, "a query from another model skips the vectors");
  }
  index.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an explicit oldest sort survives a time-only search (issue #337)", () => {
  const index = createSessionSearchIndex({ dbPath: ":memory:" });
  index.indexTurn({
    sessionId: "s1",
    turn: { at: "2026-05-01T00:00:00.000Z", user: "first", assistant: "" },
  });
  index.indexTurn({
    sessionId: "s1",
    turn: { at: "2026-05-02T00:00:00.000Z", user: "second", assistant: "" },
  });

  // No query at all -- the window is the whole search. "oldest" is a
  // request about ordering and must not be overridden by that.
  const results = index.search({
    since: "2026-04-01T00:00:00.000Z",
    until: "2026-06-01T00:00:00.000Z",
    sort: "oldest",
  });
  assert.equal(results[0].text, "first");
  index.close();
});

test("a search with neither query nor window returns nothing (issue #337)", () => {
  const index = createSessionSearchIndex({ dbPath: ":memory:" });
  index.indexTurn({
    sessionId: "s1",
    turn: { at: "2026-05-01T00:00:00.000Z", user: "anything", assistant: "" },
  });
  assert.deepEqual(index.search({ sessionId: "s1" }), []);
  index.close();
});
