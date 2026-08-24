const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createSnapshotStore } = require("../snapshot-store");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-snapshot-store-"));
}

test("recordSnapshot persists a snapshot and getSnapshot reads it back with full payload", () => {
  const store = createSnapshotStore({
    dataDir: createTempDir(),
    now: () => "2026-06-29T00:00:00.000Z",
    idFactory: () => "snap-1",
  });

  const recorded = store.recordSnapshot({
    kind: "skill",
    key: "restart-searxng.md",
    payload: "raw skill file content",
    summary: "skill update",
  });

  assert.equal(recorded.id, "snap-1");
  assert.equal(recorded.kind, "skill");
  assert.equal(recorded.key, "restart-searxng.md");
  assert.equal(recorded.scope, null);
  assert.equal(recorded.summary, "skill update");
  assert.equal(recorded.appliedAt, "2026-06-29T00:00:00.000Z");
  // recordSnapshot's own return value is metadata only, same as listSnapshots.
  assert.equal(recorded.payload, undefined);

  const full = store.getSnapshot("snap-1");
  assert.equal(full.payload, "raw skill file content");
});

test("listSnapshots returns metadata only (not payload), newest first", () => {
  const dataDir = createTempDir();
  let counter = 0;
  const store = createSnapshotStore({
    dataDir,
    now: () => `2026-06-29T00:0${counter++}:00.000Z`,
    idFactory: () => `snap-${counter}`,
  });

  store.recordSnapshot({ kind: "file", key: "a.js", payload: "old a" });
  store.recordSnapshot({ kind: "file", key: "b.js", payload: "old b" });

  const list = store.listSnapshots();
  assert.equal(list.length, 2);
  assert.equal(list[0].key, "b.js");
  assert.equal(list[1].key, "a.js");
  assert.equal(list[0].payload, undefined);
});

test("listSnapshots(kind) only returns that kind's entries while listSnapshots() returns all of them", () => {
  const store = createSnapshotStore({ dataDir: createTempDir() });
  store.recordSnapshot({ kind: "file", key: "a.js", payload: "old a" });
  store.recordSnapshot({ kind: "memory-session", key: "session-1", payload: {} });
  store.recordSnapshot({ kind: "skill", key: "skill.md", payload: "body" });

  assert.equal(store.listSnapshots("file").length, 1);
  assert.equal(store.listSnapshots("memory-session").length, 1);
  assert.equal(store.listSnapshots("skill").length, 1);
  assert.equal(store.listSnapshots("memory-fact").length, 0);
  assert.equal(store.listSnapshots().length, 3);
});

test("getSnapshot returns null for an unknown id", () => {
  const store = createSnapshotStore({ dataDir: createTempDir() });
  assert.equal(store.getSnapshot("no-such-snapshot"), null);
});

test("deleteSnapshot removes a snapshot and reports whether one existed", () => {
  const store = createSnapshotStore({
    dataDir: createTempDir(),
    idFactory: () => "snap-delete",
  });
  store.recordSnapshot({ kind: "file", key: "a.js", payload: "old" });

  assert.equal(store.deleteSnapshot("snap-delete"), true);
  assert.equal(store.getSnapshot("snap-delete"), null);
  assert.equal(store.deleteSnapshot("snap-delete"), false);
});

test("recordSnapshot prunes the oldest snapshots once maxRetained is exceeded, scoped to one kind", () => {
  const dataDir = createTempDir();
  let tick = 0;
  let idCounter = 0;
  const store = createSnapshotStore({
    dataDir,
    maxRetained: 2,
    now: () => `2026-06-29T00:0${++tick}:00.000Z`,
    idFactory: () => `snap-${++idCounter}`,
  });

  const a = store.recordSnapshot({ kind: "file", key: "a.js", payload: "old a" });
  store.recordSnapshot({ kind: "file", key: "b.js", payload: "old b" });
  store.recordSnapshot({ kind: "file", key: "c.js", payload: "old c" });
  // A different kind's own pool must not be touched by pruning the "file"
  // pool above -- filling one kind's pool past maxRetained must never evict
  // another kind's snapshots.
  const skillSnap = store.recordSnapshot({ kind: "skill", key: "skill.md", payload: "body" });

  const fileList = store.listSnapshots("file");
  assert.equal(fileList.length, 2);
  // Newest two survive; the oldest (a.js) was pruned.
  assert.deepEqual(fileList.map((s) => s.key), ["c.js", "b.js"]);
  assert.equal(store.getSnapshot(a.id), null);
  assert.ok(store.getSnapshot(skillSnap.id));
});

test("getSnapshot and deleteSnapshot reject a path-traversal id instead of escaping dataDir", () => {
  const dataDir = createTempDir();
  const store = createSnapshotStore({ dataDir });
  const outsideFile = path.join(path.dirname(dataDir), "outside.json");
  fs.writeFileSync(outsideFile, JSON.stringify({ secret: true }));

  try {
    const traversalId = "../outside";
    assert.equal(store.getSnapshot(traversalId), null);
    assert.equal(store.deleteSnapshot(traversalId), false);
    assert.equal(fs.existsSync(outsideFile), true);
  } finally {
    fs.rmSync(outsideFile, { force: true });
  }
});

test("a non-numeric maxRetained falls back to the default instead of pruning everything", () => {
  const store = createSnapshotStore({
    dataDir: createTempDir(),
    idFactory: () => "snap-nan-guard",
    maxRetained: "unlimited",
  });

  store.recordSnapshot({ kind: "file", key: "a.js", payload: "old" });

  assert.equal(store.listSnapshots().length, 1);
});

test("listSnapshots and recordSnapshot create the data directory on demand", () => {
  const dataDir = path.join(createTempDir(), "nested", "snapshots");
  assert.equal(fs.existsSync(dataDir), false);

  const store = createSnapshotStore({ dataDir });
  assert.deepEqual(store.listSnapshots(), []);
  assert.equal(fs.existsSync(dataDir), true);

  store.recordSnapshot({ kind: "file", key: "a.js", payload: "old" });
  assert.equal(store.listSnapshots().length, 1);
});

test("restoreSnapshot uses the built-in file restorer to write, verify, and delete", async () => {
  const dataDir = createTempDir();
  const targetDir = createTempDir();
  fs.writeFileSync(path.join(targetDir, "out.txt"), "new content", "utf8");
  const store = createSnapshotStore({ dataDir, idFactory: () => "snap-file-restore" });

  store.recordSnapshot({
    kind: "file",
    key: "out.txt",
    scope: targetDir,
    payload: "previous content",
  });

  const result = await store.restoreSnapshot("snap-file-restore");
  assert.equal(result.restoredPath, path.join(targetDir, "out.txt"));
  assert.equal(fs.readFileSync(path.join(targetDir, "out.txt"), "utf8"), "previous content");
  assert.equal(store.getSnapshot("snap-file-restore"), null);
});

test("restoreSnapshot round-trips through a custom registered restorer", async () => {
  const store = createSnapshotStore({ dataDir: createTempDir(), idFactory: () => "snap-custom-1" });
  const restored = [];
  store.registerRestorer("widget", async (key, payload, scope) => {
    restored.push({ key, payload, scope });
    return { ok: true };
  });

  store.recordSnapshot({ kind: "widget", key: "widget-1", scope: "root", payload: { count: 2 } });
  const result = await store.restoreSnapshot("snap-custom-1");

  assert.deepEqual(result, { ok: true });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].key, "widget-1");
  assert.deepEqual(restored[0].payload, { count: 2 });
  assert.equal(restored[0].scope, "root");
  assert.equal(store.getSnapshot("snap-custom-1"), null);
});

test("restoreSnapshot throws loudly when no restorer is registered for the kind", async () => {
  const store = createSnapshotStore({ dataDir: createTempDir(), idFactory: () => "snap-no-restorer" });
  store.recordSnapshot({ kind: "unregistered-kind", key: "x", payload: "y" });

  await assert.rejects(
    () => store.restoreSnapshot("snap-no-restorer"),
    /no restorer registered for kind: unregistered-kind/,
  );
});

test("restoreSnapshot rejects an unknown snapshot id", async () => {
  const store = createSnapshotStore({ dataDir: createTempDir() });
  await assert.rejects(() => store.restoreSnapshot("no-such-snapshot"), /snapshot not found/);
});

test("a throwing restorer leaves the snapshot in place for a retry rather than deleting it", async () => {
  const store = createSnapshotStore({ dataDir: createTempDir(), idFactory: () => "snap-retry-1" });
  let attempts = 0;
  store.registerRestorer("flaky", async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("transient failure");
    }
    return { ok: true };
  });

  store.recordSnapshot({ kind: "flaky", key: "x", payload: "y" });

  await assert.rejects(() => store.restoreSnapshot("snap-retry-1"), /transient failure/);
  // Still there after the failed attempt -- not deleted.
  assert.ok(store.getSnapshot("snap-retry-1"));

  const result = await store.restoreSnapshot("snap-retry-1");
  assert.deepEqual(result, { ok: true });
  assert.equal(store.getSnapshot("snap-retry-1"), null);
});
