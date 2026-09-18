const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPronunciationLexiconStore } = require("../pronunciation-lexicon-store");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-pronunciation-lexicon-"));
}

test("listWords returns an empty array when no config file exists yet", () => {
  const store = createPronunciationLexiconStore({ dataDir: createTempDir() });
  assert.deepEqual(store.listWords(), []);
});

test("listWords falls back to an empty array for a malformed config file", () => {
  const dataDir = createTempDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "pronunciation-lexicon.json"), "{ not valid json", "utf8");
  const store = createPronunciationLexiconStore({ dataDir });
  assert.deepEqual(store.listWords(), []);
});

test("addWord persists an entry with a trimmed word/replacement and an id", () => {
  const store = createPronunciationLexiconStore({
    dataDir: createTempDir(),
    now: () => "2026-01-01T00:00:00.000Z",
    makeId: () => "id-1",
  });

  const entry = store.addWord({ word: "  Qwen  ", replacement: "  kwen  " });
  assert.deepEqual(entry, {
    id: "id-1",
    word: "Qwen",
    replacement: "kwen",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(store.listWords(), [entry]);
});

test("addWord requires a non-empty word and replacement", () => {
  const store = createPronunciationLexiconStore({ dataDir: createTempDir() });
  assert.throws(() => store.addWord({ word: "", replacement: "x" }), /word is required/);
  assert.throws(() => store.addWord({ word: "Qwen", replacement: "" }), /replacement is required/);
});

test("addWord rejects a word containing whitespace (single words only)", () => {
  const store = createPronunciationLexiconStore({ dataDir: createTempDir() });
  assert.throws(
    () => store.addWord({ word: "Fish Speech", replacement: "fish speech tts" }),
    /must be a single word/,
  );
});

test("addWord rejects a case-insensitive duplicate word", () => {
  const store = createPronunciationLexiconStore({ dataDir: createTempDir() });
  store.addWord({ word: "Qwen", replacement: "kwen" });
  assert.throws(
    () => store.addWord({ word: "qwen", replacement: "kevin" }),
    /already exists/,
  );
  assert.equal(store.listWords().length, 1);
});

test("updateWord edits word and/or replacement independently", () => {
  const store = createPronunciationLexiconStore({ dataDir: createTempDir(), makeId: () => "id-1" });
  store.addWord({ word: "Qwen", replacement: "kwen" });

  const renamed = store.updateWord("id-1", { word: "Qwenn" });
  assert.equal(renamed.word, "Qwenn");
  assert.equal(renamed.replacement, "kwen");

  const reworded = store.updateWord("id-1", { replacement: "kwenn" });
  assert.equal(reworded.word, "Qwenn");
  assert.equal(reworded.replacement, "kwenn");
});

test("updateWord returns null for an unknown id and rejects clearing a field to empty", () => {
  const store = createPronunciationLexiconStore({ dataDir: createTempDir(), makeId: () => "id-1" });
  store.addWord({ word: "Qwen", replacement: "kwen" });

  assert.equal(store.updateWord("missing", { word: "x" }), null);
  assert.throws(() => store.updateWord("id-1", { word: "" }), /word is required/);
  assert.throws(() => store.updateWord("id-1", { replacement: "" }), /replacement is required/);
});

test("updateWord rejects renaming to a word that collides with a different entry", () => {
  let nextId = 1;
  const store = createPronunciationLexiconStore({ dataDir: createTempDir(), makeId: () => `id-${nextId++}` });
  store.addWord({ word: "Qwen", replacement: "kwen" });
  const other = store.addWord({ word: "Llama", replacement: "lah-ma" });

  assert.throws(
    () => store.updateWord(other.id, { word: "qwen" }),
    /already exists/,
  );
});

test("updateWord allows re-saving an entry's own word unchanged", () => {
  const store = createPronunciationLexiconStore({ dataDir: createTempDir(), makeId: () => "id-1" });
  store.addWord({ word: "Qwen", replacement: "kwen" });

  const updated = store.updateWord("id-1", { word: "Qwen", replacement: "kwenn" });
  assert.equal(updated.word, "Qwen");
  assert.equal(updated.replacement, "kwenn");
});

test("removeWord deletes a persisted entry and returns false for an unknown id", () => {
  const store = createPronunciationLexiconStore({ dataDir: createTempDir() });
  const entry = store.addWord({ word: "Qwen", replacement: "kwen" });
  assert.equal(store.removeWord(entry.id), true);
  assert.deepEqual(store.listWords(), []);
  assert.equal(store.removeWord(entry.id), false);
});

test("entries persist across a fresh store instance pointed at the same dataDir", () => {
  const dataDir = createTempDir();
  const storeA = createPronunciationLexiconStore({ dataDir });
  storeA.addWord({ word: "Qwen", replacement: "kwen" });

  const storeB = createPronunciationLexiconStore({ dataDir });
  assert.equal(storeB.listWords().length, 1);
});
