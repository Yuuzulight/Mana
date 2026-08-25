// Create node-bot/test/snapshot-tool-source.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  SNAPSHOT_TOOL_PREFIX,
  isSnapshotToolName,
  createSnapshotToolSource,
  previewRestore,
  buildRestoreSummary,
} = require("../ai/snapshot-tool-source");
const { createApprovalGate } = require("../approval-gate");
const { createSnapshotStore } = require("../snapshot-store");

function fakeSnapshotStore(overrides = {}) {
  return {
    listSnapshots: () => [],
    getSnapshot: () => null,
    checkStale: () => ({ stale: false }),
    restoreSnapshot: async () => ({ restored: true }),
    hasRestorer: () => true,
    ...overrides,
  };
}

function fakeApprovalGate({ requestThrows } = {}) {
  const requestCalls = [];
  const executors = new Map();
  return {
    requestCalls,
    executors,
    registerExecutor: (actionType, fn) => executors.set(actionType, fn),
    requestApproval: async (actionType, details) => {
      requestCalls.push({ actionType, details });
      if (requestThrows) throw requestThrows;
      return { status: "pending", requestId: "req-1", summary: details.summary, flags: [] };
    },
  };
}

test("isSnapshotToolName only matches the snapshot__ prefix", () => {
  assert.equal(isSnapshotToolName("snapshot__list"), true);
  assert.equal(isSnapshotToolName("snapshot__restore"), true);
  assert.equal(isSnapshotToolName("skill__create"), false);
  assert.equal(isSnapshotToolName(undefined), false);
});

test("createSnapshotToolSource throws without approvalGate or snapshotStore", () => {
  assert.throws(() => createSnapshotToolSource({ snapshotStore: fakeSnapshotStore() }), /approvalGate is required/);
  assert.throws(() => createSnapshotToolSource({ approvalGate: fakeApprovalGate() }), /snapshotStore is required/);
});

test("createSnapshotToolSource registers a snapshot-restore executor at construction", () => {
  const approvalGate = fakeApprovalGate();
  createSnapshotToolSource({ approvalGate, snapshotStore: fakeSnapshotStore() });
  assert.equal(approvalGate.executors.has("snapshot-restore"), true);
});

test("the registered snapshot-restore executor always confirms staleness -- staleness was already shown to the human in the approval summary", async () => {
  const approvalGate = fakeApprovalGate();
  const restoreCalls = [];
  const snapshotStore = fakeSnapshotStore({
    restoreSnapshot: async (id, opts) => {
      restoreCalls.push({ id, opts });
      return { restored: true };
    },
  });
  createSnapshotToolSource({ approvalGate, snapshotStore });

  const executor = approvalGate.executors.get("snapshot-restore");
  await executor({ id: "snap-1" });
  assert.deepEqual(restoreCalls, [{ id: "snap-1", opts: { confirmStale: true } }]);
});

test("snapshot__list wraps listSnapshots(kind) as JSON", async () => {
  const snapshotStore = fakeSnapshotStore({
    listSnapshots: (kind) => [{ id: "s1", kind: kind || "file", key: "a.txt" }],
  });
  const source = createSnapshotToolSource({ approvalGate: fakeApprovalGate(), snapshotStore });

  const result = JSON.parse(await source.executeTool(`${SNAPSHOT_TOOL_PREFIX}list`, { kind: "file" }));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.snapshots, [{ id: "s1", kind: "file", key: "a.txt" }]);
});

test("snapshot__restore errors cleanly on an unknown id, without ever contacting the approval gate", async () => {
  const approvalGate = fakeApprovalGate();
  const snapshotStore = fakeSnapshotStore({ getSnapshot: () => null });
  const source = createSnapshotToolSource({ approvalGate, snapshotStore });

  const result = JSON.parse(await source.executeTool(`${SNAPSHOT_TOOL_PREFIX}restore`, { id: "nope" }));
  assert.equal(result.status, "error");
  assert.equal(approvalGate.requestCalls.length, 0);
});

test("snapshot__restore errors cleanly on a kind with no registered restorer, without ever contacting the approval gate", async () => {
  const approvalGate = fakeApprovalGate();
  const record = { id: "snap-1", kind: "memory-session", key: "s1", scope: null, summary: "x", appliedAt: "t" };
  const snapshotStore = fakeSnapshotStore({
    getSnapshot: (id) => (id === "snap-1" ? record : null),
    hasRestorer: (kind) => kind !== "memory-session",
  });
  const source = createSnapshotToolSource({ approvalGate, snapshotStore });

  const result = JSON.parse(await source.executeTool(`${SNAPSHOT_TOOL_PREFIX}restore`, { id: "snap-1" }));
  assert.equal(result.status, "error");
  assert.match(result.error, /no restorer registered/);
  assert.equal(approvalGate.requestCalls.length, 0, "must fail fast instead of burning a human approval round-trip");
});

test("snapshot__restore stages through approvalGate and leaves it pending -- never auto-decides", async () => {
  const approvalGate = fakeApprovalGate();
  const record = { id: "snap-1", kind: "skill", key: "x.md", scope: null, summary: "skill update: X", appliedAt: "t", source: "human" };
  const snapshotStore = fakeSnapshotStore({
    getSnapshot: (id) => (id === "snap-1" ? record : null),
    checkStale: () => ({ stale: false }),
  });
  const source = createSnapshotToolSource({ approvalGate, snapshotStore });

  const result = await source.executeTool(`${SNAPSHOT_TOOL_PREFIX}restore`, { id: "snap-1" });

  assert.equal(approvalGate.requestCalls.length, 1);
  assert.equal(approvalGate.requestCalls[0].actionType, "snapshot-restore");
  assert.deepEqual(approvalGate.requestCalls[0].details.payload, { id: "snap-1" });
  assert.equal(approvalGate.requestCalls[0].details.summary, "Restore skill snapshot: skill update: X (source: human)");
  assert.equal(typeof approvalGate.decide, "undefined");
  assert.deepEqual(JSON.parse(result), {
    status: "pending",
    requestId: "req-1",
    summary: "Restore skill snapshot: skill update: X (source: human)",
    flags: [],
  });
});

test("snapshot__restore's approval summary carries a staleness warning when the target changed since", async () => {
  const approvalGate = fakeApprovalGate();
  const record = { id: "snap-1", kind: "file", key: "a.txt", scope: "/repo", summary: "first write", appliedAt: "t1", source: "agent" };
  const snapshotStore = fakeSnapshotStore({
    getSnapshot: (id) => (id === "snap-1" ? record : null),
    checkStale: () => ({ stale: true, newerSnapshotId: "snap-2", newerAppliedAt: "t2" }),
  });
  const source = createSnapshotToolSource({ approvalGate, snapshotStore });

  await source.executeTool(`${SNAPSHOT_TOOL_PREFIX}restore`, { id: "snap-1" });

  assert.match(approvalGate.requestCalls[0].details.summary, /WARNING/);
  assert.match(approvalGate.requestCalls[0].details.summary, /written to again/);
});

test("previewRestore returns null for an unknown id, otherwise record+staleness+summary", () => {
  const record = { id: "snap-1", kind: "file", key: "a.txt", scope: "/repo", summary: "s", appliedAt: "t" };
  const snapshotStore = fakeSnapshotStore({
    getSnapshot: (id) => (id === "snap-1" ? record : null),
    checkStale: () => ({ stale: false }),
  });

  assert.equal(previewRestore(snapshotStore, "nope"), null);
  const preview = previewRestore(snapshotStore, "snap-1");
  assert.deepEqual(preview.record, record);
  assert.deepEqual(preview.staleness, { stale: false });
  assert.equal(preview.summary, "Restore file snapshot: s (a.txt)");
});

// #475 whole-branch review fix: every other test in this file drives
// executeTool against a fakeApprovalGate -- nothing exercises
// snapshot__restore through buildToolPolicy/createSnapshotToolSource with a
// REAL approval-gate.js gate end to end. This proves the gate genuinely
// holds: calling snapshot__restore returns "pending" (not a restored
// result), and the snapshot is still on disk afterward -- nothing was
// auto-executed.
test("snapshot__restore against a real createApprovalGate genuinely holds -- nothing auto-executes, the snapshot survives", async () => {
  const approvalGate = createApprovalGate({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-approval-gate-e2e-")),
  });
  const snapshotStore = createSnapshotStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-snapshot-store-e2e-")),
  });
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-snapshot-target-e2e-"));
  fs.writeFileSync(path.join(targetDir, "out.txt"), "current content", "utf8");

  const recorded = snapshotStore.recordSnapshot({
    kind: "file",
    key: "out.txt",
    scope: targetDir,
    payload: "previous content",
    summary: "test write",
    source: "agent",
  });

  const source = createSnapshotToolSource({ approvalGate, snapshotStore });
  const result = JSON.parse(await source.executeTool(`${SNAPSHOT_TOOL_PREFIX}restore`, { id: recorded.id }));

  assert.equal(result.status, "pending");
  assert.equal(typeof result.requestId, "string");
  assert.ok(result.requestId.length > 0);

  // Nothing was actually restored: the target file is untouched and the
  // snapshot itself is still there to be approved (or denied) later.
  assert.equal(fs.readFileSync(path.join(targetDir, "out.txt"), "utf8"), "current content");
  assert.ok(snapshotStore.getSnapshot(recorded.id), "the snapshot must still exist -- nothing auto-executed");
});

test("buildRestoreSummary falls back to key, then id, when summary is empty", () => {
  assert.equal(
    buildRestoreSummary({ kind: "file", key: "a.txt", summary: "", id: "snap-1" }, { stale: false }),
    "Restore file snapshot: a.txt",
  );
  assert.equal(
    buildRestoreSummary({ kind: "file", key: null, summary: "", id: "snap-1" }, { stale: false }),
    "Restore file snapshot: snap-1",
  );
});

test("buildRestoreSummary names the file for a file-kind snapshot whose summary is free text, not the path", () => {
  assert.equal(
    buildRestoreSummary({ kind: "file", key: "src/app.js", summary: "file_write overwrite", id: "snap-1" }, { stale: false }),
    "Restore file snapshot: file_write overwrite (src/app.js)",
  );
  // Non-file kinds have no workspace-relative path to add.
  assert.equal(
    buildRestoreSummary({ kind: "skill", key: "src/app.js", summary: "skill update: X", id: "snap-1" }, { stale: false }),
    "Restore skill snapshot: skill update: X",
  );
});

test("buildRestoreSummary names the source when the snapshot has one, so the human approver can tell what they're restoring", () => {
  assert.equal(
    buildRestoreSummary({ kind: "skill", key: "x.md", summary: "skill update: X", id: "snap-1", source: "human" }, { stale: false }),
    "Restore skill snapshot: skill update: X (source: human)",
  );
  assert.equal(
    buildRestoreSummary({ kind: "file", key: "a.txt", summary: "pre-restore backup", id: "snap-1", source: "system" }, { stale: false }),
    "Restore file snapshot: pre-restore backup (a.txt) (source: system)",
  );
  // No source field at all -- omitted rather than "(source: undefined)" or similar.
  assert.equal(
    buildRestoreSummary({ kind: "skill", key: "x.md", summary: "skill update: X", id: "snap-1" }, { stale: false }),
    "Restore skill snapshot: skill update: X",
  );
});

test("the registered snapshot-restore executor routes a file-kind restore through restoreFileSnapshot when provided, for workspace containment", async () => {
  const approvalGate = fakeApprovalGate();
  const restoreFileCalls = [];
  const directRestoreCalls = [];
  const record = { id: "snap-1", kind: "file", key: "a.txt", scope: "/repo" };
  const snapshotStore = fakeSnapshotStore({
    getSnapshot: (id) => (id === "snap-1" ? record : null),
    restoreSnapshot: async (id, opts) => {
      directRestoreCalls.push({ id, opts });
      return { restoredPath: "/repo/a.txt" };
    },
  });
  createSnapshotToolSource({
    approvalGate,
    snapshotStore,
    restoreFileSnapshot: async (id, opts) => {
      restoreFileCalls.push({ id, opts });
      return { id, relativePath: "a.txt", restoredAt: "t" };
    },
  });

  const executor = approvalGate.executors.get("snapshot-restore");
  const result = await executor({ id: "snap-1" });

  assert.deepEqual(restoreFileCalls, [{ id: "snap-1", opts: { confirmStale: true } }]);
  assert.deepEqual(directRestoreCalls, [], "the workspace-unaware store restore must not run for a file kind when the checked path is available");
  assert.deepEqual(result, { id: "snap-1", relativePath: "a.txt", restoredAt: "t" });
});

test("the registered snapshot-restore executor falls back to the store directly for a non-file kind, even when restoreFileSnapshot is provided", async () => {
  const approvalGate = fakeApprovalGate();
  const directRestoreCalls = [];
  const record = { id: "snap-1", kind: "skill", key: "x.md", scope: null };
  const snapshotStore = fakeSnapshotStore({
    getSnapshot: (id) => (id === "snap-1" ? record : null),
    restoreSnapshot: async (id, opts) => {
      directRestoreCalls.push({ id, opts });
      return { restored: true };
    },
  });
  createSnapshotToolSource({
    approvalGate,
    snapshotStore,
    restoreFileSnapshot: async () => {
      throw new Error("must not be called for a non-file kind");
    },
  });

  const executor = approvalGate.executors.get("snapshot-restore");
  const result = await executor({ id: "snap-1" });

  assert.deepEqual(directRestoreCalls, [{ id: "snap-1", opts: { confirmStale: true } }]);
  assert.deepEqual(result, { restored: true });
});
