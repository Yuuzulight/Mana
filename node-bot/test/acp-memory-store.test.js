const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAcpMemoryStore, extractEntities } = require("../acp-memory-store");

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
