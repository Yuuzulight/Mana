# Agent-Triggered Snapshot Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Mana propose restoring a snapshot from the generic snapshot/rollback store (`node-bot/snapshot-store.js`, #426 sub-project 1) as a model-callable tool, gated by human approval in both pipelines, with a `source` field distinguishing human- from agent-caused snapshots and a staleness check that stops any restore path (old or new) from silently clobbering a legitimately newer write.

**Architecture:** A new pipeline-agnostic module (`node-bot/ai/snapshot-tool-source.js`) owns the two tools (`snapshot__list`, `snapshot__restore`) and the shared "look up + check staleness + build a summary" logic (`previewRestore`). Pipeline A (`server.js`'s voice-companion loop) wires it through `approvalGate` exactly like `ai/skill-tool-source.js` already does for `skill__create`. Pipeline B (`acp-autonomous-loop.js`'s autonomous coding loop) calls `previewRestore` directly and gates through its own existing `createPendingRequest`/`waitForApprovalResult`/`archivePendingRequest` primitives, exactly like its own `file_write` case already does. `snapshot-store.js` itself gains two independent, backward-compatible capabilities used by every caller (old and new): a `source` field on every recorded snapshot, and a `checkStale`/`confirmStale` staleness guard on `restoreSnapshot`.

**Tech Stack:** Node.js (CommonJS, `node:fs`/`node:path`/`node:crypto`), `node:test` + `node:assert/strict` for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-25-agent-triggered-snapshot-restore-design.md`

## Global Constraints

- Two tools, always registered, prefix `snapshot__`: `snapshot__list(kind?)` and `snapshot__restore(id)`. Same always-visible precedent as `skill__create`/`skill__run` — no conditional registration.
- `snapshot__restore` always goes through approval — never auto-decided, never pre-added to the always-allow list by this plan's own code (a human *can* still choose "always allow" through the gate's normal `decide()` flow; that stays possible, just never pre-seeded).
- `source: "human" | "agent"` is populated at all 7 existing `recordSnapshot` call sites. Six of the seven have a single unambiguous caller and get the value hardcoded directly in the `recordSnapshot({...})` call. The seventh — `acp-memory-store.js`'s `rememberFact` — has genuinely mixed real callers (an admin-only REST route vs. the model's `memory__remember` tool vs. an automatic background reflex), confirmed by reading every call site in this repo; for that one function only, `source` is threaded through as an optional parameter defaulting to `"agent"`, with the one human-only caller (`capabilities/memory-facts-capability.js`'s archive route) passing `source: "human"` explicitly. This is a factual correction to the design doc's claim that every call site is single-sourced, not a reversal of the source-taxonomy decision itself.
- `restoreSnapshot(id, { confirmStale } = {})`: on a stale target (something else wrote to the same `kind`+`key`+`scope` after this snapshot was recorded) and `confirmStale` not `true`, returns `{ stale: true, id, kind, key, scope, summary, appliedAt, newerSnapshotId, newerAppliedAt }` instead of restoring. Non-stale case's return shape is unchanged from today (whatever the registered restorer returns) — fully backward compatible.
- Staleness detection is pure metadata (via `listSnapshots`), not a kind-specific "read current live state" call — a later snapshot for the same `kind`+`key`+`scope` *is* the evidence of a later legitimate write, since every existing call site already records a snapshot immediately before its own write lands.
- The agent-tool path (both pipelines) computes staleness *before* staging the approval request and folds the warning into that same request's summary — one round trip, not two. The pre-existing REST route / "Applied edits" UI panel keeps its two-round-trip shape (call once, get `stale: true`, call again with `confirmStale: true`) since no UI work to surface it nicely is in scope.

---

## Task 1: `source` field on every recorded snapshot

**Files:**
- Modify: `node-bot/snapshot-store.js`
- Modify: `node-bot/zed-integration.js` (`approveEditProposal`)
- Modify: `node-bot/acp-autonomous-loop.js` (`file_write` overwrite path)
- Modify: `node-bot/acp-memory-store.js` (`renameSession`, `setSessionGoal`, `appendTurn`, `rememberFact`)
- Modify: `node-bot/skills-store.js` (`updateSkill`)
- Modify: `node-bot/capabilities/memory-facts-capability.js` (archive route)
- Test: `node-bot/test/snapshot-store.test.js`
- Test: `node-bot/test/zed-integration.test.js`
- Test: `node-bot/test/acp-autonomous-loop.test.js`
- Test: `node-bot/test/acp-memory-store.test.js`
- Test: `node-bot/test/skills-store.test.js`
- Test: `node-bot/test/memory-facts-capability.test.js`

**Interfaces:**
- Consumes: `snapshot-store.js`'s existing `recordSnapshot({kind, key, scope, payload, summary})`/`listSnapshots(kind?)`.
- Produces: `recordSnapshot({..., source})` — `source` stored verbatim (`null` if omitted) and returned from both `recordSnapshot`'s own return value and every `listSnapshots()` entry. `rememberFact({..., source})` — optional, defaults to `"agent"` when omitted.

- [ ] **Step 1: Write the failing tests for `snapshot-store.js`'s `source` field**

```js
// Add to node-bot/test/snapshot-store.test.js
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
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test node-bot/test/snapshot-store.test.js`
Expected: FAIL — `recorded.source` is `undefined`, not `"human"`/`null`.

- [ ] **Step 3: Add `source` to `recordSnapshot` and `listSnapshots` in `snapshot-store.js`**

```js
// node-bot/snapshot-store.js -- replace the existing recordSnapshot function
function recordSnapshot({ kind, key, scope, payload, summary, source } = {}) {
  if (!kind) {
    throw new Error("kind is required");
  }
  ensureDir(dataDir);
  const id = idFactory();
  const record = {
    id,
    kind,
    key: key ?? null,
    scope: scope ?? null,
    payload,
    summary: summary || "",
    appliedAt: now(),
    source: source ?? null,
  };
  writeJsonAtomic(snapshotPath(id), record);
  pruneOldest(kind);
  return {
    id,
    kind,
    key: record.key,
    scope: record.scope,
    summary: record.summary,
    appliedAt: record.appliedAt,
    source: record.source,
  };
}
```

```js
// node-bot/snapshot-store.js -- replace the existing listSnapshots function
function listSnapshots(kind) {
  const records = listSnapshotFiles()
    .map((f) => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
        return {
          id: record.id,
          kind: record.kind,
          key: record.key,
          scope: record.scope,
          summary: record.summary,
          appliedAt: record.appliedAt,
          source: record.source ?? null,
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .filter((record) => !kind || record.kind === kind);
  records.sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)));
  return records;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test node-bot/test/snapshot-store.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add node-bot/snapshot-store.js node-bot/test/snapshot-store.test.js
git commit -m "Add source field to snapshot-store.js records (#475)"
```

- [ ] **Step 6: Write the failing test for `zed-integration.js`'s `approveEditProposal` (source: "human")**

```js
// Add to node-bot/test/zed-integration.test.js, right after the existing
// "approving a proposal records a snapshot of the pre-edit content..." test
test("approving a proposal records the snapshot with source: human -- a human clicked approve", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-source-"));
  const snapshotsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-source-store-"));
  const sourceFile = path.join(tempDir, "src.js");
  fs.writeFileSync(sourceFile, "const value = 1;\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
      idFactory: () => "proposal-source-1",
      snapshotsDir,
    });

    editors.createEditProposal({
      path: "src.js",
      proposedContent: "const value = 2;\n",
      summary: "Update value",
    });

    const applied = editors.approveEditProposal("proposal-source-1");
    const [snapshot] = editors.listEditSnapshots().filter((s) => s.id === applied.snapshotId);
    // listEditSnapshots doesn't project source today -- read the raw
    // snapshot store record instead to confirm it was actually recorded.
    const snapshotsDirFiles = fs.readdirSync(snapshotsDir).filter((f) => f.endsWith(".json"));
    const raw = JSON.parse(fs.readFileSync(path.join(snapshotsDir, snapshotsDirFiles[0]), "utf8"));
    assert.equal(raw.source, "human");
    assert.ok(snapshot);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(snapshotsDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `node --test node-bot/test/zed-integration.test.js`
Expected: FAIL — `raw.source` is `null`, not `"human"`.

- [ ] **Step 8: Add `source: "human"` to `approveEditProposal`'s `recordSnapshot` call**

```js
// node-bot/zed-integration.js -- inside approveEditProposal, replace the
// existing snapshotStore.recordSnapshot call
const snapshot = snapshotStore.recordSnapshot({
  kind: "file",
  key: target.relativePath,
  scope: path.resolve(workspace.path),
  payload: currentContent,
  summary: proposal.summary,
  source: "human",
});
```

- [ ] **Step 9: Run it to verify it passes**

Run: `node --test node-bot/test/zed-integration.test.js`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add node-bot/zed-integration.js node-bot/test/zed-integration.test.js
git commit -m "Tag zed-integration.js edit snapshots with source: human (#475)"
```

- [ ] **Step 11: Write the failing test for `acp-autonomous-loop.js`'s `file_write` (source: "agent")**

```js
// Add to node-bot/test/acp-autonomous-loop.test.js, right after the
// existing "file_write overwrite records a restorable snapshot..." test.
// Reuses that same test's mocked fs.promises + fakeSnapshotStore pattern.
test("acp-autonomous-loop: file_write overwrite tags its snapshot source: agent", async (t) => {
  const origEnv = process.env.ALLOW_FILE_WRITE;
  const origApproval = process.env.FILE_WRITE_REQUIRE_APPROVAL;
  const origStat = fs.promises.stat;
  const origRead = fs.promises.readFile;
  const origWrite = fs.promises.writeFile;
  try {
    process.env.ALLOW_FILE_WRITE = "1";
    process.env.FILE_WRITE_REQUIRE_APPROVAL = "0";
    let lastWriteSize = null;

    fs.promises.stat = async (p) => {
      if (lastWriteSize === null) return { isFile: () => true, size: 10 };
      return { isFile: () => true, size: lastWriteSize };
    };
    fs.promises.readFile = async (p, enc) => "previous content";
    fs.promises.writeFile = async (p, content, opts) => {
      lastWriteSize = Buffer.byteLength(content, "utf8");
    };

    const recorded = [];
    const fakeSnapshotStore = {
      recordSnapshot: (record) => {
        recorded.push(record);
        return { id: "snap-source-agent-1", ...record };
      },
    };

    const mockModelReply =
      'Write file:\n[{"tool":"file_write","args":{"path":"src/out2.txt","content":"hello again","mode":"overwrite"}}]';
    await executeAutonomousStep(mockModelReply, "test-session", {
      snapshotStore: fakeSnapshotStore,
    });

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].source, "agent");
  } finally {
    process.env.ALLOW_FILE_WRITE = origEnv;
    process.env.FILE_WRITE_REQUIRE_APPROVAL = origApproval;
    fs.promises.stat = origStat;
    fs.promises.readFile = origRead;
    fs.promises.writeFile = origWrite;
  }
});
```

- [ ] **Step 12: Run it to verify it fails**

Run: `node --test node-bot/test/acp-autonomous-loop.test.js`
Expected: FAIL — `recorded[0].source` is `undefined`.

- [ ] **Step 13: Add `source: "agent"` to `file_write`'s `recordSnapshot` call**

```js
// node-bot/acp-autonomous-loop.js -- inside the file_write overwrite
// branch, replace the existing snapshotStore.recordSnapshot call
snapshotStore.recordSnapshot({
  kind: "file",
  key: path.relative(REPO_ROOT, resolvedPath),
  scope: REPO_ROOT,
  payload: priorContent,
  summary: "file_write overwrite",
  source: "agent",
});
```

- [ ] **Step 14: Run it to verify it passes**

Run: `node --test node-bot/test/acp-autonomous-loop.test.js`
Expected: PASS

- [ ] **Step 15: Commit**

```bash
git add node-bot/acp-autonomous-loop.js node-bot/test/acp-autonomous-loop.test.js
git commit -m "Tag acp-autonomous-loop.js file_write snapshots with source: agent (#475)"
```

- [ ] **Step 16: Write the failing tests for `acp-memory-store.js`'s four call sites**

```js
// Add to node-bot/test/acp-memory-store.test.js
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
```

- [ ] **Step 17: Run them to verify they fail**

Run: `node --test node-bot/test/acp-memory-store.test.js`
Expected: FAIL — every `.source` assertion sees `null`/`undefined` instead of `"human"`/`"agent"`.

- [ ] **Step 18: Add `source` to all four `acp-memory-store.js` call sites**

```js
// node-bot/acp-memory-store.js -- inside renameSession, replace the
// existing snapshotStore.recordSnapshot call
snapshotStore.recordSnapshot({
  kind: "memory-session",
  key: existing.sessionId,
  payload: existing,
  summary: `session rename: ${existing.sessionId}`,
  source: "human",
});
```

```js
// node-bot/acp-memory-store.js -- inside setSessionGoal, replace the
// existing snapshotStore.recordSnapshot call
snapshotStore.recordSnapshot({
  kind: "memory-session",
  key: existing.sessionId,
  payload: existing,
  summary: `session goal change: ${existing.sessionId}`,
  source: "human",
});
```

```js
// node-bot/acp-memory-store.js -- inside appendTurn, replace the existing
// snapshotStore.recordSnapshot call
snapshotStore.recordSnapshot({
  kind: "memory-session",
  key: session.sessionId,
  payload: session,
  summary: `turn appended: ${session.sessionId}`,
  source: "agent",
});
```

```js
// node-bot/acp-memory-store.js -- rememberFact's own parameter list gains
// `source`. Only this one function threads it through as a parameter
// (rather than a hardcoded literal) because its real callers are mixed:
// capabilities/memory-facts-capability.js's admin archive route is the
// only human-only path; the model's memory__remember tool
// (ai/memory-tool-source.js) and the automatic loneliness reflex
// (server.js's checkEmotionalReflexes) are both the agent's own action.
// Defaulting to "agent" covers both of the latter without either needing
// to pass anything.
function rememberFact({
  sessionId, key, text, action, unverifiedSource, epistemic, occurredAt, supersedes, source,
} = {}) {
  // ... existing body unchanged up to the recordSnapshot call ...
  if (snapshotStore) {
    try {
      snapshotStore.recordSnapshot({
        kind: "memory-fact",
        key: cleanKey,
        payload: existing ? JSON.parse(JSON.stringify(existing)) : null,
        summary: `fact ${normalizedAction}: ${cleanKey}`,
        source: source || "agent",
      });
    } catch (e) {
      console.warn("Fact snapshot failed:", e?.message || e);
    }
  }
  // ... rest of existing body unchanged ...
}
```

- [ ] **Step 19: Run them to verify they pass**

Run: `node --test node-bot/test/acp-memory-store.test.js`
Expected: PASS

- [ ] **Step 20: Commit**

```bash
git add node-bot/acp-memory-store.js node-bot/test/acp-memory-store.test.js
git commit -m "Tag acp-memory-store.js snapshots with source (#475)"
```

- [ ] **Step 21: Write the failing test for `skills-store.js`'s `updateSkill` (source: "human")**

```js
// Extend node-bot/test/skills-store.test.js's existing
// "updateSkill snapshots the pre-update file content, restorable via the
// generic store" test -- add this assertion right after the existing
// `assert.equal(snapshot.key, skill.fileName);` line:
  assert.equal(snapshot.source, "human");
```

- [ ] **Step 22: Run it to verify it fails**

Run: `node --test node-bot/test/skills-store.test.js`
Expected: FAIL — `snapshot.source` is `null`.

- [ ] **Step 23: Add `source: "human"` to `updateSkill`'s `recordSnapshot` call**

```js
// node-bot/skills-store.js -- inside updateSkill, replace the existing
// snapshotStore.recordSnapshot call
snapshotStore.recordSnapshot({
  kind: "skill",
  key: fileName,
  payload: serializeSkillFile(skill),
  summary: `skill update: ${skill.name}`,
  source: "human",
});
```

- [ ] **Step 24: Run it to verify it passes**

Run: `node --test node-bot/test/skills-store.test.js`
Expected: PASS

- [ ] **Step 25: Commit**

```bash
git add node-bot/skills-store.js node-bot/test/skills-store.test.js
git commit -m "Tag skills-store.js updateSkill snapshots with source: human (#475)"
```

- [ ] **Step 26: Write the failing test for the admin archive route passing `source: "human"`**

```js
// Extend node-bot/test/memory-facts-capability.test.js's existing
// "POST /admin/memory/facts/:key/archive calls rememberFact with
// action=archive" test -- add this assertion right after the existing
// `assert.equal(capturedArgs.action, "archive");` line:
    assert.equal(capturedArgs.source, "human");
```

- [ ] **Step 27: Run it to verify it fails**

Run: `node --test node-bot/test/memory-facts-capability.test.js`
Expected: FAIL — `capturedArgs.source` is `undefined`.

- [ ] **Step 28: Pass `source: "human"` from the archive route**

```js
// node-bot/capabilities/memory-facts-capability.js -- inside
// registerMemoryFactsRoutes, replace the existing rememberFact call
const result = acpMemoryStore.rememberFact({
  key: req.params.key,
  action: "archive",
  source: "human",
});
```

- [ ] **Step 29: Run it to verify it passes**

Run: `node --test node-bot/test/memory-facts-capability.test.js`
Expected: PASS

- [ ] **Step 30: Commit**

```bash
git add node-bot/capabilities/memory-facts-capability.js node-bot/test/memory-facts-capability.test.js
git commit -m "Pass source: human from the admin fact-archive route (#475)"
```

---

## Task 2: Staleness check inside `restoreSnapshot()`

**Files:**
- Modify: `node-bot/snapshot-store.js`
- Test: `node-bot/test/snapshot-store.test.js`

**Interfaces:**
- Consumes: `listSnapshots(kind)`, `getSnapshot(id)` (both from Task 1, unchanged shape otherwise).
- Produces: `checkStale(id)` returning `{ stale: false }` or `{ stale: true, newerSnapshotId, newerAppliedAt }`, or `null` if `id` doesn't exist. `restoreSnapshot(id, { confirmStale } = {})` — new second parameter; non-stale (or `confirmStale: true`) behavior/return-shape is exactly what it is today.

- [ ] **Step 1: Write the failing tests for `checkStale` and `restoreSnapshot`'s staleness behavior**

```js
// Add to node-bot/test/snapshot-store.test.js
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
    now: () => timestamps[tick],
    idFactory: () => ids[tick++],
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
    now: () => timestamps[tick],
    idFactory: () => ids[tick++],
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
    now: () => timestamps[tick],
    idFactory: () => ids[tick++],
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test node-bot/test/snapshot-store.test.js`
Expected: FAIL — `store.checkStale` is not a function; `restoreSnapshot` always restores regardless of staleness.

- [ ] **Step 3: Add `checkStale` and update `restoreSnapshot` in `snapshot-store.js`**

```js
// node-bot/snapshot-store.js -- add this function right after
// pruneOldest, before recordSnapshot
//
// #475: is `id`'s target stale -- has something else legitimately written
// to the same kind+key+scope since this snapshot was recorded? Purely
// metadata-based (listSnapshots, not a kind-specific "read current live
// state" call) so it stays exactly as kind-agnostic as the rest of this
// store: a later recordSnapshot for the same target IS that later write,
// by construction -- every existing call site records a snapshot
// immediately before its own write lands (see zed-integration.js's
// approveEditProposal, acp-autonomous-loop.js's file_write, etc.), so "a
// newer snapshot exists" and "the target changed since this snapshot" are
// the same fact. Returns null if id doesn't exist.
function checkStale(id) {
  const record = getSnapshot(id);
  if (!record) return null;
  const newer = listSnapshots(record.kind).filter(
    (other) =>
      other.id !== id &&
      other.key === record.key &&
      other.scope === record.scope &&
      String(other.appliedAt).localeCompare(String(record.appliedAt)) > 0,
  );
  if (!newer.length) return { stale: false };
  return { stale: true, newerSnapshotId: newer[0].id, newerAppliedAt: newer[0].appliedAt };
}
```

```js
// node-bot/snapshot-store.js -- replace the existing restoreSnapshot
// function
//
// Looks up the snapshot, calls the registered restorer for its kind, and
// deletes the snapshot only after the restorer's promise resolves -- a
// transient failure (a briefly-locked file, a momentary permission error)
// leaves the snapshot exactly as it was, so calling restoreSnapshot(id)
// again is a valid retry, not a lost undo.
//
// #475: unless confirmStale is true, a stale target (see checkStale above)
// short-circuits before the restorer ever runs -- returns a warning
// object instead of silently overwriting whatever legitimately landed
// there since. Every existing caller (the REST route, both apps' "Applied
// edits" panels) gets this protection automatically, since it lives here
// rather than only in the new agent-tool code path.
async function restoreSnapshot(id, { confirmStale = false } = {}) {
  const record = getSnapshot(id);
  if (!record) {
    throw new Error("snapshot not found");
  }
  if (!confirmStale) {
    const staleness = checkStale(id);
    if (staleness && staleness.stale) {
      return {
        stale: true,
        id,
        kind: record.kind,
        key: record.key,
        scope: record.scope,
        summary: record.summary,
        appliedAt: record.appliedAt,
        newerSnapshotId: staleness.newerSnapshotId,
        newerAppliedAt: staleness.newerAppliedAt,
      };
    }
  }
  const restorer = restorers.get(record.kind);
  if (typeof restorer !== "function") {
    throw new Error(`no restorer registered for kind: ${record.kind}`);
  }
  const result = await restorer(record.key, record.payload, record.scope);
  deleteSnapshot(id);
  return result;
}
```

```js
// node-bot/snapshot-store.js -- add checkStale to the returned object
  return {
    recordSnapshot,
    listSnapshots,
    getSnapshot,
    deleteSnapshot,
    registerRestorer,
    restoreSnapshot,
    checkStale,
  };
```

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test node-bot/test/snapshot-store.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add node-bot/snapshot-store.js node-bot/test/snapshot-store.test.js
git commit -m "Add staleness check to snapshot-store.js's restoreSnapshot (#475)"
```

---

## Task 3: Plumb staleness through the existing REST route / "Applied edits" panel

**Files:**
- Modify: `node-bot/zed-integration.js` (`restoreEditSnapshot`)
- Modify: `node-bot/server.js` (`POST /editors/workspace/snapshots/:id/restore`)
- Test: `node-bot/test/zed-integration.test.js`

**Interfaces:**
- Consumes: `snapshotStore.restoreSnapshot(id, { confirmStale })` (from Task 2).
- Produces: `restoreEditSnapshot(id, { confirmStale } = {})` — returns `{ id, relativePath, stale: true, newerSnapshotId, newerAppliedAt }` on a stale, unconfirmed restore, or the existing `{ id, relativePath, restoredAt }` shape otherwise.

- [ ] **Step 1: Write the failing test for `restoreEditSnapshot`'s staleness passthrough**

```js
// Add to node-bot/test/zed-integration.test.js, right after the existing
// "restoreEditSnapshot writes the pre-edit content back..." test
test("restoreEditSnapshot returns stale: true without restoring when the file changed again since the snapshot, and confirmStale forces it through", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-restore-stale-"));
  const snapshotsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-restore-stale-store-"));
  const targetFile = path.join(tempDir, "src.js");
  fs.writeFileSync(targetFile, "const value = 1;\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    let idCounter = 0;
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
      idFactory: () => `proposal-stale-${++idCounter}`,
      snapshotsDir,
    });

    editors.createEditProposal({ path: "src.js", proposedContent: "const value = 2;\n", summary: "First edit" });
    const firstApplied = editors.approveEditProposal("proposal-stale-1");

    editors.createEditProposal({ path: "src.js", proposedContent: "const value = 3;\n", summary: "Second edit" });
    editors.approveEditProposal("proposal-stale-2");

    // Restoring the FIRST snapshot now would clobber the second edit.
    const result = await editors.restoreEditSnapshot(firstApplied.snapshotId);
    assert.equal(result.stale, true);
    assert.equal(fs.readFileSync(targetFile, "utf8"), "const value = 3;\n", "the second edit must survive an unconfirmed stale restore");

    const forced = await editors.restoreEditSnapshot(firstApplied.snapshotId, { confirmStale: true });
    assert.equal(forced.stale, undefined);
    assert.ok(forced.restoredAt);
    assert.equal(fs.readFileSync(targetFile, "utf8"), "const value = 1;\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(snapshotsDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test node-bot/test/zed-integration.test.js`
Expected: FAIL — `restoreEditSnapshot` throws or the second edit gets clobbered, since staleness isn't checked yet.

- [ ] **Step 3: Update `restoreEditSnapshot` to accept and surface staleness**

```js
// node-bot/zed-integration.js -- replace the existing restoreEditSnapshot
// function
async function restoreEditSnapshot(id, { confirmStale = false } = {}) {
  const record = snapshotStore.getSnapshot(id);
  if (!record) {
    throw new Error("edit snapshot not found");
  }

  const workspace = requireActiveWorkspace(workspaceStore);
  if (record.scope !== path.resolve(workspace.path)) {
    throw new Error("edit snapshot belongs to a different workspace");
  }
  const target = toWorkspaceRelativePath(workspace.path, record.key);
  if (!fs.existsSync(target.fullPath) || !fs.statSync(target.fullPath).isFile()) {
    throw new Error("workspace file does not exist");
  }

  const result = await snapshotStore.restoreSnapshot(id, { confirmStale });
  if (result && result.stale) {
    return {
      id,
      relativePath: record.key,
      stale: true,
      newerSnapshotId: result.newerSnapshotId,
      newerAppliedAt: result.newerAppliedAt,
    };
  }
  return {
    id,
    relativePath: record.key,
    restoredAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test node-bot/test/zed-integration.test.js`
Expected: PASS

- [ ] **Step 5: Update the REST route to accept `confirmStale` in the request body**

```js
// node-bot/server.js -- replace the existing
// POST /editors/workspace/snapshots/:id/restore handler
app.post("/editors/workspace/snapshots/:id/restore", async (req, res) => {
  if (!checkAdminAuth(req, res)) return;
  try {
    const editors = getEditorIntegrations();
    const confirmStale = Boolean(req.body && req.body.confirmStale);
    const restored = await editors.restoreEditSnapshot(req.params.id, { confirmStale });
    return res.json({ restored });
  } catch (error) {
    return res.status(400).json({
      restored: null,
      error: error.message,
    });
  }
});
```

- [ ] **Step 6: Commit**

```bash
git add node-bot/zed-integration.js node-bot/server.js node-bot/test/zed-integration.test.js
git commit -m "Surface staleness through restoreEditSnapshot and its REST route (#475)"
```

---

## Task 4: Create `node-bot/ai/snapshot-tool-source.js`

**Files:**
- Create: `node-bot/ai/snapshot-tool-source.js`
- Test: `node-bot/test/snapshot-tool-source.test.js`

**Interfaces:**
- Consumes: `snapshotStore` shaped `{listSnapshots(kind?), getSnapshot(id), checkStale(id), restoreSnapshot(id, {confirmStale})}` (Tasks 1-2); `approvalGate` shaped `{registerExecutor(actionType, fn), requestApproval(actionType, {summary, payload, scanText})}` (matches `node-bot/approval-gate.js`).
- Produces: `createSnapshotToolSource({approvalGate, snapshotStore})` returning `{listToolSchemas, executeTool, isKnownToolName}` (same shape as `ai/skill-tool-source.js`'s `createSkillToolSource`). Also exports `previewRestore(snapshotStore, id)` returning `{record, staleness, summary}` or `null`, and `buildRestoreSummary(record, staleness)` returning a string — both consumed directly by Pipeline B in Task 6, so the staleness-preview logic exists exactly once.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test node-bot/test/snapshot-tool-source.test.js`
Expected: FAIL — `Cannot find module '../ai/snapshot-tool-source'`.

- [ ] **Step 3: Write `node-bot/ai/snapshot-tool-source.js`**

```js
// #475: agent-triggered snapshot restore -- a model-callable view onto the
// generic snapshot/rollback store (#426 sub-project 1, snapshot-store.js).
// Mirrors ai/skill-tool-source.js's exact shape ({listToolSchemas,
// executeTool, isKnownToolName}) since every tool source in Pipeline A
// already follows it. previewRestore/buildRestoreSummary are exported
// separately so Pipeline B's tool switch (acp-autonomous-loop.js) can call
// them directly instead of reimplementing the staleness-preview logic --
// the design doc's own requirement that this module's core logic "stays
// identical between both wirings."
const SNAPSHOT_TOOL_PREFIX = "snapshot__";

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: `${SNAPSHOT_TOOL_PREFIX}list`,
      description:
        "List recorded snapshots -- prior states of a file, memory session, memory fact, or skill that can be restored. Call this before snapshot__restore to see what's actually available and pick the right id, the same way a human picks off the \"Applied edits\" panel before restoring. Restoring your OWN prior actions (source: \"agent\") may be proposed freely, proactively. Restoring a human-sourced snapshot (source: \"human\") may only be proposed when the user has explicitly asked to undo/revert/roll back a specific action -- never propose undoing a human's own deliberate edit or memory change unprompted.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["file", "memory-session", "memory-fact", "skill"],
            description: "Optional: only list snapshots of this kind. Omit to see every kind.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: `${SNAPSHOT_TOOL_PREFIX}restore`,
      description:
        "Restore a specific snapshot by id (from snapshot__list), undoing whatever it recorded. Always requires human approval before anything is actually restored -- this returns a pending request, not an immediate result. If the target has been written to again since the snapshot was recorded, the approval prompt carries a staleness warning; a human approving it anyway proceeds despite that warning. Same source restriction as snapshot__list: only propose restoring a human-sourced snapshot when the user explicitly asked for it.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The snapshot id, as returned by snapshot__list." },
        },
        required: ["id"],
      },
    },
  },
];

function isSnapshotToolName(name) {
  return typeof name === "string" && name.startsWith(SNAPSHOT_TOOL_PREFIX);
}

function buildRestoreSummary(record, staleness) {
  const label = record.summary || record.key || record.id;
  const base = `Restore ${record.kind} snapshot: ${label}`;
  return staleness && staleness.stale
    ? `${base} (WARNING: this target has been written to again since this snapshot was recorded -- restoring will overwrite that newer state)`
    : base;
}

// Shared by both pipelines so the "look up + check staleness + build a
// human-readable summary" logic exists exactly once. Returns null if no
// snapshot exists with this id.
function previewRestore(snapshotStore, id) {
  const record = snapshotStore.getSnapshot(id);
  if (!record) return null;
  const staleness = snapshotStore.checkStale(id);
  return { record, staleness, summary: buildRestoreSummary(record, staleness) };
}

// options.approvalGate: required -- a restore always goes through the
// "snapshot-restore" gate, never auto-decided, never pre-added to the
// always-allow list -- this is explicitly a reversal action, not a
// routine write.
// options.snapshotStore: required -- the shared store instance every
// recordSnapshot call site already writes into.
function createSnapshotToolSource(options = {}) {
  const approvalGate = options.approvalGate;
  if (!approvalGate) {
    throw new Error("approvalGate is required");
  }
  const snapshotStore = options.snapshotStore;
  if (!snapshotStore) {
    throw new Error("snapshotStore is required");
  }

  // Registered here, not server.js, for the same reason skill-tool-source.js
  // registers "skill-run" at construction rather than in server.js: this
  // module already owns the snapshot store instance the executor needs.
  //
  // confirmStale: true -- staleness was already surfaced in the approval
  // summary before a human ever saw this request (see executeTool below),
  // so an approval here IS the confirm-anyway decision. There's no second
  // round-trip for the agent-tool path the way the REST route/UI keep.
  approvalGate.registerExecutor("snapshot-restore", async (payload) =>
    snapshotStore.restoreSnapshot(payload.id, { confirmStale: true }),
  );

  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  async function executeTool(qualifiedName, args) {
    const action = qualifiedName.slice(SNAPSHOT_TOOL_PREFIX.length);

    if (action === "list") {
      const snapshots = snapshotStore.listSnapshots(args?.kind);
      return JSON.stringify({ status: "ok", snapshots });
    }

    if (action !== "restore") {
      throw new Error(`unknown snapshot tool: ${qualifiedName}`);
    }

    const id = args?.id;
    const preview = previewRestore(snapshotStore, id);
    if (!preview) {
      return JSON.stringify({ status: "error", error: `no snapshot with id "${id}"` });
    }

    try {
      const outcome = await approvalGate.requestApproval("snapshot-restore", {
        summary: preview.summary,
        payload: { id },
        scanText: JSON.stringify({
          kind: preview.record.kind,
          key: preview.record.key,
          summary: preview.record.summary,
        }),
      });
      return JSON.stringify(outcome);
    } catch (e) {
      return JSON.stringify({ status: "error", error: e.message || String(e) });
    }
  }

  return { listToolSchemas, executeTool, isKnownToolName: isSnapshotToolName };
}

module.exports = {
  SNAPSHOT_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isSnapshotToolName,
  previewRestore,
  buildRestoreSummary,
  createSnapshotToolSource,
};
```

- [ ] **Step 4: Run them to verify they pass**

Run: `node --test node-bot/test/snapshot-tool-source.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add node-bot/ai/snapshot-tool-source.js node-bot/test/snapshot-tool-source.test.js
git commit -m "Add ai/snapshot-tool-source.js (#475)"
```

---

## Task 5: Wire Pipeline A (`server.js`'s voice-companion tool loop)

**Files:**
- Modify: `node-bot/server.js`
- Modify: `node-bot/test/tool-source.test.js`

**Interfaces:**
- Consumes: `createSnapshotToolSource({approvalGate, snapshotStore})` (Task 4); `server.js`'s existing module-scope `snapshotStore` (`server.js:499`) and `activeApprovalGate` (`server.js:2028`).
- Produces: `snapshot__list`/`snapshot__restore` available in Pipeline A's merged tool policy.

- [ ] **Step 1: Write the failing test extending the real-factories end-to-end test**

```js
// node-bot/test/tool-source.test.js -- add the import at the top
const { createSnapshotToolSource } = require("../ai/snapshot-tool-source");
```

```js
// node-bot/test/tool-source.test.js -- inside the existing
// "buildToolPolicy works end to end with the real memory/session-search/
// skill/mcp-registry factories, not just fakes" test, add a snapshot
// source and thread it into `sources` and the assertions:
  const snapshotSource = createSnapshotToolSource({
    approvalGate: {
      requestApproval: async () => ({ status: "pending" }),
      registerExecutor: () => {},
    },
    snapshotStore: { listSnapshots: () => [], getSnapshot: () => null, checkStale: () => ({ stale: false }), restoreSnapshot: async () => ({}) },
  });

  const sources = [memorySource, sessionSearchSource, skillSource, snapshotSource, mcpRegistry];
```

```js
// node-bot/test/tool-source.test.js -- add this assertion alongside the
// existing merged.isKnownTool(...) checks in the same test
  assert.equal(merged.isKnownTool("snapshot__list"), true);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test node-bot/test/tool-source.test.js`
Expected: FAIL — `Cannot find module '../ai/snapshot-tool-source'` resolves fine (Task 4 already created it), so this actually fails on `merged.isKnownTool("snapshot__list")` being `false` until Step 3 wires it in server.js... but this test doesn't touch server.js at all, it exercises `buildToolPolicy` directly with the real factory. It should already PASS once Task 4 exists, since `createSnapshotToolSource` is real and self-contained. Run it anyway to confirm before moving on -- if it already passes, that's expected and fine; proceed to Step 3 regardless, since server.js itself still hasn't wired the source into its own `toolSources` array yet.

- [ ] **Step 3: Register `createSnapshotToolSource` in `server.js`'s `require`s and `toolSources` array**

```js
// node-bot/server.js -- add near the existing
// const { createSkillToolSource } = require("./ai/skill-tool-source");
// require (server.js:157)
const { createSnapshotToolSource } = require("./ai/snapshot-tool-source");
```

```js
// node-bot/server.js -- inside the toolSources array passed to
// buildToolPolicy (server.js:4519-4574), add right after the existing
// createSkillToolSource({...}) entry
  createSkillToolSource({ approvalGate: activeApprovalGate, skillsStore: activeSkillsStore }),
  createSnapshotToolSource({ approvalGate: activeApprovalGate, snapshotStore }),
```

- [ ] **Step 4: Run the full test suite for this file to verify nothing broke**

Run: `node --test node-bot/test/tool-source.test.js node-bot/test/snapshot-tool-source.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add node-bot/server.js node-bot/test/tool-source.test.js
git commit -m "Wire snapshot-tool-source into Pipeline A's tool policy (#475)"
```

---

## Task 6: Wire Pipeline B (`acp-autonomous-loop.js`'s autonomous coding loop)

**Files:**
- Modify: `node-bot/acp-autonomous-loop.js`
- Test: `node-bot/test/acp-autonomous-loop.test.js`

**Interfaces:**
- Consumes: `previewRestore(snapshotStore, id)` (Task 4); `snapshotStore.restoreSnapshot(id, {confirmStale})` (Task 2); the existing `createPendingRequest`/`waitForApprovalResult`/`archivePendingRequest`/`getApprovalConfig` helpers already in this file.
- Produces: a new `snapshot_restore` tool case in `executeAutonomousStep`'s dispatch loop, gated by a new `SNAPSHOT_RESTORE_REQUIRE_APPROVAL` env var (defaults to required, same `!== "0"` convention as `FILE_WRITE_REQUIRE_APPROVAL`).

- [ ] **Step 1: Write the failing tests**

```js
// Add to node-bot/test/acp-autonomous-loop.test.js
test("acp-autonomous-loop: snapshot_restore is rejected end to end when the approval is denied", async () => {
  const origRequire = process.env.SNAPSHOT_RESTORE_REQUIRE_APPROVAL;
  const origApprovalDir = process.env.MANA_PENDING_WRITES_DIR;
  const os = require("os");
  const tmpApprovalDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-snapshot-restore-approval-"));
  try {
    process.env.SNAPSHOT_RESTORE_REQUIRE_APPROVAL = "1";
    process.env.MANA_PENDING_WRITES_DIR = tmpApprovalDir;

    const record = { id: "snap-1", kind: "file", key: "a.txt", scope: "/repo", summary: "first write", appliedAt: "t1", source: "agent" };
    const fakeSnapshotStore = {
      getSnapshot: (id) => (id === "snap-1" ? record : null),
      checkStale: () => ({ stale: false }),
      restoreSnapshot: async () => {
        throw new Error("must not restore before approval resolves");
      },
    };

    const mockModelReply = 'Restore it:\n[{"tool":"snapshot_restore","args":{"id":"snap-1"}}]';
    const stepPromise = executeAutonomousStep(mockModelReply, "test-session", { snapshotStore: fakeSnapshotStore });

    // Simulate a human rejecting it, the same way the file_write approval
    // tests would if they exercised this path (they don't -- see the
    // makeApprovalId bug noted separately). Poll briefly for the pending
    // file to appear, then write the rejection marker next to it.
    let pendingFile = null;
    for (let i = 0; i < 50 && !pendingFile; i++) {
      const files = fs.readdirSync(tmpApprovalDir).filter((f) => f.endsWith(".json") && !f.includes(".rejected.") && !f.includes(".approved."));
      if (files.length) pendingFile = files[0];
      else await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(pendingFile, "expected a pending snapshot-restore request file");
    const id = pendingFile.replace(/\.json$/, "");
    fs.writeFileSync(
      path.join(tmpApprovalDir, `${id}.rejected.json`),
      JSON.stringify({ approver: "test", reason: "not now" }),
      "utf8",
    );

    const res = await stepPromise;
    assert.equal(res.results[0].tool, "snapshot_restore");
    assert.equal(res.results[0].status, "rejected");
  } finally {
    process.env.SNAPSHOT_RESTORE_REQUIRE_APPROVAL = origRequire;
    process.env.MANA_PENDING_WRITES_DIR = origApprovalDir;
    fs.rmSync(tmpApprovalDir, { recursive: true, force: true });
  }
});

test("acp-autonomous-loop: snapshot_restore proceeds immediately when args.approved is true, skipping the approval wait", async () => {
  const origRequire = process.env.SNAPSHOT_RESTORE_REQUIRE_APPROVAL;
  try {
    process.env.SNAPSHOT_RESTORE_REQUIRE_APPROVAL = "1";

    const record = { id: "snap-2", kind: "skill", key: "x.md", scope: null, summary: "skill update: X", appliedAt: "t1", source: "human" };
    const restoreCalls = [];
    const fakeSnapshotStore = {
      getSnapshot: (id) => (id === "snap-2" ? record : null),
      checkStale: () => ({ stale: false }),
      restoreSnapshot: async (id, opts) => {
        restoreCalls.push({ id, opts });
        return { restored: true };
      },
    };

    const mockModelReply = 'Restore it:\n[{"tool":"snapshot_restore","args":{"id":"snap-2","approved":true}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session", { snapshotStore: fakeSnapshotStore });

    assert.equal(res.results[0].status, "ok");
    assert.deepEqual(restoreCalls, [{ id: "snap-2", opts: { confirmStale: true } }]);
  } finally {
    process.env.SNAPSHOT_RESTORE_REQUIRE_APPROVAL = origRequire;
  }
});

test("acp-autonomous-loop: snapshot_restore reports an error for an unknown snapshot id, without creating a pending request", async () => {
  const origRequire = process.env.SNAPSHOT_RESTORE_REQUIRE_APPROVAL;
  try {
    process.env.SNAPSHOT_RESTORE_REQUIRE_APPROVAL = "1";
    const fakeSnapshotStore = {
      getSnapshot: () => null,
      checkStale: () => null,
      restoreSnapshot: async () => {
        throw new Error("must not be called");
      },
    };

    const mockModelReply = 'Restore it:\n[{"tool":"snapshot_restore","args":{"id":"nope"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session", { snapshotStore: fakeSnapshotStore });

    assert.equal(res.results[0].status, "error");
    assert.equal(res.results[0].detail, "snapshot_not_found");
  } finally {
    process.env.SNAPSHOT_RESTORE_REQUIRE_APPROVAL = origRequire;
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test node-bot/test/acp-autonomous-loop.test.js`
Expected: FAIL — `snapshot_restore` isn't a recognized tool yet, so `res.results` is empty or the action falls through unhandled.

- [ ] **Step 3: Add the `crypto` require and a local id generator**

```js
// node-bot/acp-autonomous-loop.js -- add near the top, alongside the
// existing axios/fs/path requires
const crypto = require("crypto");
```

```js
// node-bot/acp-autonomous-loop.js -- add near makeApprovalId's call site
// (this file's own file_write case calls a makeApprovalId() that doesn't
// exist anywhere in the codebase -- a separate, pre-existing bug, tracked
// on its own, not fixed by this plan). snapshot_restore gets its own
// self-contained generator rather than depending on that broken one.
function makeSnapshotRestoreApprovalId() {
  return `snapshot-restore-${crypto.randomBytes(4).toString("hex")}`;
}
```

- [ ] **Step 4: Add the `snapshot_restore` tool case, importing `previewRestore`**

```js
// node-bot/acp-autonomous-loop.js -- add near the top, alongside the
// existing const { createSnapshotStore } = require("./snapshot-store");
const { previewRestore } = require("./ai/snapshot-tool-source");
```

```js
// node-bot/acp-autonomous-loop.js -- add a new tool case in the dispatch
// loop (inside the same for (const action of actions) loop as file_write,
// e.g. placed right after the file_write case's closing `continue;`).
// Mirrors file_write's approval shape exactly:
// createPendingRequest/waitForApprovalResult/archivePendingRequest, gated
// by an env-var-controlled require-approval flag -- SNAPSHOT_RESTORE_REQUIRE_APPROVAL
// instead of FILE_WRITE_REQUIRE_APPROVAL, so the two are independently
// tunable. Never auto-decided beyond the same args.approved === true
// escape hatch file_write already offers its own caller.
if (tool === "snapshot_restore") {
  const id = args && args.id ? String(args.id) : null;
  if (!id) {
    results.push({ tool: "snapshot_restore", status: "error", detail: "missing_id" });
    continue;
  }

  const preview = previewRestore(snapshotStore, id);
  if (!preview) {
    results.push({ tool: "snapshot_restore", status: "error", detail: "snapshot_not_found" });
    continue;
  }

  const requireApproval = (process.env.SNAPSHOT_RESTORE_REQUIRE_APPROVAL || "1") !== "0";
  let approvalId = null;
  let approvalPayload = null;
  if (requireApproval && !(args && args.approved === true)) {
    approvalId = makeSnapshotRestoreApprovalId();
    approvalPayload = {
      id: approvalId,
      snapshotId: id,
      kind: preview.record.kind,
      key: preview.record.key,
      summary: preview.summary,
      stale: Boolean(preview.staleness && preview.staleness.stale),
      sessionId: sessionId || null,
      createdAt: new Date().toISOString(),
    };
    try {
      await createPendingRequest(approvalId, approvalPayload);
      console.error(`  ⏳ snapshot_restore pending approval id=${approvalId} snapshotId=${id}`);
      const appr = await waitForApprovalResult(approvalId);
      if (!appr.approved) {
        try {
          await archivePendingRequest(approvalId, "rejected", appr.meta, approvalPayload);
        } catch (e) {}
        results.push({
          tool: "snapshot_restore",
          status: "rejected",
          detail: appr.timeout ? "approval_timeout" : (appr.meta && appr.meta.reason) || "rejected",
        });
        continue;
      }
      console.error(`  ✅ snapshot_restore approved id=${approvalId} by ${appr.meta?.approver || "unknown"}`);
    } catch (e) {
      results.push({ tool: "snapshot_restore", status: "error", detail: "approval_error:" + String(e.message || e) });
      continue;
    }
  }

  try {
    // confirmStale: true -- staleness (if any) was already carried in the
    // pending-request payload above and shown to whoever approved it,
    // exactly like Pipeline A's tool source; approval here IS the
    // confirm-anyway decision.
    const result = await snapshotStore.restoreSnapshot(id, { confirmStale: true });
    results.push({ tool: "snapshot_restore", status: "ok", result });
    if (approvalId) {
      try {
        await archivePendingRequest(approvalId, "approved", null, approvalPayload);
      } catch (e) {
        console.warn("archiving pending request failed", e?.message || e);
      }
    }
  } catch (err) {
    results.push({ tool: "snapshot_restore", status: "error", detail: err.message });
    if (approvalId) {
      try {
        await archivePendingRequest(approvalId, "error", { error: String(err.message) }, approvalPayload);
      } catch (e) {}
    }
  }
  continue;
}
```

- [ ] **Step 5: Run them to verify they pass**

Run: `node --test node-bot/test/acp-autonomous-loop.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add node-bot/acp-autonomous-loop.js node-bot/test/acp-autonomous-loop.test.js
git commit -m "Add snapshot_restore to Pipeline B's autonomous tool switch (#475)"
```

---

## Self-Review Notes

- **Spec coverage:** Design 1 (tool source shape, two tools, prompt-level source restriction in tool descriptions) → Task 4. Design 2 (`source` field, 7 call sites) → Task 1, with the `rememberFact` mixed-caller correction called out explicitly in Global Constraints. Design 3 (staleness check inside `restoreSnapshot` itself, benefiting every caller) → Task 2. Design 4 (Pipeline A wiring via `approvalGate`, Pipeline B wiring via its own primitives, shared core logic, unscoped global store) → Tasks 4-6. Design 5 (audit trail) → no task needed; both pipelines' existing `wrapWithToolCallLog`/result-logging already cover any plain tool call, confirmed by Task 4/6 not bypassing either. Design 6 (concurrent-task safety) → explicitly out of scope, no task. Testing section's five bullets → Tasks 1 (source), 2 (staleness unit tests), 4 (tool-source unit tests), 5 (Pipeline A wiring test), 6 (Pipeline B wiring test).
- **Placeholder scan:** every step above contains real, runnable code; no `TBD`/"add appropriate handling"/"similar to Task N" text.
- **Type consistency:** `previewRestore(snapshotStore, id)` — same name/shape used in both Task 4's own tests and Task 6's `require("./ai/snapshot-tool-source")`. `restoreSnapshot(id, {confirmStale})` — same signature used in Tasks 2, 3, 4, and 6. `checkStale(id)` — same signature/return shape (`{stale, newerSnapshotId?, newerAppliedAt?}` or `null`) used everywhere it's called.
