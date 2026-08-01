const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAcpMemoryStore, extractEntities } = require("../acp-memory-store");
const { createSessionSearchIndex } = require("../session-search-index");
const { createMemoryGraph } = require("../memory-graph");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-acp-memory-"));
}

test("ACP memory store persists session turns across store instances", () => {
  const dataDir = createTempDir();
  const first = createAcpMemoryStore({
    dataDir,
    now: () => "2026-06-29T00:00:00.000Z",
  });

  first.ensureSession({
    sessionId: "zed-session-1",
    cwd: "C:\\ManaAI\\Mana",
    editor: "zed",
  });
  first.appendTurn({
    sessionId: "zed-session-1",
    user: "Remember that Mana uses the coding model in Zed.",
    assistant: "I will remember that for this local ACP session.",
  });

  const second = createAcpMemoryStore({ dataDir });
  const session = second.getSession("zed-session-1");

  assert.equal(session.sessionId, "zed-session-1");
  assert.equal(session.cwd, "C:\\ManaAI\\Mana");
  assert.equal(session.editor, "zed");
  assert.equal(session.turns.length, 1);
  assert.equal(
    session.turns[0].user,
    "Remember that Mana uses the coding model in Zed.",
  );
  assert.match(session.summary, /coding model in Zed/i);
});

test("ACP memory store builds a compact local memory prompt block", () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
    maxRecentTurns: 3,
    maxPromptChars: 1200,
  });

  store.ensureSession({ sessionId: "zed-session-2", cwd: "C:\\ManaAI\\Mana" });
  store.appendTurn({
    sessionId: "zed-session-2",
    user: "The preferred editor on this PC is Zed.",
    assistant: "Understood. I will prefer Zed locally.",
  });

  const promptBlock = store.buildPromptMemory("zed-session-2");

  assert.match(promptBlock, /Conversation memory/i);
  assert.match(promptBlock, /preferred editor on this PC is Zed/i);
  assert.match(promptBlock, /Recent turns/i);
  assert.ok(promptBlock.length <= 1200);
});

test("appendTurn auto-names a session from its first user turn", async () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
  });

  store.ensureSession({ sessionId: "session-auto-name" });
  await store.appendTurn({
    sessionId: "session-auto-name",
    user: "What is the best way to gather Iron Ore in FFXIV?",
    assistant: "Try the mining nodes in Central Thanalan.",
  });

  const session = store.getSession("session-auto-name");
  assert.equal(session.name, "What is the best way to gather Iron Ore in FFXIV?");

  await store.appendTurn({
    sessionId: "session-auto-name",
    user: "Anything else?",
    assistant: "Not right now.",
  });
  assert.equal(
    store.getSession("session-auto-name").name,
    "What is the best way to gather Iron Ore in FFXIV?",
  );
});

test("appendTurn truncates a long first message into a short auto-name", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  const longMessage = "a".repeat(120);

  store.ensureSession({ sessionId: "session-long-name" });
  await store.appendTurn({ sessionId: "session-long-name", user: longMessage, assistant: "ok" });

  const session = store.getSession("session-long-name");
  assert.equal(session.name.length, 61);
  assert.ok(session.name.endsWith("…"));
});

test("appendTurn persists toolCalls when provided, and omits the field entirely when not", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });

  await store.appendTurn({
    sessionId: "session-with-tools",
    user: "what's NVDA trading at",
    assistant: "NVDA is at $123.45",
    toolCalls: [{ name: "stock_quote", ok: true, args: { symbol: "NVDA" }, result: "123.45" }],
  });
  await store.appendTurn({
    sessionId: "session-with-tools",
    user: "thanks",
    assistant: "you're welcome",
  });

  const session = store.getSession("session-with-tools");
  assert.deepEqual(session.turns[0].toolCalls, [
    { name: "stock_quote", ok: true, args: { symbol: "NVDA" }, result: "123.45" },
  ]);
  assert.equal(session.turns[1].toolCalls, undefined);
});

test("searchSessions returns [] when no index was wired in", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  await store.appendTurn({ sessionId: "s1", user: "docker deployment question", assistant: "use compose" });
  assert.deepEqual(await store.searchSessions({ query: "docker" }), []);
});

test("appendTurn indexes turns into the wired sessionSearchIndex, searchable via searchSessions", async () => {
  const sessionSearchIndex = createSessionSearchIndex({ dbPath: ":memory:" });
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    sessionSearchIndex,
  });

  await store.appendTurn({
    sessionId: "s1",
    user: "How do I deploy with Docker",
    assistant: "Use docker compose up",
  });

  const results = await store.searchSessions({ query: "docker" });
  assert.equal(results.length, 2);
  assert.ok(results.some((r) => r.role === "user"));
  assert.ok(results.some((r) => r.role === "assistant"));
  sessionSearchIndex.close();
});

// Issue #295 (round-2 scoping of #285): appendTurn reinforces this turn's
// co-occurring entities in the memory graph, and searchSessions() surfaces
// associatively-linked memories as a second pass after the base
// keyword/semantic hits.
test("appendTurn reinforces co-occurring entities in the wired memory graph", async () => {
  const memoryGraph = createMemoryGraph({ dbPath: ":memory:" });
  const store = createAcpMemoryStore({ dataDir: createTempDir(), memoryGraph });

  await store.appendTurn({
    sessionId: "s1",
    user: "Alice Smith introduced me to Bob Jones at the conference.",
    assistant: "That sounds like a great connection to make.",
  });

  const neighbors = memoryGraph.getNeighbors("Alice Smith");
  assert.deepEqual(neighbors.map((n) => n.node), ["bob jones"]);
  memoryGraph.close();
});

test("searchSessions surfaces an associatively-linked entity from a different session with zero lexical overlap", async () => {
  const sessionSearchIndex = createSessionSearchIndex({ dbPath: ":memory:" });
  const memoryGraph = createMemoryGraph({ dbPath: ":memory:" });
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    sessionSearchIndex,
    memoryGraph,
  });

  // Assistant replies deliberately avoid a leading capitalized word --
  // extractEntities() (acp-memory-store.js) is a naive Title-Case-run
  // heuristic, not real NER, so a sentence-initial word like "Sounds" or
  // "Agreed" would itself get treated as a phantom entity and add noise
  // edges unrelated to what this test is actually checking.
  await store.appendTurn({
    sessionId: "s1",
    user: "Alice Smith and Bob Jones went hiking together.",
    assistant: "that sounds like fun",
  });
  await store.appendTurn({
    sessionId: "s2",
    user: "Bob Jones is a great software engineer.",
    assistant: "yes, very skilled indeed",
  });

  const results = await store.searchSessions({ query: "software engineer" });
  const associative = results.filter((r) => r.matchType === "associative");
  assert.equal(associative.length, 1);
  assert.match(associative[0].text, /Alice Smith/);
  assert.equal(associative[0].sessionId, "s1");

  sessionSearchIndex.close();
  memoryGraph.close();
});

test("searchSessions excludes an associative hit whose only mention is in the session being searched", async () => {
  const sessionSearchIndex = createSessionSearchIndex({ dbPath: ":memory:" });
  const memoryGraph = createMemoryGraph({ dbPath: ":memory:" });
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    sessionSearchIndex,
    memoryGraph,
  });

  await store.appendTurn({
    sessionId: "s1",
    user: "Alice Smith and Bob Jones went hiking together.",
    assistant: "that sounds like fun",
  });

  const results = await store.searchSessions({ query: "Bob Jones", sessionId: "s1" });
  assert.ok(!results.some((r) => r.matchType === "associative"));

  sessionSearchIndex.close();
  memoryGraph.close();
});

test("searchSessions never includes associative results when no memory graph was wired", async () => {
  const sessionSearchIndex = createSessionSearchIndex({ dbPath: ":memory:" });
  const store = createAcpMemoryStore({ dataDir: createTempDir(), sessionSearchIndex });

  await store.appendTurn({
    sessionId: "s1",
    user: "Alice Smith and Bob Jones went hiking together.",
    assistant: "Sounds fun!",
  });

  const results = await store.searchSessions({ query: "Alice Smith" });
  assert.ok(!results.some((r) => r.matchType === "associative"));
  sessionSearchIndex.close();
});

test("searchSessions falls back to the base results when the memory graph lookup throws", async () => {
  const sessionSearchIndex = createSessionSearchIndex({ dbPath: ":memory:" });
  const brokenMemoryGraph = {
    reinforce: () => {},
    getNeighbors: () => {
      throw new Error("graph unavailable");
    },
  };
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    sessionSearchIndex,
    memoryGraph: brokenMemoryGraph,
  });

  await store.appendTurn({
    sessionId: "s1",
    user: "Alice Smith and Bob Jones went hiking together.",
    assistant: "Sounds fun!",
  });

  const results = await store.searchSessions({ query: "Alice Smith" });
  assert.ok(results.length > 0, "the base keyword results must still come back");
  assert.ok(!results.some((r) => r.matchType === "associative"));
  sessionSearchIndex.close();
});

test("appendTurn never breaks the turn append when memory graph reinforcement throws", async () => {
  const brokenMemoryGraph = {
    reinforce: () => {
      throw new Error("db locked");
    },
    getNeighbors: () => [],
  };
  const store = createAcpMemoryStore({ dataDir: createTempDir(), memoryGraph: brokenMemoryGraph });

  const saved = await store.appendTurn({
    sessionId: "s1",
    user: "Alice Smith and Bob Jones went hiking together.",
    assistant: "Sounds fun!",
  });
  assert.equal(saved.turns.length, 1);
});

// Issue #263 part 1: hybrid keyword+vector session search. appendTurn's
// embedding indexing is fire-and-forget (mirrors part 2's compaction IIFE
// above), so these tests use the same deferred-promise pattern to await it
// actually completing rather than just the appendTurn call that triggered
// it. embedDim: 3 keeps this fast/deterministic -- see
// session-search-index.test.js for the real 384-dim default and this
// module's own merge/diversity logic, already covered there; these tests
// only cover the wiring between acp-memory-store.js and that module.
test("appendTurn computes and indexes an embedding for the turn via the wired computeEmbeddingsFn", async (t) => {
  const sessionSearchIndex = createSessionSearchIndex({ dbPath: ":memory:", embedDim: 3 });
  if (!sessionSearchIndex.vectorEnabled()) {
    t.skip("sqlite-vec extension unavailable in this environment");
    sessionSearchIndex.close();
    return;
  }
  const embeddingIndexed = deferred();
  let capturedText = null;
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    sessionSearchIndex,
    computeEmbeddingsFn: async (texts) => {
      capturedText = texts[0];
      return [[1, 0, 0]];
    },
  });

  // Wrap indexEmbedding so the test can await the fire-and-forget call
  // actually landing, without changing what it does.
  const realIndexEmbedding = sessionSearchIndex.indexEmbedding;
  sessionSearchIndex.indexEmbedding = (args) => {
    const result = realIndexEmbedding(args);
    embeddingIndexed.resolve();
    return result;
  };

  await store.appendTurn({ sessionId: "s1", user: "How do I deploy with Docker", assistant: "Use docker compose up" });
  await embeddingIndexed.promise;

  assert.match(capturedText, /User: How do I deploy with Docker/);
  assert.match(capturedText, /Assistant: Use docker compose up/);

  const semanticResults = sessionSearchIndex.search({
    query: "containerization orchestration", // zero keyword overlap
    queryEmbedding: [0.9, 0.1, 0],
  });
  assert.equal(semanticResults.length, 1);
  assert.equal(semanticResults[0].matchType, "semantic");
  sessionSearchIndex.close();
});

test("appendTurn never breaks the turn append when computeEmbeddingsFn rejects", async () => {
  const sessionSearchIndex = createSessionSearchIndex({ dbPath: ":memory:", embedDim: 3 });
  const attempted = deferred();
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    sessionSearchIndex,
    computeEmbeddingsFn: async () => {
      attempted.resolve();
      throw new Error("embedder unavailable");
    },
  });

  const session = await store.appendTurn({ sessionId: "s1", user: "docker question", assistant: "docker answer" });
  await attempted.promise;

  assert.equal(session.turns.length, 1);
  // Keyword search still works even though the embedding call failed.
  const results = await store.searchSessions({ query: "docker" });
  assert.ok(results.length >= 1);
  sessionSearchIndex.close();
});

test("searchSessions computes a query embedding via computeEmbeddingsFn and blends it into the results", async (t) => {
  const sessionSearchIndex = createSessionSearchIndex({ dbPath: ":memory:", embedDim: 3 });
  if (!sessionSearchIndex.vectorEnabled()) {
    t.skip("sqlite-vec extension unavailable in this environment");
    sessionSearchIndex.close();
    return;
  }
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    sessionSearchIndex,
    computeEmbeddingsFn: async (texts) => {
      // The write-path turn text and the read-path query text get the same
      // fixed vector here purely so this test can assert a semantic match
      // without depending on any real embedding model's behavior.
      return [[1, 0, 0]];
    },
  });

  await store.appendTurn({ sessionId: "s1", user: "How do I deploy with Docker", assistant: "Use docker compose up" });
  // appendTurn's own embedding indexing is fire-and-forget -- give it a
  // turn of the event loop plus the actual async computeEmbeddingsFn call
  // inside it a chance to land before searching.
  await new Promise((r) => setImmediate(r));

  const results = await store.searchSessions({ query: "containerization orchestration" });
  assert.ok(results.some((r) => r.matchType === "semantic"));
  sessionSearchIndex.close();
});

test("searchSessions falls back to keyword-only results when computeEmbeddingsFn isn't wired", async () => {
  const sessionSearchIndex = createSessionSearchIndex({ dbPath: ":memory:", embedDim: 3 });
  const store = createAcpMemoryStore({ dataDir: createTempDir(), sessionSearchIndex });

  await store.appendTurn({ sessionId: "s1", user: "How do I deploy with Docker", assistant: "Use docker compose up" });
  const results = await store.searchSessions({ query: "docker" });
  assert.ok(results.length >= 1);
  assert.ok(results.every((r) => r.matchType === "keyword"));
  sessionSearchIndex.close();
});

test("a broken sessionSearchIndex.indexTurn never breaks appendTurn itself", async () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    sessionSearchIndex: {
      indexTurn: () => {
        throw new Error("index is down");
      },
      search: () => [],
    },
  });

  const session = await store.appendTurn({
    sessionId: "s1",
    user: "hello",
    assistant: "hi there",
  });
  assert.equal(session.turns.length, 1);
});

test("appendTurn ignores an empty toolCalls array rather than storing it", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  await store.appendTurn({
    sessionId: "session-empty-tools",
    user: "hi",
    assistant: "hello",
    toolCalls: [],
  });
  assert.equal(store.getSession("session-empty-tools").turns[0].toolCalls, undefined);
});

test("renameSession overrides the stored name and returns null for unknown sessions", () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
  });

  store.ensureSession({ sessionId: "session-rename" });
  const renamed = store.renameSession("session-rename", "  FFXIV crafting plan  ");
  assert.equal(renamed.name, "FFXIV crafting plan");
  assert.equal(store.getSession("session-rename").name, "FFXIV crafting plan");

  assert.equal(store.renameSession("does-not-exist", "x"), null);
});

test("deleteSession removes a session and reports whether it existed", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.ensureSession({ sessionId: "session-delete" });

  assert.equal(store.deleteSession("session-delete"), true);
  assert.equal(store.getSession("session-delete"), null);
  assert.equal(store.deleteSession("session-delete"), false);
});

test("listSessions returns session metadata sorted by most recently updated", () => {
  let clock = 0;
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => {
      clock += 1;
      return `2026-06-29T00:00:0${clock}.000Z`;
    },
  });

  store.ensureSession({ sessionId: "session-a" });
  store.ensureSession({ sessionId: "session-b" });
  store.renameSession("session-b", "Newest session");

  const sessions = store.listSessions();
  assert.deepEqual(
    sessions.map((s) => s.sessionId),
    ["session-b", "session-a"],
  );
  assert.equal(sessions[0].name, "Newest session");
  assert.equal(sessions[1].turnCount, 0);
});

test("appendTurn keeps full turn history instead of capping at maxRecentTurns", async () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
    maxRecentTurns: 3,
  });

  for (let i = 0; i < 5; i += 1) {
    await store.appendTurn({ sessionId: "session-full-history", user: `msg ${i}`, assistant: `reply ${i}` });
  }

  const session = store.getSession("session-full-history");
  assert.equal(session.turns.length, 5);
  assert.equal(session.turns[0].user, "msg 0");
  assert.equal(session.turns[4].user, "msg 4");
});

test("getSessionTurnsPage pages a session's turns oldest-first, newest page by default", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });

  for (let i = 0; i < 25; i += 1) {
    await store.appendTurn({ sessionId: "session-paged", user: `msg ${i}`, assistant: `reply ${i}` });
  }

  const latest = store.getSessionTurnsPage("session-paged", { limit: 20 });
  assert.equal(latest.turns.length, 20);
  assert.equal(latest.turns[0].user, "msg 5");
  assert.equal(latest.turns[19].user, "msg 24");
  assert.equal(latest.hasMore, true);
  assert.equal(latest.nextBefore, 5);
  assert.equal(latest.total, 25);

  const older = store.getSessionTurnsPage("session-paged", { before: latest.nextBefore, limit: 20 });
  assert.equal(older.turns.length, 5);
  assert.equal(older.turns[0].user, "msg 0");
  assert.equal(older.turns[4].user, "msg 4");
  assert.equal(older.hasMore, false);
  assert.equal(older.nextBefore, 0);
});

test("getSessionTurnsPage returns null for an unknown session", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  assert.equal(store.getSessionTurnsPage("does-not-exist"), null);
});

// Entity tagging (issue #78): pure pattern matching, zero LLM calls.

test("extractEntities finds multi-word Title Case entities without a stopword check", () => {
  const entities = extractEntities(
    "We discussed Acme Corp and New York over lunch with John Smith.",
  );
  assert.ok(entities.includes("Acme Corp"));
  assert.ok(entities.includes("New York"));
  assert.ok(entities.includes("John Smith"));
});

test("extractEntities filters common stopwords when they're the only capitalized word", () => {
  const entities = extractEntities("The plan is solid. What do you think?");
  assert.ok(!entities.includes("The"));
  assert.ok(!entities.includes("What"));
});

test("extractEntities keeps a real single-word proper noun", () => {
  const entities = extractEntities("Have you tried FFXIV yet?");
  assert.ok(entities.includes("FFXIV"));
});

test("entity index is retrievable across sessions that mention the same entity", () => {
  const dataDir = createTempDir();
  const store = createAcpMemoryStore({
    dataDir,
    now: () => "2026-06-29T00:00:00.000Z",
  });

  store.appendTurn({
    sessionId: "session-a",
    user: "Let's talk about Acme Corp's roadmap.",
    assistant: "Sure, what about Acme Corp interests you?",
  });
  store.appendTurn({
    sessionId: "session-b",
    user: "Following up on Acme Corp from last week.",
    assistant: "Got it, continuing on Acme Corp.",
  });

  const mentions = store.lookupEntity("acme corp");
  const sessionIds = new Set(mentions.map((m) => m.sessionId));
  assert.ok(sessionIds.has("session-a"));
  assert.ok(sessionIds.has("session-b"));
});

test("entity lookup is case-insensitive and returns nothing for an unmentioned entity", () => {
  const dataDir = createTempDir();
  const store = createAcpMemoryStore({
    dataDir,
    now: () => "2026-06-29T00:00:00.000Z",
  });

  store.appendTurn({
    sessionId: "session-a",
    user: "New York is a great city.",
    assistant: "It really is.",
  });

  assert.equal(store.lookupEntity("NEW YORK").length, 1);
  assert.deepEqual(store.lookupEntity("Nonexistent Place"), []);
});

test("getRelatedFacts surfaces an entity mentioned in a different session", () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
  });

  store.appendTurn({
    sessionId: "session-a",
    user: "Let's talk about Acme Corp's roadmap.",
    assistant: "Sure thing.",
  });

  const facts = store.getRelatedFacts("What did we say about Acme Corp?", {
    excludeSessionId: "session-b",
  });
  assert.match(facts, /Related from other sessions/i);
  assert.match(facts, /Acme Corp/);
});

test("getRelatedFacts excludes mentions from the current session", () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
  });

  store.appendTurn({
    sessionId: "session-a",
    user: "Acme Corp again.",
    assistant: "Noted.",
  });

  assert.equal(
    store.getRelatedFacts("Acme Corp?", { excludeSessionId: "session-a" }),
    "",
  );
});

test("getRelatedFacts returns empty for text with no known entities or no mentions", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  assert.equal(store.getRelatedFacts("what time is it?"), "");
  assert.equal(store.getRelatedFacts("Tell me about Wakanda"), "");
});

test("getRelatedFacts stays within maxChars regardless of how many entities match", () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
  });

  store.appendTurn({
    sessionId: "session-a",
    user: "Acme Corp, Beta Corp, and Gamma Corp all merged with Delta Corp.",
    assistant: "Big news.",
  });

  const facts = store.getRelatedFacts(
    "Update me on Acme Corp, Beta Corp, Gamma Corp, and Delta Corp.",
    { excludeSessionId: "session-b", maxEntities: 4, maxChars: 60 },
  );
  assert.ok(facts.length <= 60);
});

test("entity index survives across separate store instances (persisted to disk)", () => {
  const dataDir = createTempDir();
  const first = createAcpMemoryStore({
    dataDir,
    now: () => "2026-06-29T00:00:00.000Z",
  });
  first.appendTurn({
    sessionId: "session-a",
    user: "Talking about Acme Corp again.",
    assistant: "Noted.",
  });

  const second = createAcpMemoryStore({ dataDir });
  assert.equal(second.lookupEntity("Acme Corp").length, 1);
});

test("rememberFact requires a key, and text for insert/patch", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  assert.throws(() => store.rememberFact({ text: "no key" }), /key is required/);
  assert.throws(
    () => store.rememberFact({ key: "GPU" }),
    /text is required for insert\/patch/,
  );
});

test("rememberFact insert (default action) creates a new active fact", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  const result = store.rememberFact({
    sessionId: "session-a",
    key: "the user's GPU",
    text: "The user has an RTX 3070 Ti, upgrading to a 5080 soon.",
  });
  assert.deepEqual(result, {
    ok: true,
    action: "insert",
    key: "the user's GPU",
    text: "The user has an RTX 3070 Ti, upgrading to a 5080 soon.",
  });
});

test("rememberFact patch updates the existing active fact with the same key", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "the user's GPU", text: "RTX 3070 Ti" });
  const patched = store.rememberFact({
    key: "the user's GPU",
    text: "RTX 5080, upgraded",
    action: "patch",
  });
  assert.equal(patched.action, "patch");

  const surfaced = store.getRelatedFacts("what's the user's GPU these days?");
  assert.match(surfaced, /RTX 5080, upgraded/);
  assert.doesNotMatch(surfaced, /RTX 3070 Ti/);
});

test("rememberFact patch keeps a bounded correction history instead of discarding the prior text (issue #273)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "favorite color", text: "blue" });
  store.rememberFact({ key: "favorite color", text: "green", action: "patch" });
  store.rememberFact({ key: "favorite color", text: "purple", action: "patch" });

  const facts = JSON.parse(
    require("node:fs").readFileSync(
      require("node:path").join(store.dataDir, "facts.json"),
      "utf8",
    ),
  ).facts;
  const fact = facts.find((f) => f.key === "favorite color");
  assert.equal(fact.text, "purple");
  assert.deepEqual(
    fact.history.map((h) => h.text),
    ["blue", "green"],
  );
});

test("rememberFact insert flags a possible conflict when the new fact overlaps an existing differently-keyed fact, without overwriting it", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({
    key: "the user's GPU",
    text: "the user's graphics card is an RTX 3070 Ti",
  });
  const result = store.rememberFact({
    key: "graphics card model",
    text: "the user's graphics card is now an RTX 5080",
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "insert");
  assert.ok(result.possibleConflict, "expected a possibleConflict hint");
  assert.equal(result.possibleConflict.key, "the user's GPU");

  // Never auto-overwrites -- both facts still exist and are both surfaced.
  const surfaced = store.getRelatedFacts(
    "remind me about the user's GPU and graphics card model please",
  );
  assert.match(surfaced, /3070 Ti/);
  assert.match(surfaced, /5080/);
});

test("rememberFact insert reports no possibleConflict for genuinely unrelated facts", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "favorite color", text: "the user likes blue" });
  const result = store.rememberFact({ key: "gaming schedule", text: "plays FFXIV in the evenings" });
  assert.equal("possibleConflict" in result, false);
});

test("rememberFact archive marks a fact archived (distinct from stale) and it stops auto-surfacing but isn't deleted (issue #277)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "Old Project", text: "still true, just not relevant right now" });
  const archived = store.rememberFact({ key: "Old Project", action: "archive" });
  assert.deepEqual(archived, { ok: true, action: "archive", key: "Old Project", found: true });

  // Archived facts stop auto-surfacing via getRelatedFacts...
  assert.equal(store.getRelatedFacts("tell me about Old Project"), "");
  // ...and stop appearing in listFactKeys' tool-description index...
  assert.deepEqual(store.listFactKeys(), []);
  // ...but the underlying data is preserved, not deleted.
  const facts = JSON.parse(
    require("node:fs").readFileSync(
      require("node:path").join(store.dataDir, "facts.json"),
      "utf8",
    ),
  ).facts;
  const fact = facts.find((f) => f.key === "Old Project");
  assert.equal(fact.status, "archived");
  assert.equal(fact.text, "still true, just not relevant right now");

  const archivedAgain = store.rememberFact({ key: "Never Existed", action: "archive" });
  assert.deepEqual(archivedAgain, {
    ok: true,
    action: "archive",
    key: "Never Existed",
    found: false,
  });
});

test("rememberFact patch falls back to insert when nothing exists yet to patch", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  const result = store.rememberFact({
    key: "New Fact",
    text: "first time seeing this",
    action: "patch",
  });
  assert.equal(result.action, "insert");
});

test("rememberFact remove marks the fact stale so it stops surfacing, and reports found:false for an unknown key", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "Old Fact", text: "no longer true" });
  const removed = store.rememberFact({ key: "Old Fact", action: "remove" });
  assert.deepEqual(removed, { ok: true, action: "remove", key: "Old Fact", found: true });
  assert.equal(store.getRelatedFacts("tell me about Old Fact"), "");

  const removedAgain = store.rememberFact({ key: "Never Existed", action: "remove" });
  assert.deepEqual(removedAgain, {
    ok: true,
    action: "remove",
    key: "Never Existed",
    found: false,
  });
});

test("listFactKeys returns only active facts' key+short preview, not removed ones", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "the user's GPU", text: "RTX 5080, upgraded from a 3070 Ti" });
  store.rememberFact({ key: "Old Fact", text: "no longer true" });
  store.rememberFact({ key: "Old Fact", action: "remove" });

  const keys = store.listFactKeys();
  assert.deepEqual(keys, [{ key: "the user's GPU", preview: "RTX 5080, upgraded from a 3070 Ti" }]);
});

test("getRelatedFacts surfaces a remembered fact under its own 'Remembered:' block", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({
    key: "gaming schedule",
    text: "The user usually plays FFXIV in the evenings.",
  });
  const surfaced = store.getRelatedFacts("what's the user's gaming schedule like?");
  assert.match(surfaced, /Remembered:/);
  assert.match(surfaced, /The user usually plays FFXIV in the evenings\./);
});

test("getRelatedFacts includes both entity mentions and remembered facts together when both match", () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
  });
  store.appendTurn({
    sessionId: "session-a",
    user: "We're discussing Acme Corp's roadmap.",
    assistant: "Noted.",
  });
  store.rememberFact({ key: "Acme Corp", text: "Deal signed in June 2026." });

  const surfaced = store.getRelatedFacts("What's up with Acme Corp lately?", {
    excludeSessionId: "session-b",
  });
  assert.match(surfaced, /Related from other sessions:/);
  assert.match(surfaced, /Remembered:/);
  assert.match(surfaced, /Deal signed in June 2026\./);
});

// Issue #282: structured entry-array form of buildPromptMemory/getRelatedFacts.
test("buildPromptMemoryEntries returns positionable entries with the same content buildPromptMemory would combine", () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
    maxRecentTurns: 3,
    maxPromptChars: 1200,
  });

  store.ensureSession({ sessionId: "zed-session-entries", cwd: "C:\\ManaAI\\Mana" });
  store.appendTurn({
    sessionId: "zed-session-entries",
    user: "The preferred editor on this PC is Zed.",
    assistant: "Understood. I will prefer Zed locally.",
  });

  const { entries } = store.buildPromptMemoryEntries("zed-session-entries");
  // A fresh single-turn session already has a session.summary (see the
  // "auto-names a session from its first user turn" behavior), so this
  // produces two entries: the summary (early) and the recent-turns block
  // (late) -- same content buildPromptMemory would combine into one string.
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.role === "system"));
  const [summaryEntry, recentTurnsEntry] = entries;
  assert.equal(summaryEntry.position, "early");
  assert.equal(recentTurnsEntry.position, "late");
  assert.match(recentTurnsEntry.content, /Recent turns/i);
  assert.match(recentTurnsEntry.content, /preferred editor on this PC is Zed/i);
});

test("buildPromptMemoryEntries honors summaryPosition/recentTurnsPosition overrides", () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
  });
  store.ensureSession({ sessionId: "zed-session-positions", cwd: "C:\\ManaAI\\Mana" });
  store.appendTurn({
    sessionId: "zed-session-positions",
    user: "The preferred editor on this PC is Zed.",
    assistant: "Understood.",
  });

  const { entries } = store.buildPromptMemoryEntries("zed-session-positions", {
    recentTurnsPosition: "early",
  });
  assert.ok(entries.every((e) => e.position === "early"));
});

test("buildPromptMemoryEntries returns no entries for an unknown/empty session", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  assert.deepEqual(store.buildPromptMemoryEntries("no-such-session"), { entries: [] });
});

test("getRelatedFactsEntries returns mentions and facts as separate entries, defaulting to late position", () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
  });
  store.appendTurn({
    sessionId: "session-a",
    user: "We're discussing Acme Corp's roadmap.",
    assistant: "Noted.",
  });
  store.rememberFact({ key: "Acme Corp", text: "Deal signed in June 2026." });

  const { entries } = store.getRelatedFactsEntries("What's up with Acme Corp lately?", {
    excludeSessionId: "session-b",
  });
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.role === "system" && e.position === "late"));
  assert.ok(entries.some((e) => /Related from other sessions:/.test(e.content)));
  assert.ok(entries.some((e) => /Remembered:.*Deal signed in June 2026\./s.test(e.content)));
});

test("getRelatedFactsEntries returns no entries for text with no known entities or mentions", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  assert.deepEqual(store.getRelatedFactsEntries("what time is it?"), { entries: [] });
});

// Issue #263 part 2: cursor-based re-summarization. summarizeFn fires as a
// fire-and-forget async IIFE inside appendTurn, not awaited by appendTurn
// itself -- these tests use a deferred promise summarizeFn resolves so the
// test can await the actual compaction completing, not just the appendTurn
// call that triggered it.
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test("a successful compaction advances lastSummarizedTurnIndex to the turn count at compaction time", async () => {
  const compactionDone = deferred();
  let capturedTurns = null;
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
    maxSummaryChars: 40,
    maxSummaryTokens: 10,
    summarizeFn: async ({ turns }) => {
      capturedTurns = turns;
      compactionDone.resolve();
      return "condensed summary";
    },
  });

  store.ensureSession({ sessionId: "cursor-session" });
  await store.appendTurn({
    sessionId: "cursor-session",
    user: "This is a long enough message to push the summary over its cap quickly.",
    assistant: "Understood, noting that down.",
  });
  await compactionDone.promise;

  const session = store.getSession("cursor-session");
  assert.equal(session.summary, "condensed summary");
  assert.equal(session.lastSummarizedTurnIndex, session.turns.length);
  assert.equal(capturedTurns.length, session.turns.length);
});

test("a second compaction only includes turns added since the cursor, not a fixed last-10 window", async () => {
  const firstCompactionDone = deferred();
  const secondCompactionDone = deferred();
  let callCount = 0;
  let secondCallTurns = null;
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
    maxSummaryChars: 40,
    maxSummaryTokens: 10,
    maxRecentTurns: 20,
    summarizeFn: async ({ turns }) => {
      callCount += 1;
      if (callCount === 1) {
        firstCompactionDone.resolve();
        return "first condensed summary";
      }
      secondCallTurns = turns;
      secondCompactionDone.resolve();
      return "second condensed summary";
    },
  });

  store.ensureSession({ sessionId: "cursor-session-2" });
  await store.appendTurn({
    sessionId: "cursor-session-2",
    user: "First long enough message to trigger the first compaction pass here.",
    assistant: "Okay.",
  });
  await firstCompactionDone.promise;

  const afterFirst = store.getSession("cursor-session-2");
  const cursorAfterFirst = afterFirst.lastSummarizedTurnIndex;
  assert.equal(cursorAfterFirst, 1);

  await store.appendTurn({
    sessionId: "cursor-session-2",
    user: "Second long enough message to trigger the second compaction pass too.",
    assistant: "Got it.",
  });
  await secondCompactionDone.promise;

  // Only the ONE turn added since the cursor -- not a fixed window that
  // would include turn 1 again just because it fits inside "last 10".
  assert.equal(secondCallTurns.length, 1);
  assert.match(secondCallTurns[0].user, /Second long enough message/);
});

test("truncateKeepingRecent behavior: an overflowing summary keeps the newest content, not the oldest, when no summarizer is configured", async () => {
  // maxSummaryChars has a hard floor of 100 (Math.max(100, ...) inside
  // createAcpMemoryStore) -- passing anything lower is silently clamped up,
  // so the input turns below are sized to comfortably exceed even that
  // floor once combined.
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
    maxSummaryChars: 100,
    // No summarizeFn -- proves the raw truncation direction on its own,
    // without compaction ever kicking in to rewrite the summary.
  });

  store.ensureSession({ sessionId: "truncate-session" });
  await store.appendTurn({
    sessionId: "truncate-session",
    user: "OLDEST_MARKER this turn should eventually fall off the front of the rolling summary once it overflows.",
    assistant: "Acknowledged, an old turn that should not survive truncation.",
  });
  await store.appendTurn({
    sessionId: "truncate-session",
    user: "NEWEST_MARKER this is the most recent turn and must survive truncation.",
    assistant: "ok",
  });

  const session = store.getSession("truncate-session");
  assert.ok(session.summary.length <= 100);
  assert.match(session.summary, /NEWEST_MARKER/);
  assert.doesNotMatch(session.summary, /OLDEST_MARKER/);
});
