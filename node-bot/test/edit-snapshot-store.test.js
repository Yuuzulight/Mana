const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEditSnapshotStore } = require("../edit-snapshot-store");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-edit-snapshots-"));
}

test("recordSnapshot persists a snapshot and getSnapshot reads it back with full content", () => {
  const store = createEditSnapshotStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
    idFactory: () => "snap-1",
  });

  const recorded = store.recordSnapshot({
    proposalId: "proposal-1",
    relativePath: "src/app.js",
    originalContent: "const value = 1;\n",
    summary: "Update value",
  });

  assert.equal(recorded.id, "snap-1");
  assert.equal(recorded.proposalId, "proposal-1");
  assert.equal(recorded.relativePath, "src/app.js");
  assert.equal(recorded.summary, "Update value");
  assert.equal(recorded.appliedAt, "2026-06-29T00:00:00.000Z");
  // recordSnapshot's own return value is metadata only, same as listSnapshots.
  assert.equal(recorded.originalContent, undefined);

  const full = store.getSnapshot("snap-1");
  assert.equal(full.originalContent, "const value = 1;\n");
});

test("listSnapshots returns metadata only (not originalContent), newest first", () => {
  const dataDir = createTempDir();
  let counter = 0;
  const store = createEditSnapshotStore({
    dataDir,
    now: () => `2026-06-29T00:0${counter++}:00.000Z`,
    idFactory: () => `snap-${counter}`,
  });

  store.recordSnapshot({ relativePath: "a.js", originalContent: "old a" });
  store.recordSnapshot({ relativePath: "b.js", originalContent: "old b" });

  const list = store.listSnapshots();
  assert.equal(list.length, 2);
  assert.equal(list[0].relativePath, "b.js");
  assert.equal(list[1].relativePath, "a.js");
  assert.equal(list[0].originalContent, undefined);
});

test("getSnapshot returns null for an unknown id", () => {
  const store = createEditSnapshotStore({ dataDir: createTempDir() });
  assert.equal(store.getSnapshot("no-such-snapshot"), null);
});

test("deleteSnapshot removes a snapshot and reports whether one existed", () => {
  const store = createEditSnapshotStore({
    dataDir: createTempDir(),
    idFactory: () => "snap-delete",
  });
  store.recordSnapshot({ relativePath: "a.js", originalContent: "old" });

  assert.equal(store.deleteSnapshot("snap-delete"), true);
  assert.equal(store.getSnapshot("snap-delete"), null);
  assert.equal(store.deleteSnapshot("snap-delete"), false);
});

test("recordSnapshot prunes the oldest snapshots once maxRetained is exceeded", () => {
  const dataDir = createTempDir();
  let tick = 0;
  let idCounter = 0;
  const store = createEditSnapshotStore({
    dataDir,
    maxRetained: 2,
    now: () => `2026-06-29T00:0${++tick}:00.000Z`,
    idFactory: () => `snap-${++idCounter}`,
  });

  const a = store.recordSnapshot({ relativePath: "a.js", originalContent: "old a" });
  store.recordSnapshot({ relativePath: "b.js", originalContent: "old b" });
  store.recordSnapshot({ relativePath: "c.js", originalContent: "old c" });

  const list = store.listSnapshots();
  assert.equal(list.length, 2);
  // Newest two survive; the oldest (a.js) was pruned.
  assert.deepEqual(list.map((s) => s.relativePath), ["c.js", "b.js"]);
  assert.equal(store.getSnapshot(a.id), null);
});

test("getSnapshot and deleteSnapshot reject a path-traversal id instead of escaping dataDir", () => {
  const dataDir = createTempDir();
  const store = createEditSnapshotStore({ dataDir });
  const outsideFile = path.join(path.dirname(dataDir), "outside.json");
  fs.writeFileSync(outsideFile, JSON.stringify({ secret: true }));

  try {
    // id ultimately comes from a REST route param (POST .../snapshots/:id/restore) --
    // must not be able to read or delete a file outside dataDir via "..".
    const traversalId = "../outside";
    assert.equal(store.getSnapshot(traversalId), null);
    assert.equal(store.deleteSnapshot(traversalId), false);
    assert.equal(fs.existsSync(outsideFile), true);
  } finally {
    fs.rmSync(outsideFile, { force: true });
  }
});

test("a non-numeric maxRetained falls back to the default instead of pruning everything", () => {
  const store = createEditSnapshotStore({
    dataDir: createTempDir(),
    idFactory: () => "snap-nan-guard",
    maxRetained: "unlimited",
  });

  store.recordSnapshot({ relativePath: "a.js", originalContent: "old" });

  // Number("unlimited") is NaN; NaN must not defeat pruneOldest's own
  // bounds check and delete every snapshot right after it's written.
  assert.equal(store.listSnapshots().length, 1);
});

test("listSnapshots and recordSnapshot create the data directory on demand", () => {
  const dataDir = path.join(createTempDir(), "nested", "edit-snapshots");
  assert.equal(fs.existsSync(dataDir), false);

  const store = createEditSnapshotStore({ dataDir });
  assert.deepEqual(store.listSnapshots(), []);
  assert.equal(fs.existsSync(dataDir), true);

  store.recordSnapshot({ relativePath: "a.js", originalContent: "old" });
  assert.equal(store.listSnapshots().length, 1);
});
