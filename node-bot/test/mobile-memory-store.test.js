const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createMobileMemoryStore } = require("../mobile-memory-store");

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-mobile-store-"));
  return {
    dir,
    store: createMobileMemoryStore({
      dataDir: dir,
      now: () => "2026-06-27T00:00:00.000Z",
    }),
  };
}

test("saveSummary persists and lists phone summaries", () => {
  const { store } = makeTempStore();

  const saved = store.saveSummary({
    id: "phone-1",
    source: "phone",
    direction: "phone-to-pc",
    chatId: "chat-1",
    title: "Dinner plans",
    summary: "The user talked about dinner plans.",
  });

  assert.equal(saved.id, "phone-1");
  assert.equal(saved.createdAt, "2026-06-27T00:00:00.000Z");
  assert.deepEqual(store.listSummaries({ direction: "phone-to-pc" }), [saved]);
});

test("saveSummary is idempotent for duplicate ids", () => {
  const { store } = makeTempStore();

  const first = store.saveSummary({
    id: "same-id",
    source: "phone",
    direction: "phone-to-pc",
    chatId: "chat-1",
    summary: "First summary.",
  });
  const second = store.saveSummary({
    id: "same-id",
    source: "phone",
    direction: "phone-to-pc",
    chatId: "chat-1",
    summary: "Different summary should not duplicate.",
  });

  assert.equal(second.id, first.id);
  assert.equal(store.listSummaries().length, 1);
  assert.equal(store.listSummaries()[0].summary, "First summary.");
});

test("createMobileMemoryStore reloads existing summaries from disk", () => {
  const { dir, store } = makeTempStore();
  store.saveSummary({
    id: "persisted",
    source: "pc",
    direction: "pc-to-phone",
    chatId: "desktop",
    summary: "PC note for phone.",
  });

  const reloaded = createMobileMemoryStore({ dataDir: dir });

  assert.equal(reloaded.listSummaries()[0].id, "persisted");
  assert.equal(reloaded.listSummaries({ direction: "pc-to-phone" }).length, 1);
});
