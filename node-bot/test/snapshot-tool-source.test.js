// Create node-bot/test/snapshot-tool-source.test.js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SNAPSHOT_TOOL_PREFIX,
  isSnapshotToolName,
  createSnapshotToolSource,
  previewRestore,
  buildRestoreSummary,
} = require("../ai/snapshot-tool-source");

function fakeSnapshotStore(overrides = {}) {
  return {
    listSnapshots: () => [],
    getSnapshot: () => null,
    checkStale: () => ({ stale: false }),
    restoreSnapshot: async () => ({ restored: true }),
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
  assert.equal(approvalGate.requestCalls[0].details.summary, "Restore skill snapshot: skill update: X");
  assert.equal(typeof approvalGate.decide, "undefined");
  assert.deepEqual(JSON.parse(result), {
    status: "pending",
    requestId: "req-1",
    summary: "Restore skill snapshot: skill update: X",
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
  assert.equal(preview.summary, "Restore file snapshot: s");
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
