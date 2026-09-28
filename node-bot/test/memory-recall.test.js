// Issue #674: memory recall -- more candidates (key, keyword, vector), a
// hard per-turn cap with pinned facts, and silent fallback when the
// embedder is off, slow or failing.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAcpMemoryStore, factRecallCandidates } = require("../acp-memory-store");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-memory-recall-"));
}

function factLines(entries) {
  const facts = entries.find((e) => e.content.startsWith("Remembered:"));
  return facts ? facts.content.split("\n").filter((l) => l.startsWith("- ")) : [];
}

// Two-dimensional fake embedder: anything about graphics hardware points
// one way, everything else the other.
function fakeEmbeddings(calls = []) {
  return async (texts) => {
    calls.push(texts);
    return texts.map((t) => (/gpu|graphics/i.test(t) ? [1, 0] : [0, 1]));
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("factRecallCandidates finds the GPU fact by keyword overlap on its text", () => {
  const facts = [
    { key: "the user's GPU", text: "NVIDIA RTX 5080 graphics card", status: "active" },
    { key: "snack", text: "they have chips on Fridays", status: "active" },
  ];
  const { candidates } = factRecallCandidates(facts, "what graphics card do I have?");
  // "have" alone is one shared word -- not enough to pull in the snack fact.
  assert.deepEqual(candidates.map((f) => f.key), ["the user's GPU"]);
});

test("factRecallCandidates keeps key hits first in #364 order, then scored matches", () => {
  const facts = [
    { key: "card", text: "a birthday card for mum", status: "active", updatedAt: "2026-01-01" },
    { id: "v", key: "rig", text: "RTX 5080", status: "active" },
    { key: "graphics card", text: "RTX 5080", status: "active", updatedAt: "2026-01-01" },
  ];
  const { candidates } = factRecallCandidates(
    facts,
    "which graphics card should I upgrade to?",
    new Map([["v", 0.9]]),
  );
  assert.deepEqual(candidates.map((f) => f.key), ["graphics card", "card", "rig"]);
});

test("factRecallCandidates never surfaces unverified, archived or invalidated facts, pinned or not", () => {
  const facts = [
    { key: "gpu", text: "x", status: "active", unverifiedSource: true, pinned: true },
    { key: "gpu two", text: "x", status: "archived" },
    { key: "gpu three", text: "x", status: "active", invalidatedAt: "2026-01-01" },
  ];
  const { pinned, candidates } = factRecallCandidates(facts, "gpu gpu two gpu three");
  assert.equal(pinned.length, 0);
  assert.equal(candidates.length, 0);
});

test("a fact is recalled by meaning when the embedder is up, once its vector is cached", async () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    computeEmbeddingsFn: fakeEmbeddings(),
  });
  store.rememberFact({ key: "the user's GPU", text: "RTX 5080" });

  // First turn: no fact vectors yet, so nothing but a background backfill.
  const first = await store.getRelatedFactsEntries("what graphics card do I have?");
  assert.equal(factLines(first.entries).length, 0);
  await tick();

  const second = await store.getRelatedFactsEntries("what graphics card do I have?");
  assert.deepEqual(factLines(second.entries), ["- the user's GPU: RTX 5080"]);
  assert.equal(second.recall.fallback, null);
});

test("fact vectors persist across store instances and are recomputed after a patch", async () => {
  const dataDir = createTempDir();
  const calls = [];
  const store = createAcpMemoryStore({ dataDir, computeEmbeddingsFn: fakeEmbeddings(calls) });
  store.rememberFact({ key: "rig", text: "RTX 5080 graphics" });
  await store.getRelatedFactsEntries("hello there");
  await tick();
  assert.ok(calls.some((texts) => texts.includes("rig: RTX 5080 graphics")));

  const reopenedCalls = [];
  const reopened = createAcpMemoryStore({ dataDir, computeEmbeddingsFn: fakeEmbeddings(reopenedCalls) });
  await reopened.getRelatedFactsEntries("hello there");
  await tick();
  // Only the query was embedded -- the fact vector came from disk.
  assert.deepEqual(reopenedCalls, [["hello there"]]);

  reopened.rememberFact({ key: "rig", text: "RTX 4090 graphics", action: "patch" });
  await reopened.getRelatedFactsEntries("hello there");
  await tick();
  assert.ok(reopenedCalls.some((texts) => texts.includes("rig: RTX 4090 graphics")));

  // A different vector length means the embedding model changed: re-embed.
  const resizedCalls = [];
  const resized = createAcpMemoryStore({
    dataDir,
    computeEmbeddingsFn: async (texts) => {
      resizedCalls.push(texts);
      return texts.map(() => [1, 0, 0]);
    },
  });
  await resized.getRelatedFactsEntries("hello there");
  await tick();
  assert.ok(resizedCalls.some((texts) => texts.includes("rig: RTX 4090 graphics")));
});

test("never more than 5 pinned + 5 matched facts, whatever the store size", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  for (let i = 0; i < 50; i++) store.rememberFact({ key: `gpu note ${i}`, text: "graphics card detail" });
  for (let i = 0; i < 7; i++) {
    store.rememberFact({ key: `pinned ${i}`, text: "always relevant" });
    store.setFactPinned(`pinned ${i}`, true);
  }

  const { entries, recall } = await store.getRelatedFactsEntries(
    "tell me about my graphics card",
    { maxChars: 100000 },
  );
  const lines = factLines(entries);
  assert.equal(lines.filter((l) => l.startsWith("- pinned")).length, 5);
  assert.equal(lines.filter((l) => l.startsWith("- gpu note")).length, 5);
  // Pinned first, so the block's start is the same every turn (#660).
  assert.ok(lines[0].startsWith("- pinned"));
  assert.deepEqual(
    { candidates: recall.candidates, pinned: recall.pinned, matched: recall.matched },
    { candidates: 20, pinned: 5, matched: 5 },
  );
  // The sync string form shares the same cap.
  const flat = store.getRelatedFacts("tell me about my graphics card", { maxChars: 100000 });
  assert.equal(flat.split("\n").filter((l) => l.startsWith("- ")).length, 10);
});

test("MANA_MEMORY_MAX_MATCHED_FACTS changes the matched cap", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  for (let i = 0; i < 10; i++) store.rememberFact({ key: `gpu note ${i}`, text: "graphics card" });
  process.env.MANA_MEMORY_MAX_MATCHED_FACTS = "2";
  try {
    const { recall } = await store.getRelatedFactsEntries("my graphics card", { maxChars: 100000 });
    assert.equal(recall.matched, 2);
  } finally {
    delete process.env.MANA_MEMORY_MAX_MATCHED_FACTS;
  }
});

test("a pinned fact is injected even when the message never mentions it", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  store.rememberFact({ key: "name", text: "Yuuzu" });
  assert.deepEqual(store.setFactPinned("NAME", true), { key: "NAME", found: true, pinned: true });
  const { entries } = await store.getRelatedFactsEntries("good morning!");
  assert.deepEqual(factLines(entries), ["- name: Yuuzu"]);

  store.setFactPinned("name", false);
  assert.equal(store.listFacts()[0].pinned, undefined);
  assert.equal(store.setFactPinned("missing", true).found, false);
});

test("an embedder timeout falls back to key/keyword recall and reports why", async () => {
  process.env.MANA_MEMORY_RECALL_TIMEOUT_MS = "20";
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    let embedCalls = 0;
    const store = createAcpMemoryStore({
      dataDir: createTempDir(),
      computeEmbeddingsFn: () => {
        embedCalls++;
        return new Promise(() => {});
      },
    });
    store.rememberFact({ key: "gpu", text: "RTX 5080" });
    const { entries, recall } = await store.getRelatedFactsEntries("is my gpu fast enough?");
    assert.deepEqual(factLines(entries), ["- gpu: RTX 5080"]);
    assert.match(recall.fallback, /timed out after 20ms/);
    assert.ok(warnings.some((w) => /falling back/.test(w)));

    // The next turn doesn't wait on the embedder again right away.
    const next = await store.getRelatedFactsEntries("is my gpu fast enough?");
    assert.match(next.recall.fallback, /skipped after a recent failure/);
    assert.equal(embedCalls, 1);
  } finally {
    console.warn = warn;
    delete process.env.MANA_MEMORY_RECALL_TIMEOUT_MS;
  }
});

test("embeddings off (null vectors) is a quiet fallback, not an error", async () => {
  const store = createAcpMemoryStore({
    dataDir: createTempDir(),
    computeEmbeddingsFn: async (texts) => texts.map(() => null),
  });
  store.rememberFact({ key: "gpu", text: "RTX 5080" });
  const { entries, recall } = await store.getRelatedFactsEntries("is my gpu fast enough?");
  assert.deepEqual(factLines(entries), ["- gpu: RTX 5080"]);
  assert.equal(recall.fallback, "embeddings unavailable");
});
