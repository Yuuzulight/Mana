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

test("recordSnapshot stores and returns the source field; listSnapshots includes it", () => {
  const store = createSnapshotStore({
    dataDir: createTempDir(),
    now: () => "2026-08-25T00:00:00.000Z",
    idFactory: () => "snap-src-1",
  });

  const recorded = store.recordSnapshot({
    kind: "file",
    key: "a.txt",
    scope: "/repo",
    payload: "content",
    summary: "test write",
    source: "human",
  });
  assert.equal(recorded.source, "human");

  const [listed] = store.listSnapshots("file");
  assert.equal(listed.source, "human");

  const full = store.getSnapshot("snap-src-1");
  assert.equal(full.source, "human");
});

test("recordSnapshot without a source stays null -- backward compatible with pre-#475 snapshots", () => {
  const store = createSnapshotStore({
    dataDir: createTempDir(),
    now: () => "2026-08-25T00:00:00.000Z",
    idFactory: () => "snap-src-2",
  });

  const recorded = store.recordSnapshot({
    kind: "skill",
    key: "x.md",
    payload: "body",
    summary: "no source given",
  });
  assert.equal(recorded.source, null);

  const [listed] = store.listSnapshots("skill");
  assert.equal(listed.source, null);
});

test("checkStale reports not stale when nothing else has touched the target since", () => {
  const store = createSnapshotStore({
    dataDir: createTempDir(),
    now: () => "2026-08-25T00:00:00.000Z",
    idFactory: () => "snap-stale-1",
  });
  store.recordSnapshot({ kind: "file", key: "a.txt", scope: "/repo", payload: "old", summary: "s1" });

  assert.deepEqual(store.checkStale("snap-stale-1"), { stale: false });
});

test("checkStale reports stale when a newer snapshot exists for the same kind+key+scope", () => {
  let tick = 0;
  const timestamps = ["2026-08-25T00:00:00.000Z", "2026-08-25T00:01:00.000Z"];
  const ids = ["snap-stale-2a", "snap-stale-2b"];
  const store = createSnapshotStore({
    dataDir: createTempDir(),
    now: () => timestamps[tick++],
    idFactory: () => ids[tick],
  });

  store.recordSnapshot({ kind: "file", key: "a.txt", scope: "/repo", payload: "v1", summary: "first write" });
  store.recordSnapshot({ kind: "file", key: "a.txt", scope: "/repo", payload: "v2", summary: "second write" });

  const staleness = store.checkStale("snap-stale-2a");
  assert.equal(staleness.stale, true);
  assert.equal(staleness.newerSnapshotId, "snap-stale-2b");
  assert.equal(staleness.newerAppliedAt, "2026-08-25T00:01:00.000Z");

  // The newer one isn't stale relative to itself -- nothing came after it.
  assert.deepEqual(store.checkStale("snap-stale-2b"), { stale: false });
});

test("checkStale ignores snapshots for a different key or scope, even the same kind", () => {
  const store = createSnapshotStore({ dataDir: createTempDir() });
  const a = store.recordSnapshot({ kind: "file", key: "a.txt", scope: "/repo", payload: "1", summary: "a" });
  store.recordSnapshot({ kind: "file", key: "b.txt", scope: "/repo", payload: "2", summary: "b" });
  store.recordSnapshot({ kind: "file", key: "a.txt", scope: "/other-repo", payload: "3", summary: "c" });

  assert.deepEqual(store.checkStale(a.id), { stale: false });
});

test("restoreSnapshot returns stale: true instead of restoring, when the target changed since -- and leaves both snapshots in place", async () => {
  let tick = 0;
  const timestamps = ["2026-08-25T00:00:00.000Z", "2026-08-25T00:01:00.000Z"];
  const ids = ["snap-stale-3a", "snap-stale-3b"];
  const store = createSnapshotStore({
    dataDir: createTempDir(),
    now: () => timestamps[tick++],
    idFactory: () => ids[tick],
  });
  store.registerRestorer("file", async () => ({ restored: true }));

  store.recordSnapshot({ kind: "file", key: "a.txt", scope: "/repo", payload: "v1", summary: "first" });
  store.recordSnapshot({ kind: "file", key: "a.txt", scope: "/repo", payload: "v2", summary: "second" });

  const result = await store.restoreSnapshot("snap-stale-3a");
  assert.equal(result.stale, true);
  assert.equal(result.id, "snap-stale-3a");
  assert.equal(result.newerSnapshotId, "snap-stale-3b");
  assert.ok(store.getSnapshot("snap-stale-3a"), "the stale snapshot must not be deleted");
  assert.ok(store.getSnapshot("snap-stale-3b"), "the newer snapshot must not be touched either");
});

test("restoreSnapshot with confirmStale: true proceeds anyway and deletes the snapshot", async () => {
  let tick = 0;
  const timestamps = ["2026-08-25T00:00:00.000Z", "2026-08-25T00:01:00.000Z"];
  const ids = ["snap-stale-4a", "snap-stale-4b"];
  const store = createSnapshotStore({
    dataDir: createTempDir(),
    now: () => timestamps[tick++],
    idFactory: () => ids[tick],
  });
  const restoredWith = [];
  store.registerRestorer("file", async (key, payload, scope) => {
    restoredWith.push({ key, payload, scope });
    return { restored: true };
  });

  store.recordSnapshot({ kind: "file", key: "a.txt", scope: "/repo", payload: "v1", summary: "first" });
  store.recordSnapshot({ kind: "file", key: "a.txt", scope: "/repo", payload: "v2", summary: "second" });

  const result = await store.restoreSnapshot("snap-stale-4a", { confirmStale: true });
  assert.deepEqual(result, { restored: true });
  assert.equal(restoredWith.length, 1);
  assert.equal(restoredWith[0].payload, "v1");
  assert.equal(store.getSnapshot("snap-stale-4a"), null, "confirmed restore must still delete the snapshot");
});

test("hasRestorer reports true for a registered kind and false for an unregistered one", () => {
  const store = createSnapshotStore({ dataDir: createTempDir() });
  assert.equal(store.hasRestorer("file"), true, "the built-in file restorer is always registered");
  assert.equal(store.hasRestorer("memory-session"), false);

  store.registerRestorer("widget", async () => ({ ok: true }));
  assert.equal(store.hasRestorer("widget"), true);
});

test("restoreSnapshot's non-stale return shape is unchanged -- backward compatible with every existing caller", async () => {
  const store = createSnapshotStore({
    dataDir: createTempDir(),
    idFactory: () => "snap-stale-5",
  });
  store.registerRestorer("file", async () => ({ restoredPath: "/repo/a.txt" }));
  store.recordSnapshot({ kind: "file", key: "a.txt", scope: "/repo", payload: "v1", summary: "only write" });

  const result = await store.restoreSnapshot("snap-stale-5");
  assert.deepEqual(result, { restoredPath: "/repo/a.txt" });
  assert.equal(store.getSnapshot("snap-stale-5"), null);
});
