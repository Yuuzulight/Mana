const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAcpMemoryStore, extractEntities } = require("../acp-memory-store");
const { createSessionSearchIndex } = require("../session-search-index");
const { createMemoryGraph } = require("../memory-graph");
const { createSnapshotStore } = require("../snapshot-store");

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

// Issue #295 (piece 2 of #285): userAffectState -- a decaying read on the
// user's affect, nudged per turn from the user's own message text.
test("getUserAffect starts at 0 (neutral) for a fresh store", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  assert.equal(store.getUserAffect(), 0);
});

test("appendTurn nudges userAffectState positive from positive user text", async () => {
  let clock = "2026-01-01T00:00:00.000Z";
  const store = createAcpMemoryStore({ dataDir: createTempDir(), now: () => clock });

  await store.appendTurn({ sessionId: "s1", user: "this is awesome, finally!", assistant: "glad to hear it" });
  assert.ok(store.getUserAffect(clock) > 0);
});

test("appendTurn nudges userAffectState negative from negative user text", async () => {
  let clock = "2026-01-01T00:00:00.000Z";
  const store = createAcpMemoryStore({ dataDir: createTempDir(), now: () => clock });

  await store.appendTurn({ sessionId: "s1", user: "ugh, that's so annoying", assistant: "sorry to hear that" });
  assert.ok(store.getUserAffect(clock) < 0);
});

test("appendTurn with neutral text doesn't move userAffectState", async () => {
  let clock = "2026-01-01T00:00:00.000Z";
  const store = createAcpMemoryStore({ dataDir: createTempDir(), now: () => clock });

  await store.appendTurn({ sessionId: "s1", user: "what time is the meeting tomorrow", assistant: "3pm" });
  assert.equal(store.getUserAffect(clock), 0);
});

test("userAffectState decays back toward 0 over time", async () => {
  let clock = "2026-01-01T00:00:00.000Z";
  const store = createAcpMemoryStore({ dataDir: createTempDir(), now: () => clock });

  await store.appendTurn({ sessionId: "s1", user: "this is awesome, finally!", assistant: "glad to hear it" });
  const fresh = store.getUserAffect(clock);
  assert.ok(fresh > 0);

  // One full decay half-life (12h) later, without any new turn -- the
  // stored value hasn't changed, but the decayed READ should be about half.
  const later = store.getUserAffect("2026-01-01T12:00:00.000Z");
  assert.ok(later > 0 && later < fresh);
  assert.ok(Math.abs(later - fresh / 2) < 0.01, `expected ~half-decay, got ${later} vs ${fresh}`);
});

test("appendTurn's userAffectState accumulates decayed-and-then-nudged, not just the latest turn's raw valence", async () => {
  let clock = "2026-01-01T00:00:00.000Z";
  const store = createAcpMemoryStore({ dataDir: createTempDir(), now: () => clock });

  await store.appendTurn({ sessionId: "s1", user: "awesome, great!", assistant: "yay" });
  const afterFirst = store.getUserAffect(clock);

  clock = "2026-01-01T01:00:00.000Z";
  await store.appendTurn({ sessionId: "s1", user: "awesome, great!", assistant: "yay" });
  const afterSecond = store.getUserAffect(clock);

  assert.ok(afterSecond > afterFirst, "a second positive nudge on top of barely-decayed positivity should push it higher");
});

// Issue #295: emotional-state.json corruption/absence never breaks appendTurn.
test("appendTurn never breaks the turn append when the emotional state file is corrupt", async () => {
  const dataDir = createTempDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "emotional-state.json"), "not valid json{{{", "utf8");
  const store = createAcpMemoryStore({ dataDir });

  const saved = await store.appendTurn({ sessionId: "s1", user: "hello", assistant: "hi" });
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

test("setSessionGoal stores a plain goal string, clears it with an empty string, and returns null for unknown sessions", () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
  });

  store.ensureSession({ sessionId: "session-goal" });
  const withGoal = store.setSessionGoal("session-goal", "  Fix the login bug  ");
  assert.equal(withGoal.goal, "Fix the login bug");
  assert.equal(store.getSession("session-goal").goal, "Fix the login bug");

  const cleared = store.setSessionGoal("session-goal", "");
  assert.equal(cleared.goal, null);
  assert.equal(store.getSession("session-goal").goal, null);

  assert.equal(store.setSessionGoal("does-not-exist", "x"), null);
});

test("listSessions includes each session's goal (or null if unset)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.ensureSession({ sessionId: "session-with-goal" });
  store.ensureSession({ sessionId: "session-without-goal" });
  store.setSessionGoal("session-with-goal", "Ship the release");

  const sessions = store.listSessions();
  const withGoal = sessions.find((s) => s.sessionId === "session-with-goal");
  const withoutGoal = sessions.find((s) => s.sessionId === "session-without-goal");
  assert.equal(withGoal.goal, "Ship the release");
  assert.equal(withoutGoal.goal, null);
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

// Issue #432: ontology-typed entity extraction storage layer.
test("listUntypedEntities returns entities with mentions but no type yet, and excludes already-typed ones", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.appendTurn({ sessionId: "s1", user: "I want to discuss Singapore.", assistant: "Okay." });
  store.appendTurn({ sessionId: "s1", user: "GPU matters too.", assistant: "Okay." });

  const untyped = store.listUntypedEntities(10);
  assert.deepEqual(
    untyped.map((e) => e.key).sort(),
    ["gpu", "singapore"],
  );

  store.setEntityType("singapore", "place", "city");
  const stillUntyped = store.listUntypedEntities(10);
  assert.deepEqual(stillUntyped.map((e) => e.key), ["gpu"]);
});

test("listUntypedEntities respects the batch limit", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.appendTurn({ sessionId: "s1", user: "Alpha and Beta and Gamma.", assistant: "Noted." });
  assert.equal(store.listUntypedEntities(1).length, 1);
  assert.equal(store.listUntypedEntities(2).length, 2);
});

test("setEntityType fails for an entity with no recorded mentions", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  assert.equal(store.setEntityType("never mentioned", "object"), false);
});

test("setEntityType omits subcategory when not given, and stores it when given", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir(), now: () => "2026-05-01T00:00:00.000Z" });
  store.appendTurn({ sessionId: "s1", user: "GPU is fast.", assistant: "Okay." });
  store.setEntityType("gpu", "object", "hardware");

  const facts = JSON.parse(
    require("node:fs").readFileSync(require("node:path").join(store.dataDir, "entity-types.json"), "utf8"),
  );
  assert.deepEqual(facts.gpu, { type: "object", subcategory: "hardware", typedAt: "2026-05-01T00:00:00.000Z" });
});

test("listCanonicalEntitiesOfType returns only entities of that type that aren't themselves an alias", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.appendTurn({ sessionId: "s1", user: "GPU and Singapore and Tokyo.", assistant: "Okay." });
  store.setEntityType("gpu", "object");
  store.setEntityType("singapore", "place");
  store.setEntityType("tokyo", "place");
  store.setCanonicalAlias("tokyo", "singapore");

  const places = store.listCanonicalEntitiesOfType("place");
  assert.deepEqual(places.map((p) => p.key), ["singapore"]);
});

test("setCanonicalAlias is non-destructive: the aliased entity's own mentions/type are untouched", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.appendTurn({ sessionId: "s1", user: "GPU and Graphics Card.", assistant: "Okay." });
  store.setEntityType("gpu", "object", "hardware");
  store.setEntityType("graphics card", "object", "hardware");

  const merged = store.setCanonicalAlias("graphics card", "gpu");
  assert.equal(merged, true);
  assert.equal(store.resolveCanonicalKey("graphics card"), "gpu");
  // The alias's own mentions are still there, untouched -- non-destructive.
  assert.equal(store.lookupEntity("graphics card").length, 1);
});

test("setCanonicalAlias refuses to point an entity at itself or an untyped/unknown key", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.appendTurn({ sessionId: "s1", user: "GPU is here.", assistant: "Okay." });
  store.setEntityType("gpu", "object");

  assert.equal(store.setCanonicalAlias("gpu", "gpu"), false);
  assert.equal(store.setCanonicalAlias("never typed", "gpu"), false);
});

test("resolveCanonicalKey returns the key itself when there's no alias", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  assert.equal(store.resolveCanonicalKey("gpu"), "gpu");
  assert.equal(store.resolveCanonicalKey("GPU"), "gpu");
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

function readFacts(store) {
  return JSON.parse(
    require("node:fs").readFileSync(require("node:path").join(store.dataDir, "facts.json"), "utf8"),
  ).facts;
}

// Issue #431: bi-temporal validity -- validFrom/invalidatedAt.
test("rememberFact insert stamps validFrom equal to createdAt", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir(), now: () => "2026-03-01T00:00:00.000Z" });
  store.rememberFact({ key: "favorite color", text: "blue" });
  const fact = readFacts(store).find((f) => f.key === "favorite color");
  assert.equal(fact.validFrom, "2026-03-01T00:00:00.000Z");
  assert.equal(fact.createdAt, "2026-03-01T00:00:00.000Z");
  assert.equal(fact.invalidatedAt, undefined);
});

test("rememberFact patch bumps validFrom and records the prior value's own validity window in history, not a bare updatedAt", () => {
  let currentTime = "2026-01-01T00:00:00.000Z";
  const store = createAcpMemoryStore({ dataDir: createTempDir(), now: () => currentTime });
  store.rememberFact({ key: "favorite color", text: "blue" });
  currentTime = "2026-02-01T00:00:00.000Z";
  store.rememberFact({ key: "favorite color", text: "green", action: "patch" });

  const fact = readFacts(store).find((f) => f.key === "favorite color");
  assert.equal(fact.text, "green");
  assert.equal(fact.validFrom, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(fact.history, [
    { text: "blue", validFrom: "2026-01-01T00:00:00.000Z", invalidatedAt: "2026-02-01T00:00:00.000Z" },
  ]);
});

test("rememberFact supersedes marks a different-keyed active fact invalidated, without deleting it", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir(), now: () => "2026-05-01T00:00:00.000Z" });
  store.rememberFact({ key: "relationship status", text: "single" });
  const result = store.rememberFact({
    key: "dating status",
    text: "in a relationship",
    supersedes: "relationship status",
  });

  assert.deepEqual(result.superseded, { key: "relationship status", found: true });
  const facts = readFacts(store);
  const old = facts.find((f) => f.key === "relationship status");
  const fresh = facts.find((f) => f.key === "dating status");
  assert.equal(old.invalidatedAt, "2026-05-01T00:00:00.000Z");
  assert.equal(old.status, "active", "supersedes stays orthogonal to status, not a 4th lifecycle state");
  assert.equal(fresh.invalidatedAt, undefined);

  // Invalidated facts drop out of normal surfacing/listing...
  assert.equal(store.getRelatedFacts("what's the user's relationship status?"), "");
  assert.deepEqual(store.listFactKeys(), [{ key: "dating status", preview: "in a relationship" }]);
  // ...but the record itself is preserved, not deleted.
  assert.equal(old.text, "single");
});

test("rememberFact supersedes is a no-op for an unknown key or the fact's own key", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "favorite color", text: "blue" });

  const unknownKey = store.rememberFact({ key: "new fact", text: "x", supersedes: "does not exist" });
  assert.deepEqual(unknownKey.superseded, { key: "does not exist", found: false });

  const selfSupersede = store.rememberFact({ key: "favorite color", text: "green", action: "patch", supersedes: "favorite color" });
  assert.equal("superseded" in selfSupersede, false);
  assert.equal(readFacts(store).find((f) => f.key === "favorite color").invalidatedAt, undefined);
});

test("invalidateFactByKey marks an active fact invalidated directly, and no-ops on an unknown key", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir(), now: () => "2026-04-01T00:00:00.000Z" });
  store.rememberFact({ key: "favorite color", text: "blue" });

  const found = store.invalidateFactByKey("favorite color");
  assert.deepEqual(found, { key: "favorite color", found: true });
  assert.equal(readFacts(store).find((f) => f.key === "favorite color").invalidatedAt, "2026-04-01T00:00:00.000Z");

  const notFound = store.invalidateFactByKey("nope");
  assert.deepEqual(notFound, { key: "nope", found: false });
});

test("getFactsValidAt answers what was believed true as of a past date, ignoring status and later corrections", () => {
  let currentTime = "2026-01-01T00:00:00.000Z";
  const store = createAcpMemoryStore({ dataDir: createTempDir(), now: () => currentTime });
  store.rememberFact({ key: "favorite color", text: "blue" });

  currentTime = "2026-03-01T00:00:00.000Z";
  store.rememberFact({ key: "favorite color", text: "green", action: "patch" });

  currentTime = "2026-06-01T00:00:00.000Z";
  store.rememberFact({ key: "favorite color", action: "archive" });

  // Before any patch: the original value was the active claim.
  assert.deepEqual(
    store.getFactsValidAt("2026-02-01T00:00:00.000Z").map((f) => f.key),
    ["favorite color"],
  );
  // The CURRENT record (patched to "green") is what's valid at this date,
  // even though it's since been archived -- status is ignored on purpose.
  assert.deepEqual(
    store.getFactsValidAt("2026-04-01T00:00:00.000Z").map((f) => f.key),
    ["favorite color"],
  );
  // Before the fact existed at all.
  assert.deepEqual(store.getFactsValidAt("2025-12-01T00:00:00.000Z"), []);
});

test("getFactsValidAt excludes a fact after it was superseded", () => {
  let currentTime = "2026-01-01T00:00:00.000Z";
  const store = createAcpMemoryStore({ dataDir: createTempDir(), now: () => currentTime });
  store.rememberFact({ key: "relationship status", text: "single" });

  currentTime = "2026-03-01T00:00:00.000Z";
  store.rememberFact({ key: "dating status", text: "in a relationship", supersedes: "relationship status" });

  assert.deepEqual(
    store.getFactsValidAt("2026-02-01T00:00:00.000Z").map((f) => f.key).sort(),
    ["relationship status"],
  );
  assert.deepEqual(
    store.getFactsValidAt("2026-04-01T00:00:00.000Z").map((f) => f.key).sort(),
    ["dating status"],
  );
});

test("rememberFact insert stores unverifiedSource and it stops auto-surfacing but isn't deleted (issue #317)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  const result = store.rememberFact({
    key: "the user's GPU",
    text: "the user owns an RTX 5080",
    unverifiedSource: true,
  });
  assert.equal(result.unverifiedSource, true);

  // Stops auto-surfacing as trusted context...
  assert.equal(store.getRelatedFacts("what's the user's GPU?"), "");

  // ...but listFactKeys still shows it exists, so a later correction
  // patches this key instead of duplicating it.
  const keys = store.listFactKeys();
  assert.ok(keys.some((k) => k.key === "the user's GPU"));
});

test("rememberFact patch clears unverifiedSource once a later correction is attributable, and re-sets it if the correction isn't", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "the user's GPU", text: "an old value", unverifiedSource: true });
  assert.equal(store.getRelatedFacts("what's the user's GPU?"), "");

  store.rememberFact({ key: "the user's GPU", text: "RTX 5080, confirmed", action: "patch" });
  assert.match(store.getRelatedFacts("what's the user's GPU?"), /RTX 5080, confirmed/);

  store.rememberFact({
    key: "the user's GPU",
    text: "something else entirely",
    action: "patch",
    unverifiedSource: true,
  });
  assert.equal(store.getRelatedFacts("what's the user's GPU?"), "");
});

test("rememberFact insert without unverifiedSource behaves exactly as before (back-compat, no stray field on the stored fact)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  const result = store.rememberFact({ key: "favorite color", text: "teal" });
  assert.equal("unverifiedSource" in result, false);
  assert.match(store.getRelatedFacts("what's the favorite color?"), /teal/);
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

test("listFacts returns every status and field, including unverifiedSource, unlike listFactKeys", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "gpu", text: "RTX 5080", unverifiedSource: true });
  store.rememberFact({ key: "Old Fact", text: "no longer true" });
  store.rememberFact({ key: "Old Fact", action: "remove" });

  const facts = store.listFacts();
  assert.equal(facts.length, 2);
  const gpuFact = facts.find((f) => f.key === "gpu");
  assert.equal(gpuFact.unverifiedSource, true);
  assert.equal(gpuFact.status, "active");
  const removedFact = facts.find((f) => f.key === "Old Fact");
  assert.equal(removedFact.status, "stale");
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
  assert.deepEqual(store.buildPromptMemoryEntries("no-such-session"), {
    entries: [],
    turnsDroppedByAge: 0,
  });
});

// Issue #400: entries report whether their own token-budget truncation fired,
// and the response separately reports how many turns #338's age window
// dropped before they ever reached that truncation step.
test("buildPromptMemoryEntries reports truncated:false and turnsDroppedByAge:0 when nothing was dropped", () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
  });
  store.ensureSession({ sessionId: "no-drops", cwd: "C:\\ManaAI\\Mana" });
  store.appendTurn({ sessionId: "no-drops", user: "Hi", assistant: "Hello." });

  const result = store.buildPromptMemoryEntries("no-drops");
  assert.equal(result.turnsDroppedByAge, 0);
  assert.ok(result.entries.every((e) => e.truncated === false));
});

test("buildPromptMemoryEntries reports turnsDroppedByAge when #338's age window excludes turns", async () => {
  const dataDir = createTempDir();
  const writer = createAcpMemoryStore({
    dataDir,
    now: () => "2026-06-28T00:00:00.000Z",
  });
  await writer.appendTurn({ sessionId: "aged-out", user: "Old turn", assistant: "Old reply" });

  const store = createAcpMemoryStore({
    dataDir,
    now: () => "2026-06-29T00:00:00.000Z",
    maxRecentTurnAgeMs: 1000,
    minRecentTurns: 0,
  });
  await store.appendTurn({ sessionId: "aged-out", user: "New turn", assistant: "New reply" });

  const result = store.buildPromptMemoryEntries("aged-out");
  assert.equal(result.turnsDroppedByAge, 1);
});

// Regression coverage for a review finding: the age-drop test above passes
// minRecentTurns: 0 to sidestep #385's floor (freshTurns reinstating the
// newest turn(s) even when every turn is otherwise past the age window).
// The production default is minRecentTurns: 1 (MANA_MIN_RECENT_TURNS),
// which was otherwise untested here -- turnsDroppedByAge must still equal
// exactly the turns absent from freshTurns' actual (floor-reinstated)
// output, not a naive re-derivation of the raw age check.
test("buildPromptMemoryEntries reports turnsDroppedByAge correctly when the #385 floor reinstates a stale turn", async () => {
  const dataDir = createTempDir();
  const writer = createAcpMemoryStore({
    dataDir,
    now: () => "2026-06-28T00:00:00.000Z",
  });
  await writer.appendTurn({ sessionId: "floor-reinstated", user: "Old turn 1", assistant: "Old reply 1" });
  await writer.appendTurn({ sessionId: "floor-reinstated", user: "Old turn 2", assistant: "Old reply 2" });

  const store = createAcpMemoryStore({
    dataDir,
    now: () => "2026-06-29T00:00:00.000Z",
    maxRecentTurnAgeMs: 1000,
    minRecentTurns: 1,
  });

  const result = store.buildPromptMemoryEntries("floor-reinstated");
  // Both turns are past the age window; the floor reinstates only the
  // newest one, so exactly 1 of the 2 total turns is reported dropped.
  assert.equal(result.turnsDroppedByAge, 1);
  const recentTurnsEntry = result.entries.find((e) => e.content.includes("Recent turns"));
  assert.match(recentTurnsEntry.content, /Old turn 2/);
  assert.doesNotMatch(recentTurnsEntry.content, /Old turn 1/);
});

test("buildPromptMemoryEntries reports truncated:true when the token budget forces a cut", () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
    maxPromptChars: 40,
  });
  store.ensureSession({ sessionId: "tight-budget", cwd: "C:\\ManaAI\\Mana" });
  store.appendTurn({
    sessionId: "tight-budget",
    user: "A".repeat(200),
    assistant: "B".repeat(200),
  });

  const result = store.buildPromptMemoryEntries("tight-budget");
  assert.ok(result.entries.some((e) => e.truncated === true));
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

test("getRelatedFacts drops whole fact lines instead of clipping one mid-line (issue #364)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "coffee", text: "likes it, but not after 6pm" });
  store.rememberFact({ key: "commute", text: "cycles in unless it is raining" });
  store.rememberFact({ key: "standup", text: "prefers the later slot on Fridays" });

  const surfaced = store.getRelatedFacts(
    "remind me about coffee, commute, and standup",
    { maxChars: 80 },
  );

  const stored = store.listFacts().map((f) => `- ${f.key}: ${f.text}`);
  const lines = surfaced.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(lines.length >= 1, "at least one fact should survive the budget");
  for (const line of lines) {
    // A clipped fact still reads as a complete one, so every surfaced line
    // has to match a stored fact exactly rather than be a prefix of one.
    assert.ok(stored.includes(line), `partial fact line surfaced: ${line}`);
  }
  assert.ok(surfaced.length <= 80);
});

test("getRelatedFacts orders the more specific key first (issue #364)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "car", text: "a blue hatchback" });
  store.rememberFact({ key: "car insurance", text: "renews in March" });

  const surfaced = store.getRelatedFacts("what about my car insurance?");
  const lines = surfaced.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines[0], "- car insurance: renews in March");
});

test("getRelatedFactsEntries omits an entry that truncates to nothing (issue #364)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({
    key: "deployment",
    text: "a very long remembered detail that cannot possibly fit inside a tiny budget",
  });

  const { entries } = store.getRelatedFactsEntries("tell me about deployment", {
    maxChars: 50,
  });
  // The header alone carries no information, so no message should be emitted.
  assert.equal(entries.length, 0);
});

test("rememberFact stamps a schemaVersion on new facts (issue #336)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "hometown", text: "Singapore" });

  const [fact] = store.listFacts();
  assert.equal(fact.schemaVersion, 1);
});

test("rememberFact records epistemic and occurredAt when supplied (issue #336)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({
    key: "house move",
    text: "moved to a new flat",
    epistemic: "self_report",
    occurredAt: "2026-03-14",
  });

  const [fact] = store.listFacts();
  assert.equal(fact.epistemic, "self_report");
  assert.equal(fact.occurredAt, "2026-03-14");
});

test("rememberFact drops an unrecognized epistemic instead of throwing (issue #336)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "mood", text: "cheerful", epistemic: "vibes" });

  const [fact] = store.listFacts();
  assert.equal(fact.epistemic, undefined);
});

test("epistemic is orthogonal to unverifiedSource, not a replacement (issue #336)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({
    key: "commute time",
    text: "about 40 minutes",
    epistemic: "inferred",
    unverifiedSource: true,
  });

  const [fact] = store.listFacts();
  assert.equal(fact.epistemic, "inferred");
  assert.equal(fact.unverifiedSource, true);
});

test("patch keeps epistemic and occurredAt when they are not restated (issue #336)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({
    key: "job title",
    text: "data engineer",
    epistemic: "self_report",
    occurredAt: "2026-01-05",
  });
  store.rememberFact({ key: "job title", text: "senior data engineer", action: "patch" });

  const [fact] = store.listFacts();
  assert.equal(fact.text, "senior data engineer");
  // A later correction that does not restate them must not erase them --
  // unlike unverifiedSource, which describes that specific write.
  assert.equal(fact.epistemic, "self_report");
  assert.equal(fact.occurredAt, "2026-01-05");
});

test("existing facts without the new fields still load and surface (issue #336)", () => {
  const dataDir = createTempDir();
  // A record written before this schema existed: no schemaVersion, no
  // epistemic, no occurredAt.
  fs.mkdirSync(path.join(dataDir, "acp-memory"), { recursive: true });
  const store = createAcpMemoryStore({ dataDir });
  store.rememberFact({ key: "legacy fact", text: "still here" });
  const factsPath = path.join(store.dataDir, "facts.json");
  const parsed = JSON.parse(fs.readFileSync(factsPath, "utf8"));
  delete parsed.facts[0].schemaVersion;
  fs.writeFileSync(factsPath, JSON.stringify(parsed), "utf8");

  const reopened = createAcpMemoryStore({ dataDir });
  assert.match(reopened.getRelatedFacts("tell me about the legacy fact"), /still here/);
});

test("searchSessions filters to a stated day and drops the date word from the query (issue #337)", async () => {
  const sessionSearchIndex = createSessionSearchIndex({ dbPath: ":memory:" });
  const dataDir = createTempDir();
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const older = createAcpMemoryStore({ dataDir, sessionSearchIndex, now: () => threeDaysAgo });
  await older.appendTurn({ sessionId: "s1", user: "the deploy broke badly", assistant: "ok" });

  const recent = createAcpMemoryStore({ dataDir, sessionSearchIndex, now: () => yesterday });
  await recent.appendTurn({ sessionId: "s1", user: "the deploy broke again", assistant: "ok" });

  const results = await recent.searchSessions({ query: "deploy yesterday" });
  const texts = results.map((r) => r.text);
  assert.ok(texts.some((t) => /broke again/.test(t)), "yesterday's turn should be found");
  assert.ok(!texts.some((t) => /broke badly/.test(t)), "the older turn is outside the window");
  sessionSearchIndex.close();
});

test("searchSessions answers a purely temporal question with no keywords left (issue #337)", async () => {
  const sessionSearchIndex = createSessionSearchIndex({ dbPath: ":memory:" });
  const dataDir = createTempDir();
  const lastMonth = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const older = createAcpMemoryStore({ dataDir, sessionSearchIndex, now: () => lastMonth });
  await older.appendTurn({ sessionId: "s1", user: "ancient chatter", assistant: "ok" });

  const recent = createAcpMemoryStore({ dataDir, sessionSearchIndex, now: () => yesterday });
  await recent.appendTurn({ sessionId: "s1", user: "fresh chatter", assistant: "ok" });

  // "yesterday" alone leaves no keywords -- the window is the whole query.
  const results = await recent.searchSessions({ query: "yesterday" });
  const texts = results.map((r) => r.text);
  assert.ok(texts.some((t) => /fresh chatter/.test(t)));
  assert.ok(!texts.some((t) => /ancient chatter/.test(t)));
  sessionSearchIndex.close();
});

test("an explicit since/until from the caller wins over the query text (issue #337)", async () => {
  const sessionSearchIndex = createSessionSearchIndex({ dbPath: ":memory:" });
  const dataDir = createTempDir();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const store = createAcpMemoryStore({ dataDir, sessionSearchIndex, now: () => yesterday });
  await store.appendTurn({ sessionId: "s1", user: "the deploy broke", assistant: "ok" });

  // A window that deliberately excludes everything, despite the text
  // naming a day that would have matched.
  const results = await store.searchSessions({
    query: "deploy yesterday",
    since: "2000-01-01T00:00:00.000Z",
    until: "2000-01-02T00:00:00.000Z",
  });
  assert.equal(results.length, 0);
  sessionSearchIndex.close();
});

test("buildPromptMemory drops turns older than the recency window (issue #338)", async () => {
  const dataDir = createTempDir();
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const stale = createAcpMemoryStore({ dataDir, now: () => old });
  await stale.appendTurn({ sessionId: "s1", user: "ancient question", assistant: "ancient answer" });

  // Floor disabled (issue #385) so this keeps testing the pure age window.
  const store = createAcpMemoryStore({ dataDir, minRecentTurns: 0 });
  const injected = store.buildPromptMemory("s1");
  // The window bounds the verbatim recent-turns block. The rolling summary
  // is deliberately left alone -- ageing it out would discard the whole
  // thread, not just its stale tail.
  assert.doesNotMatch(injected, /Recent turns:/);
});

test("buildPromptMemory keeps turns inside the recency window (issue #338)", async () => {
  const dataDir = createTempDir();
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const writer = createAcpMemoryStore({ dataDir, now: () => recent });
  await writer.appendTurn({ sessionId: "s1", user: "fresh question", assistant: "fresh answer" });

  const store = createAcpMemoryStore({ dataDir });
  assert.match(store.buildPromptMemory("s1"), /fresh question/);
});

test("buildPromptMemory returns nothing rather than a bare header (issue #338)", () => {
  const dataDir = createTempDir();
  const sessionsDir = path.join(dataDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  // Written directly: a session holding only aged-out turns and no summary.
  fs.writeFileSync(
    path.join(sessionsDir, `${Buffer.from("s1").toString("base64url")}.json`),
    JSON.stringify({
      sessionId: "s1",
      summary: "",
      turns: [{ at: old, user: "ancient", assistant: "ancient" }],
    }),
    "utf8",
  );

  // Floor disabled (issue #385): with it on, the newest turn survives.
  const store = createAcpMemoryStore({ dataDir, minRecentTurns: 0 });
  // Every turn aged out and no summary -- "Conversation memory:" alone says
  // nothing and still costs tokens.
  assert.equal(store.buildPromptMemory("s1"), "");
});

test("a zero recency window keeps the previous count-only behavior (issue #338)", async () => {
  const dataDir = createTempDir();
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const stale = createAcpMemoryStore({ dataDir, now: () => old });
  await stale.appendTurn({ sessionId: "s1", user: "ancient question", assistant: "ancient answer" });

  const store = createAcpMemoryStore({ dataDir, maxRecentTurnAgeMs: 0 });
  assert.match(store.buildPromptMemory("s1"), /ancient question/);
});

test("a turn with no timestamp is kept rather than aged out (issue #338)", async () => {
  const dataDir = createTempDir();
  const writer = createAcpMemoryStore({ dataDir });
  await writer.appendTurn({ sessionId: "s1", user: "undated question", assistant: "ok" });

  // Strip the timestamp the way a record predating this field would lack one.
  const sessionPath = path.join(
    writer.dataDir,
    "sessions",
    `${Buffer.from("s1").toString("base64url")}.json`,
  );
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  for (const turn of session.turns) delete turn.at;
  fs.writeFileSync(sessionPath, JSON.stringify(session), "utf8");

  const store = createAcpMemoryStore({ dataDir });
  assert.match(store.buildPromptMemory("s1"), /undated question/);
});

test("forkSession carries the thread into a new session (issue #350)", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  await store.appendTurn({ sessionId: "coding-1", user: "refactor the parser", assistant: "ok" });

  const fork = store.forkSession("coding-1");
  assert.notEqual(fork.sessionId, "coding-1");
  assert.equal(fork.forkedFrom, "coding-1");
  assert.equal(fork.turns.length, 1);
  assert.match(fork.turns[0].user, /refactor the parser/);
});

test("a fork diverges without touching the original (issue #350)", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  await store.appendTurn({ sessionId: "coding-1", user: "first approach", assistant: "ok" });
  const fork = store.forkSession("coding-1");

  await store.appendTurn({ sessionId: fork.sessionId, user: "second approach", assistant: "ok" });

  // The whole point: trying something else must not destroy the thread that
  // got you there.
  assert.equal(store.getSession("coding-1").turns.length, 1);
  assert.equal(store.getSession(fork.sessionId).turns.length, 2);
});

test("forking accepts an explicit id and refuses to clobber one (issue #350)", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  await store.appendTurn({ sessionId: "coding-1", user: "x", assistant: "y" });

  const fork = store.forkSession("coding-1", { sessionId: "attempt-2", name: "Attempt 2" });
  assert.equal(fork.sessionId, "attempt-2");
  assert.equal(fork.name, "Attempt 2");
  assert.throws(() => store.forkSession("coding-1", { sessionId: "attempt-2" }), /already exists/);
});

test("forking an unknown session returns null (issue #350)", () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  assert.equal(store.forkSession("nope"), null);
});

test("a fork appears in listSessions and can be resumed by id (issue #350)", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  await store.appendTurn({ sessionId: "coding-1", user: "x", assistant: "y" });
  const fork = store.forkSession("coding-1", { sessionId: "attempt-2" });

  assert.ok(store.listSessions().some((s) => s.sessionId === "attempt-2"));
  // Resuming needed no new API -- a session is a file keyed by id.
  assert.equal(store.getSession(fork.sessionId).forkedFrom, "coding-1");
});

test("the newest turn survives the recency window as a floor (issue #385)", async () => {
  const dataDir = createTempDir();
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const stale = createAcpMemoryStore({ dataDir, now: () => old });
  await stale.appendTurn({ sessionId: "s1", user: "first old", assistant: "ok" });
  await stale.appendTurn({ sessionId: "s1", user: "last old", assistant: "ok" });

  const store = createAcpMemoryStore({ dataDir });
  const injected = store.buildPromptMemory("s1");
  // Coming back after a long gap should still show where the thread stopped.
  assert.match(injected, /Recent turns:/);
  const recentBlock = injected.slice(injected.indexOf("Recent turns:"));
  assert.match(recentBlock, /last old/);
  // Only the floor, not the whole stale tail. Asserted against the block
  // rather than the whole string -- the rolling summary legitimately
  // contains every turn and is deliberately not age-bounded.
  assert.doesNotMatch(recentBlock, /first old/);
});

test("a zero floor restores the pure age window (issue #385)", async () => {
  const dataDir = createTempDir();
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const stale = createAcpMemoryStore({ dataDir, now: () => old });
  await stale.appendTurn({ sessionId: "s1", user: "ancient", assistant: "ok" });

  const store = createAcpMemoryStore({ dataDir, minRecentTurns: 0 });
  assert.doesNotMatch(store.buildPromptMemory("s1"), /Recent turns:/);
});

test("turns inside the window are unaffected by the floor (issue #385)", async () => {
  const dataDir = createTempDir();
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const writer = createAcpMemoryStore({ dataDir, now: () => recent });
  await writer.appendTurn({ sessionId: "s1", user: "one", assistant: "ok" });
  await writer.appendTurn({ sessionId: "s1", user: "two", assistant: "ok" });

  const store = createAcpMemoryStore({ dataDir });
  const injected = store.buildPromptMemory("s1");
  assert.match(injected, /one/);
  assert.match(injected, /two/);
});

test("a skill whose body dropped out of context is marked (issue #383)", async () => {
  const dataDir = createTempDir();
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const past = createAcpMemoryStore({ dataDir, now: () => old });
  await past.appendTurn({
    sessionId: "s1",
    user: "how do I restart search",
    assistant: "let me check the skill",
    toolCalls: [{ name: "skill__view", ok: true, args: { name: "Restart SearXNG" } }],
  });
  // Enough newer turns that the skill-view turn falls out of the window.
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const now = createAcpMemoryStore({ dataDir, now: () => recent });
  for (let i = 0; i < 6; i++) {
    await now.appendTurn({ sessionId: "s1", user: `filler ${i}`, assistant: "ok" });
  }

  const injected = createAcpMemoryStore({ dataDir }).buildPromptMemory("s1");
  // The body is gone but the history still shows it was consulted, so the
  // model needs telling rather than left to improvise.
  assert.match(injected, /Skills consulted earlier, no longer loaded:/);
  assert.match(injected, /Restart SearXNG/);
  assert.match(injected, /skill__view to reload/);
});

test("a skill still inside the window is not marked (issue #383)", async () => {
  const dataDir = createTempDir();
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const store = createAcpMemoryStore({ dataDir, now: () => recent });
  await store.appendTurn({
    sessionId: "s1",
    user: "restart search",
    assistant: "on it",
    toolCalls: [{ name: "skill__view", ok: true, args: { name: "Restart SearXNG" } }],
  });

  const injected = createAcpMemoryStore({ dataDir }).buildPromptMemory("s1");
  assert.doesNotMatch(injected, /no longer loaded/);
});

test("re-viewing a skill clears its pruned marker (issue #383)", async () => {
  const dataDir = createTempDir();
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const past = createAcpMemoryStore({ dataDir, now: () => old });
  await past.appendTurn({
    sessionId: "s1",
    user: "first look",
    assistant: "ok",
    toolCalls: [{ name: "skill__view", ok: true, args: { name: "Restart SearXNG" } }],
  });

  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const now = createAcpMemoryStore({ dataDir, now: () => recent });
  await now.appendTurn({
    sessionId: "s1",
    user: "look again",
    assistant: "ok",
    toolCalls: [{ name: "skill__view", ok: true, args: { name: "Restart SearXNG" } }],
  });

  // The body is present again, so there is nothing to warn about.
  const injected = createAcpMemoryStore({ dataDir }).buildPromptMemory("s1");
  assert.doesNotMatch(injected, /no longer loaded/);
});

test("a session that never viewed a skill gets no marker block (issue #383)", async () => {
  const dataDir = createTempDir();
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const store = createAcpMemoryStore({ dataDir, now: () => recent });
  await store.appendTurn({ sessionId: "s1", user: "hello", assistant: "hi" });
  assert.doesNotMatch(createAcpMemoryStore({ dataDir }).buildPromptMemory("s1"), /no longer loaded/);
});

test("appendTurn/setSessionGoal/renameSession snapshot the pre-write session record, restorable via the generic store", async () => {
  const dataDir = createTempDir();
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const store = createAcpMemoryStore({ dataDir, snapshotStore });

  store.ensureSession({ sessionId: "snap-session-1" });
  await store.appendTurn({
    sessionId: "snap-session-1",
    user: "Remember I like tea.",
    assistant: "Noted.",
  });

  const afterFirstTurn = store.getSession("snap-session-1");
  assert.equal(afterFirstTurn.turns.length, 1);

  store.setSessionGoal("snap-session-1", "Plan a trip");
  const beforeRename = store.getSession("snap-session-1");
  assert.equal(beforeRename.goal, "Plan a trip");

  const snapshots = snapshotStore.listSnapshots("memory-session");
  // One from appendTurn (of the pre-turn empty session), one from
  // setSessionGoal (of the pre-goal session).
  assert.equal(snapshots.length, 2);

  // Restoring the setSessionGoal snapshot undoes the goal change but keeps
  // the turn that was appended before it (that's what the snapshot payload
  // captured -- the session as it stood right before the goal write).
  const goalSnapshot = snapshots.find((s) => s.summary.startsWith("session goal change"));
  await snapshotStore.restoreSnapshot(goalSnapshot.id);
  const restored = store.getSession("snap-session-1");
  // The session never had a goal set before this write (createEmptySession
  // doesn't initialize one), so the pre-write snapshot has no `goal` key at
  // all -- restoring it leaves goal unset (undefined), not explicitly null.
  assert.equal(restored.goal, undefined);
  assert.equal(restored.turns.length, 1);
});

test("restoring a memory-session snapshot backs up what it overwrote first, so the restore is itself undoable", async () => {
  const dataDir = createTempDir();
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const store = createAcpMemoryStore({ dataDir, snapshotStore });

  store.ensureSession({ sessionId: "snap-session-2" });
  store.setSessionGoal("snap-session-2", "Plan a trip");
  const beforeRestore = store.getSession("snap-session-2");

  const [goalSnapshot] = snapshotStore.listSnapshots("memory-session");
  await snapshotStore.restoreSnapshot(goalSnapshot.id);

  const backups = snapshotStore
    .listSnapshots("memory-session")
    .filter((s) => s.summary.startsWith("pre-restore backup"));
  assert.equal(backups.length, 1);
  const backup = snapshotStore.getSnapshot(backups[0].id);
  assert.equal(backup.source, "system");
  assert.deepEqual(backup.payload, beforeRestore, "the backup holds the session as it stood right before the restore");
});

test("rememberFact snapshots the prior fact state; restoring a freshly-inserted fact deletes it", async () => {
  const dataDir = createTempDir();
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const store = createAcpMemoryStore({ dataDir, snapshotStore });

  const inserted = store.rememberFact({
    sessionId: "fact-session",
    key: "favorite-drink",
    text: "Likes tea",
  });
  assert.equal(inserted.action, "insert");
  assert.equal(store.listFacts().length, 1);

  const [insertSnapshot] = snapshotStore.listSnapshots("memory-fact");
  assert.ok(insertSnapshot);

  // The fact didn't exist before the insert -- restoring must remove it,
  // not error or leave a stale entry.
  await snapshotStore.restoreSnapshot(insertSnapshot.id);
  assert.equal(store.listFacts().length, 0);
});

test("rememberFact patch snapshots the pre-patch fact, restorable back to its prior text", async () => {
  const dataDir = createTempDir();
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const store = createAcpMemoryStore({ dataDir, snapshotStore });

  store.rememberFact({ sessionId: "s", key: "favorite-drink", text: "Likes tea" });

  const patched = store.rememberFact({
    sessionId: "s",
    key: "favorite-drink",
    text: "Likes coffee",
    action: "patch",
  });
  assert.equal(patched.action, "patch");
  assert.equal(store.listFacts()[0].text, "Likes coffee");

  const patchSnapshot = snapshotStore
    .listSnapshots("memory-fact")
    .find((s) => s.summary === "fact patch: favorite-drink");
  assert.ok(patchSnapshot);

  await snapshotStore.restoreSnapshot(patchSnapshot.id);
  assert.equal(store.listFacts()[0].text, "Likes tea");
});

test("restoring a memory-fact snapshot backs up the fact it overwrote first, so the restore is itself undoable", async () => {
  const dataDir = createTempDir();
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const store = createAcpMemoryStore({ dataDir, snapshotStore });

  store.rememberFact({ sessionId: "s", key: "favorite-drink", text: "Likes tea" });
  store.rememberFact({ sessionId: "s", key: "favorite-drink", text: "Likes coffee", action: "patch" });
  const beforeRestore = store.listFacts()[0];

  const patchSnapshot = snapshotStore
    .listSnapshots("memory-fact")
    .find((s) => s.summary === "fact patch: favorite-drink");
  await snapshotStore.restoreSnapshot(patchSnapshot.id);

  const backups = snapshotStore
    .listSnapshots("memory-fact")
    .filter((s) => s.summary.startsWith("pre-restore backup"));
  assert.equal(backups.length, 1);
  const backup = snapshotStore.getSnapshot(backups[0].id);
  assert.equal(backup.source, "system");
  assert.deepEqual(backup.payload, beforeRestore, "the backup holds the fact as it stood right before the restore");
});

test("renameSession/setSessionGoal snapshots are tagged source: human -- only reachable via the PATCH /sessions/:id route", () => {
  const dataDir = createTempDir();
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const store = createAcpMemoryStore({ dataDir, snapshotStore });

  store.ensureSession({ sessionId: "source-session-1" });
  store.renameSession("source-session-1", "Renamed");
  store.setSessionGoal("source-session-1", "Ship it");

  const snapshots = snapshotStore.listSnapshots("memory-session");
  assert.ok(snapshots.length >= 2);
  assert.ok(snapshots.every((s) => s.source === "human"));
});

test("appendTurn snapshots are tagged source: agent -- it's automatic conversation bookkeeping, not a human action", async () => {
  const dataDir = createTempDir();
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const store = createAcpMemoryStore({ dataDir, snapshotStore });

  await store.appendTurn({ sessionId: "source-session-2", user: "hi", assistant: "hello" });
  await store.appendTurn({ sessionId: "source-session-2", user: "again", assistant: "hey" });

  const snapshots = snapshotStore.listSnapshots("memory-session");
  const turnSnapshot = snapshots.find((s) => s.summary.startsWith("turn appended"));
  assert.ok(turnSnapshot);
  assert.equal(turnSnapshot.source, "agent");
});

test("rememberFact defaults source to agent -- the primary caller is the model's memory__remember tool", () => {
  const dataDir = createTempDir();
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const store = createAcpMemoryStore({ dataDir, snapshotStore });

  store.rememberFact({ key: "gpu", text: "RTX 5080" });
  store.rememberFact({ key: "gpu", text: "RTX 5080, confirmed", action: "patch" });

  const [patchSnapshot] = snapshotStore.listSnapshots("memory-fact");
  assert.equal(patchSnapshot.source, "agent");
});

test("rememberFact accepts an explicit source override -- used by the human-only admin archive route", () => {
  const dataDir = createTempDir();
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const store = createAcpMemoryStore({ dataDir, snapshotStore });

  store.rememberFact({ key: "gpu", text: "RTX 5080" });
  store.rememberFact({ key: "gpu", action: "archive", source: "human" });

  const snapshots = snapshotStore.listSnapshots("memory-fact");
  const archiveSnapshot = snapshots.find((s) => s.summary.startsWith("fact archive"));
  assert.equal(archiveSnapshot.source, "human");
});
