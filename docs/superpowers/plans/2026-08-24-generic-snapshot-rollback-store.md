# Generic Snapshot/Rollback Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `node-bot/edit-snapshot-store.js` (#428's file-only snapshot store) with a generic, kind-agnostic `node-bot/snapshot-store.js` that four different subsystems — file writes, memory session records, memory facts, and skill definitions — can all record prior state into and restore from, through one shared `registerRestorer`/`restoreSnapshot` mechanism.

**Architecture:** One new module (`snapshot-store.js`) owns storage, retention, and restore dispatch; it knows nothing about files, sessions, facts, or skills. Each of the four owning modules (`zed-integration.js`, `acp-autonomous-loop.js`, `acp-memory-store.js`, `skills-store.js`) registers exactly one restorer function per kind it owns, and calls `recordSnapshot` at its own existing read-before-write point. This mirrors `approval-gate.js`'s `registerExecutor`/`runExecutor` idiom, which already exists in this codebase for the same "gate knows nothing about the action" reason.

**Tech Stack:** Node.js (CommonJS, `node:fs`/`node:path`), `node:test` + `node:assert/strict` for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-22-generic-snapshot-rollback-store-design.md`

## Global Constraints

- On-disk record shape: `{id, kind, key, scope, payload, summary, appliedAt}` — `payload` is never included in `listSnapshots()` output, only in `getSnapshot()`/via `restoreSnapshot()`.
- Retention env var stays `MANA_MAX_EDIT_SNAPSHOTS` (unchanged name), applied as **four independent per-kind pools**, not one shared pool.
- `restoreSnapshot` deletes a snapshot only after its restorer's promise resolves; a throwing restorer leaves the snapshot in place.
- `recordSnapshot` is best-effort everywhere it's called from an existing mutator: wrap in `try/catch`, `console.warn` on failure, never block the primary write.
- No migration of existing on-disk #428 snapshot files — deletion of the old store makes them immediately inaccessible, deliberately.
- Atomic tmp+rename write discipline (`writeJsonAtomic`) is preserved from #428's store.

---

## Task 1: Create the generic `snapshot-store.js`

**Files:**
- Create: `node-bot/snapshot-store.js`
- Test: `node-bot/test/snapshot-store.test.js`

**Interfaces:**
- Produces: `createSnapshotStore(options)` returning `{ recordSnapshot({kind, key, scope, payload, summary}), listSnapshots(kind?), getSnapshot(id), deleteSnapshot(id), registerRestorer(kind, fn), restoreSnapshot(id) }`. `options`: `dataDir`, `now`, `idFactory`, `maxRetained` (same names/defaults as #428's `createEditSnapshotStore`, plus the store self-registers a `"file"` restorer).

- [ ] **Step 1: Write `node-bot/snapshot-store.js`**

```js
// #426 sub-project 1: a generic, kind-agnostic snapshot/rollback store.
// Replaces edit-snapshot-store.js (#428) -- same on-disk shape and atomic
// tmp+rename write discipline, generalized so any kind of undoable prior
// state (a file's content, a memory session record, a memory fact, a skill
// file) can be recorded and restored through one shared mechanism, the same
// way approval-gate.js's registerExecutor/runExecutor lets any actionType
// plug in its own handler without the gate knowing what the action does.
const fs = require("node:fs");
const path = require("node:path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Same atomic tmp+rename pattern acp-memory-store.js's writeJsonObject and
// #428's edit-snapshot-store.js use -- a crash mid-write must never leave a
// half-written, unreadable snapshot behind.
function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function createSnapshotStore(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.MANA_SNAPSHOTS_DIR ||
    path.join(__dirname, "data", "snapshots");
  const now = options.now || (() => new Date().toISOString());
  const idFactory =
    options.idFactory ||
    (() => `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  // A fixed-depth undo stack per kind, not a date-based archive -- these are
  // a lightweight per-write undo convenience, not an audit trail, so
  // there's no retention window worth preserving, only a cap on how many
  // (potentially large) payload copies accumulate on disk. Kept as the same
  // env var name #428 used (MANA_MAX_EDIT_SNAPSHOTS) -- it's not part of
  // any public API and renaming it buys nothing.
  const configuredMaxRetained = Number(
    options.maxRetained || process.env.MANA_MAX_EDIT_SNAPSHOTS || 100,
  );
  // A non-numeric MANA_MAX_EDIT_SNAPSHOTS (e.g. an operator typo) must not
  // silently become NaN here -- NaN defeats pruneOldest's own bounds check
  // below (`all.length <= maxRetained` is always false, `all.slice(NaN)` is
  // `all.slice(0)`) and every snapshot gets deleted right after it's written.
  const maxRetained = Math.max(
    1,
    Number.isFinite(configuredMaxRetained) ? configuredMaxRetained : 100,
  );

  // Mirrors approval-gate.js's registerExecutor/executors Map -- restorers
  // are registered once per kind at wiring time, not stored per-request.
  const restorers = new Map();

  // id ultimately comes from a REST route param (POST .../snapshots/:id/restore)
  // -- reject anything that would resolve outside dataDir (e.g. "../../etc/passwd")
  // or into a subdirectory, the same containment check #428's store and
  // zed-integration.js's toWorkspaceRelativePath use. getSnapshot/deleteSnapshot
  // already treat a thrown error here as "not found", so this needs no
  // change at either call site.
  function snapshotPath(id) {
    const resolvedDir = path.resolve(dataDir);
    const resolved = path.resolve(resolvedDir, `${id}.json`);
    const relative = path.relative(resolvedDir, resolved);
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative.includes(path.sep)
    ) {
      throw new Error("invalid snapshot id");
    }
    return resolved;
  }

  function listSnapshotFiles() {
    ensureDir(dataDir);
    return fs
      .readdirSync(dataDir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp.json"));
  }

  // Metadata only (no payload) -- a list view doesn't need a potentially-large
  // record body, only getSnapshot()/restoreSnapshot() do. Newest first, same
  // order a user expects from an undo stack. kind is optional: every real
  // caller only ever wants its own kind, so filtering here means no caller
  // needs to know or care that the other kinds exist.
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

  function getSnapshot(id) {
    try {
      return JSON.parse(fs.readFileSync(snapshotPath(id), "utf8"));
    } catch (e) {
      return null;
    }
  }

  function deleteSnapshot(id) {
    try {
      fs.unlinkSync(snapshotPath(id));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Scoped to one kind -- with four kinds of wildly different write
  // frequency (memory-session snapshots on every mutator call vs. rare file
  // writes), a single shared pool would let high-frequency, low-stakes
  // churn evict the rare, high-stakes snapshot a user actually wanted. Each
  // kind gets its own independent budget instead.
  function pruneOldest(kind) {
    const all = listSnapshots(kind);
    if (all.length <= maxRetained) return;
    for (const record of all.slice(maxRetained)) {
      deleteSnapshot(record.id);
    }
  }

  function recordSnapshot({ kind, key, scope, payload, summary } = {}) {
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
    };
  }

  function registerRestorer(kind, fn) {
    restorers.set(kind, fn);
  }

  // Looks up the snapshot, calls the registered restorer for its kind, and
  // deletes the snapshot only after the restorer's promise resolves -- a
  // transient failure (a briefly-locked file, a momentary permission error)
  // leaves the snapshot exactly as it was, so calling restoreSnapshot(id)
  // again is a valid retry, not a lost undo.
  async function restoreSnapshot(id) {
    const record = getSnapshot(id);
    if (!record) {
      throw new Error("snapshot not found");
    }
    const restorer = restorers.get(record.kind);
    if (typeof restorer !== "function") {
      throw new Error(`no restorer registered for kind: ${record.kind}`);
    }
    const result = await restorer(record.key, record.payload, record.scope);
    deleteSnapshot(id);
    return result;
  }

  // Built in, not left to whichever pipeline module happens to load first --
  // restoring a file needs zero pipeline-specific knowledge (just fs/path),
  // so both zed-integration.js (pipeline A) and acp-autonomous-loop.js
  // (pipeline B) reuse this same registration instead of each registering
  // their own, which would be a double-registration bug.
  registerRestorer("file", async (key, payload, scope) => {
    const fullPath = path.resolve(scope, key);
    fs.writeFileSync(fullPath, payload, "utf8");
    const written = fs.readFileSync(fullPath, "utf8");
    if (written !== payload) {
      throw new Error("restore failed verification");
    }
    return { restoredPath: fullPath };
  });

  return {
    recordSnapshot,
    listSnapshots,
    getSnapshot,
    deleteSnapshot,
    registerRestorer,
    restoreSnapshot,
  };
}

module.exports = { createSnapshotStore };
```

- [ ] **Step 2: Write `node-bot/test/snapshot-store.test.js`**

```js
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
```

- [ ] **Step 3: Run the new tests**

Run: `node --test node-bot/test/snapshot-store.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 4: Commit**

```bash
git add node-bot/snapshot-store.js node-bot/test/snapshot-store.test.js
git commit -m "feat: add generic snapshot/rollback store (#426 sub-project 1)"
```

---

## Task 2: Migrate #428 (`edit-snapshot-store.js`) onto the generic store

**Files:**
- Delete: `node-bot/edit-snapshot-store.js`
- Delete: `node-bot/test/edit-snapshot-store.test.js`
- Modify: `node-bot/zed-integration.js:6` (require), `:727-735` (store construction), `:844-850` (recordSnapshot call), `:896-905` (listEditSnapshots), `:907-946` (restoreEditSnapshot)
- Modify: `node-bot/server.js:2353-2364` (restore REST route, now async)
- Modify: `node-bot/test/zed-integration.test.js` (snapshot tests: `:1423-1461`, `:1463-1503`, `:1505-1547`, `:1549-1567`)
- Test: `node-bot/test/zed-integration.test.js` (existing suite, updated in place)

**Interfaces:**
- Consumes: `createSnapshotStore` from Task 1 (`node-bot/snapshot-store.js`).
- Produces: `zed-integration.js`'s public shape is unchanged (`listEditSnapshots()` still returns `{id, relativePath, summary, appliedAt}[]`; `restoreEditSnapshot(id)` is now `async` and still returns `{id, relativePath, restoredAt}`, but as a Promise).

- [ ] **Step 1: Delete the old store and its test**

```bash
git rm node-bot/edit-snapshot-store.js node-bot/test/edit-snapshot-store.test.js
```

- [ ] **Step 2: Swap the require in `zed-integration.js`**

In `node-bot/zed-integration.js:6`, replace:

```js
const { createEditSnapshotStore } = require("./edit-snapshot-store");
```

with:

```js
const { createSnapshotStore } = require("./snapshot-store");
```

- [ ] **Step 3: Swap the store construction in `createEditorIntegrations`**

In `node-bot/zed-integration.js:727-735`, replace:

```js
  // Issue #428: restorable snapshots of applied edits, independent of git.
  const snapshotStore =
    options.snapshotStore ||
    createEditSnapshotStore({
      dataDir: options.snapshotsDir,
      now: options.now,
      idFactory: options.snapshotIdFactory,
      maxRetained: options.maxRetainedSnapshots,
    });
```

with:

```js
  // Issue #428/#426: restorable snapshots of applied edits, independent of
  // git -- now backed by the generic kind-agnostic store (snapshot-store.js).
  const snapshotStore =
    options.snapshotStore ||
    createSnapshotStore({
      dataDir: options.snapshotsDir,
      now: options.now,
      idFactory: options.snapshotIdFactory,
      maxRetained: options.maxRetainedSnapshots,
    });
```

- [ ] **Step 4: Update `approveEditProposal`'s `recordSnapshot` call**

In `node-bot/zed-integration.js:844-850`, replace:

```js
    const snapshot = snapshotStore.recordSnapshot({
      proposalId: id,
      workspacePath: path.resolve(workspace.path),
      relativePath: target.relativePath,
      originalContent: currentContent,
      summary: proposal.summary,
    });
```

with:

```js
    const snapshot = snapshotStore.recordSnapshot({
      kind: "file",
      key: target.relativePath,
      scope: path.resolve(workspace.path),
      payload: currentContent,
      summary: proposal.summary,
    });
```

- [ ] **Step 5: Update `listEditSnapshots` to filter by kind/scope and map back to the old public shape**

In `node-bot/zed-integration.js:896-905`, replace:

```js
  function listEditSnapshots() {
    const workspace = workspaceStore.getWorkspace();
    if (!workspace?.path) {
      return [];
    }
    const workspacePath = path.resolve(workspace.path);
    return snapshotStore
      .listSnapshots()
      .filter((record) => record.workspacePath === workspacePath);
  }
```

with:

```js
  function listEditSnapshots() {
    const workspace = workspaceStore.getWorkspace();
    if (!workspace?.path) {
      return [];
    }
    const workspacePath = path.resolve(workspace.path);
    return snapshotStore
      .listSnapshots("file")
      .filter((record) => record.scope === workspacePath)
      .map((record) => ({
        id: record.id,
        relativePath: record.key,
        summary: record.summary,
        appliedAt: record.appliedAt,
      }));
  }
```

Note: the generic record shape has no room for #428's `proposalId` field (it was pipeline-A-specific bookkeeping, not part of the four "what's undoable" targets this store generalizes). It is dropped here — callers that need the proposal's own id already have it via `applied.id` from `approveEditProposal`/`proposalStore.markApplied`, so nothing is actually lost.

- [ ] **Step 6: Update `restoreEditSnapshot` to delegate to the generic `restoreSnapshot`**

In `node-bot/zed-integration.js:907-946`, replace:

```js
  // Deliberately no conflict check against the file's current content --
  // unlike approveEditProposal, which knows exactly what content it expects
  // to find (the proposal it's applying), a snapshot only knows what the
  // file looked like before ITS edit, not what may have changed since. This
  // is a simple, git-independent undo convenience, not a merge system;
  // the UI confirming with the user before restoring is the real safety
  // net here, the same way file_write's approval gate is the safety net
  // for autonomous-loop writes rather than code-level conflict detection.
  function restoreEditSnapshot(id) {
    const record = snapshotStore.getSnapshot(id);
    if (!record) {
      throw new Error("edit snapshot not found");
    }

    const workspace = requireActiveWorkspace(workspaceStore);
    if (record.workspacePath !== path.resolve(workspace.path)) {
      throw new Error("edit snapshot belongs to a different workspace");
    }
    const target = toWorkspaceRelativePath(workspace.path, record.relativePath);
    if (!fs.existsSync(target.fullPath) || !fs.statSync(target.fullPath).isFile()) {
      throw new Error("workspace file does not exist");
    }

    fs.writeFileSync(target.fullPath, record.originalContent, "utf8");

    // Issue #387's same read-back-before-claiming-success discipline.
    const writtenContent = fs.readFileSync(target.fullPath, "utf8");
    if (writtenContent !== record.originalContent) {
      throw new Error(
        "edit snapshot restore failed verification: file on disk does not match the restored content",
      );
    }

    snapshotStore.deleteSnapshot(id);
    return {
      id,
      relativePath: record.relativePath,
      restoredAt: new Date().toISOString(),
    };
  }
```

with:

```js
  // Deliberately no conflict check against the file's current content --
  // unlike approveEditProposal, which knows exactly what content it expects
  // to find (the proposal it's applying), a snapshot only knows what the
  // file looked like before ITS edit, not what may have changed since. This
  // is a simple, git-independent undo convenience, not a merge system;
  // the UI confirming with the user before restoring is the real safety
  // net here, the same way file_write's approval gate is the safety net
  // for autonomous-loop writes rather than code-level conflict detection.
  //
  // Delegates the actual write+verify+delete to the generic store's
  // built-in "file" restorer (snapshot-store.js) -- the checks kept here
  // (workspace mismatch, file-must-already-exist) are pipeline-A-specific
  // safety rules the generic store has no business knowing about.
  async function restoreEditSnapshot(id) {
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

    await snapshotStore.restoreSnapshot(id);
    return {
      id,
      relativePath: record.key,
      restoredAt: new Date().toISOString(),
    };
  }
```

- [ ] **Step 7: Make the REST restore route await the now-async `restoreEditSnapshot`**

In `node-bot/server.js:2353-2364`, replace:

```js
  app.post("/editors/workspace/snapshots/:id/restore", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const editors = getEditorIntegrations();
      return res.json({ restored: editors.restoreEditSnapshot(req.params.id) });
    } catch (error) {
      return res.status(400).json({
        restored: null,
        error: error.message,
      });
    }
  });
```

with:

```js
  app.post("/editors/workspace/snapshots/:id/restore", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const editors = getEditorIntegrations();
      const restored = await editors.restoreEditSnapshot(req.params.id);
      return res.json({ restored });
    } catch (error) {
      return res.status(400).json({
        restored: null,
        error: error.message,
      });
    }
  });
```

- [ ] **Step 8: Update `zed-integration.test.js`'s snapshot tests**

In `node-bot/test/zed-integration.test.js:1454`, remove the now-nonexistent `proposalId` assertion. Replace:

```js
    assert.equal(snapshots[0].id, applied.snapshotId);
    assert.equal(snapshots[0].proposalId, "proposal-snap-1");
    assert.equal(snapshots[0].relativePath, "src.js");
    assert.equal(snapshots[0].summary, "Update value");
```

with:

```js
    assert.equal(snapshots[0].id, applied.snapshotId);
    assert.equal(snapshots[0].relativePath, "src.js");
    assert.equal(snapshots[0].summary, "Update value");
```

In `node-bot/test/zed-integration.test.js:1463`, `restoreEditSnapshot` is now async: replace the test signature and its calls. Replace:

```js
test("restoreEditSnapshot writes the pre-edit content back, verifies it, and removes the snapshot", () => {
```

with:

```js
test("restoreEditSnapshot writes the pre-edit content back, verifies it, and removes the snapshot", async () => {
```

then in the same test (around `:1488-1497`), replace:

```js
    const restored = editors.restoreEditSnapshot(applied.snapshotId);
    assert.equal(restored.id, applied.snapshotId);
    assert.equal(restored.relativePath, "src.js");
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "const value = 1;\n");

    // Restored once -- it's consumed, not a repeatable checkpoint.
    assert.deepEqual(editors.listEditSnapshots(), []);
    assert.throws(
      () => editors.restoreEditSnapshot(applied.snapshotId),
      /edit snapshot not found/,
    );
```

with:

```js
    const restored = await editors.restoreEditSnapshot(applied.snapshotId);
    assert.equal(restored.id, applied.snapshotId);
    assert.equal(restored.relativePath, "src.js");
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "const value = 1;\n");

    // Restored once -- it's consumed, not a repeatable checkpoint.
    assert.deepEqual(editors.listEditSnapshots(), []);
    await assert.rejects(
      () => editors.restoreEditSnapshot(applied.snapshotId),
      /edit snapshot not found/,
    );
```

In `node-bot/test/zed-integration.test.js:1505`, the workspace-mismatch test also calls `restoreEditSnapshot` synchronously. Replace:

```js
test("a snapshot recorded in one workspace is invisible and unrestorable after switching to another", () => {
```

with:

```js
test("a snapshot recorded in one workspace is invisible and unrestorable after switching to another", async () => {
```

then (around `:1537-1540`), replace:

```js
    assert.deepEqual(editors.listEditSnapshots(), []);
    assert.throws(
      () => editors.restoreEditSnapshot(applied.snapshotId),
      /edit snapshot belongs to a different workspace/,
    );
```

with:

```js
    assert.deepEqual(editors.listEditSnapshots(), []);
    await assert.rejects(
      () => editors.restoreEditSnapshot(applied.snapshotId),
      /edit snapshot belongs to a different workspace/,
    );
```

In `node-bot/test/zed-integration.test.js:1549`, the unknown-id test. Replace:

```js
test("restoreEditSnapshot rejects an unknown snapshot id", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-restore-unknown-"));
  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
    });

    assert.throws(
      () => editors.restoreEditSnapshot("no-such-snapshot"),
      /edit snapshot not found/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
```

with:

```js
test("restoreEditSnapshot rejects an unknown snapshot id", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-restore-unknown-"));
  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
    });

    await assert.rejects(
      () => editors.restoreEditSnapshot("no-such-snapshot"),
      /edit snapshot not found/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
```

The remaining snapshot tests (`an already-applied (no-op) approve...`, the two `createApp lists and restores...`/`createApp returns an error...` route tests) need no changes — they either never call `restoreEditSnapshot` directly or already go through `fetch`/`await`.

- [ ] **Step 9: Run the full zed-integration suite**

Run: `node --test node-bot/test/zed-integration.test.js`
Expected: PASS, all tests including the 8 snapshot-related ones.

- [ ] **Step 10: Commit**

```bash
git add node-bot/zed-integration.js node-bot/server.js node-bot/test/zed-integration.test.js node-bot/edit-snapshot-store.js node-bot/test/edit-snapshot-store.test.js
git commit -m "refactor: migrate #428 edit snapshots onto the generic snapshot store"
```

---

## Task 3: Wire memory-session and memory-fact restorers into `acp-memory-store.js`

**Files:**
- Modify: `node-bot/acp-memory-store.js:208-231` (options/snapshotStore setup + restorer registration), `:471-492` (rememberFact snapshot), `:898-909` (renameSession snapshot), `:915-926` (setSessionGoal snapshot), `:1033-1138` (appendTurn snapshot)
- Test: `node-bot/test/acp-memory-store.test.js` (new cases appended)

**Interfaces:**
- Consumes: `createSnapshotStore` from Task 1, passed in as `options.snapshotStore` (optional — when absent, snapshotting is skipped entirely so every existing test/call site that doesn't pass one keeps working unchanged).
- Produces: when `options.snapshotStore` is provided, `createAcpMemoryStore` registers `"memory-session"` and `"memory-fact"` restorers on it, and `setSessionGoal`/`appendTurn`/`renameSession`/`rememberFact` each call `recordSnapshot` at their existing read point.

- [ ] **Step 1: Add `snapshotStore` option and restorer registration**

In `node-bot/acp-memory-store.js`, after the existing options block (`:208-231`, right after the `const dataDir = ...` / `const sessionsDir = ...` block and before `const now = options.now || ...` at `:231`), the function currently reads (showing the anchor line):

```js
  const now = options.now || (() => new Date().toISOString());
```

Insert immediately before that line:

```js
  // #426 sub-project 1: optional -- most callers (tests, older wiring) don't
  // need snapshotting, so its absence is a silent no-op rather than a
  // required dependency threaded through every existing construction site.
  const snapshotStore = options.snapshotStore || null;
```

Then, after the closing of `createAcpMemoryStore`'s function-declaration section but before its final `return {...}` (i.e. anywhere after `saveSession`, `loadFacts`, and `saveFacts` are declared -- function declarations are hoisted, so textual placement doesn't matter for correctness; place it directly after the `snapshotStore` const above for readability), add:

```js
  if (snapshotStore) {
    snapshotStore.registerRestorer("memory-session", async (sessionId, session) => {
      saveSession(session);
      return { sessionId };
    });

    snapshotStore.registerRestorer("memory-fact", async (key, snapshotPayload) => {
      const facts = loadFacts();
      const idx = facts.findIndex((f) => f.key === key);
      if (snapshotPayload === null) {
        // The fact didn't exist before this write -- restoring means removing it.
        if (idx !== -1) facts.splice(idx, 1);
      } else if (idx === -1) {
        facts.push(snapshotPayload);
      } else {
        facts[idx] = snapshotPayload;
      }
      saveFacts(facts);
      return { key };
    });
  }
```

- [ ] **Step 2: Snapshot in `renameSession`**

In `node-bot/acp-memory-store.js:898-909`, replace:

```js
  function renameSession(sessionId, name) {
    const existing = getSession(cleanText(sessionId, 240));
    if (!existing) {
      return null;
    }

    return saveSession({
      ...existing,
      name: cleanText(name, 80) || null,
      updatedAt: now(),
    });
  }
```

with:

```js
  function renameSession(sessionId, name) {
    const existing = getSession(cleanText(sessionId, 240));
    if (!existing) {
      return null;
    }

    if (snapshotStore) {
      try {
        snapshotStore.recordSnapshot({
          kind: "memory-session",
          key: existing.sessionId,
          payload: existing,
          summary: `session rename: ${existing.sessionId}`,
        });
      } catch (e) {
        console.warn("Session snapshot failed:", e?.message || e);
      }
    }

    return saveSession({
      ...existing,
      name: cleanText(name, 80) || null,
      updatedAt: now(),
    });
  }
```

- [ ] **Step 3: Snapshot in `setSessionGoal`**

In `node-bot/acp-memory-store.js:915-926`, replace:

```js
  function setSessionGoal(sessionId, goal) {
    const existing = getSession(cleanText(sessionId, 240));
    if (!existing) {
      return null;
    }

    return saveSession({
      ...existing,
      goal: cleanText(goal, 500) || null,
      updatedAt: now(),
    });
  }
```

with:

```js
  function setSessionGoal(sessionId, goal) {
    const existing = getSession(cleanText(sessionId, 240));
    if (!existing) {
      return null;
    }

    if (snapshotStore) {
      try {
        snapshotStore.recordSnapshot({
          kind: "memory-session",
          key: existing.sessionId,
          payload: existing,
          summary: `session goal change: ${existing.sessionId}`,
        });
      } catch (e) {
        console.warn("Session snapshot failed:", e?.message || e);
      }
    }

    return saveSession({
      ...existing,
      goal: cleanText(goal, 500) || null,
      updatedAt: now(),
    });
  }
```

- [ ] **Step 4: Snapshot in `appendTurn`**

In `node-bot/acp-memory-store.js`, `appendTurn` builds up `turns`/`summary`/`name` from the pre-mutation `session` variable (captured via `ensureSession` near the top of the function) and only writes with `saveSession` near the end. Find this exact block (around `:1129-1138`):

```js
    const turns = [...session.turns, turn];
    const name =
      session.name || (!session.turns.length && autoNameFromText(turn.user)) || null;
    const saved = saveSession({
      ...session,
      name,
      summary,
      turns,
      updatedAt: timestamp,
    });
```

Replace with:

```js
    const turns = [...session.turns, turn];
    const name =
      session.name || (!session.turns.length && autoNameFromText(turn.user)) || null;

    if (snapshotStore) {
      try {
        snapshotStore.recordSnapshot({
          kind: "memory-session",
          key: session.sessionId,
          payload: session,
          summary: `turn appended: ${session.sessionId}`,
        });
      } catch (e) {
        console.warn("Session snapshot failed:", e?.message || e);
      }
    }

    const saved = saveSession({
      ...session,
      name,
      summary,
      turns,
      updatedAt: timestamp,
    });
```

This snapshots right before the write (not at the top of `appendTurn`, where `ensureSession` runs) so the early return for an empty turn (`if (!turn.user && !turn.assistant) { return session; }`, a few lines above) never records a wasted snapshot for a no-op call.

- [ ] **Step 5: Snapshot in `rememberFact`**

In `node-bot/acp-memory-store.js:471-492`, find the read point:

```js
    const facts = loadFacts();
    const existing = facts.find(
      (f) => f.status === "active" && f.key.toLowerCase() === cleanKey.toLowerCase(),
    );
    const timestamp = now();

    if (normalizedAction === "remove" || normalizedAction === "archive") {
```

Replace with:

```js
    const facts = loadFacts();
    const existing = facts.find(
      (f) => f.status === "active" && f.key.toLowerCase() === cleanKey.toLowerCase(),
    );
    const timestamp = now();

    if (snapshotStore) {
      try {
        // Deep-cloned: `existing` is a live reference into `facts`, and the
        // patch branch below mutates it in place (existing.history.push(...)
        // mutates the same array existing.history already pointed at) before
        // ever reassigning it -- a shallow copy taken here would still be
        // corrupted by that mutation by the time it's serialized.
        snapshotStore.recordSnapshot({
          kind: "memory-fact",
          key: cleanKey,
          payload: existing ? JSON.parse(JSON.stringify(existing)) : null,
          summary: `fact ${normalizedAction}: ${cleanKey}`,
        });
      } catch (e) {
        console.warn("Fact snapshot failed:", e?.message || e);
      }
    }

    if (normalizedAction === "remove" || normalizedAction === "archive") {
```

This single insertion covers all four `rememberFact` branches (`insert`, `patch`, `remove`, `archive`) since they all fall through this one point before any of them mutate `facts`/`existing` or call `saveFacts`.

- [ ] **Step 6: Run the existing memory-store suite to confirm nothing broke**

Run: `node --test node-bot/test/acp-memory-store.test.js`
Expected: PASS (no `snapshotStore` is passed by existing tests, so this exercises the `snapshotStore` absent/no-op path).

- [ ] **Step 7: Add new snapshot/restore test cases**

Append to `node-bot/test/acp-memory-store.test.js`:

```js
const { createSnapshotStore } = require("../snapshot-store");

test("appendTurn/setSessionGoal/renameSession snapshot the pre-write session record, restorable via the generic store", async () => {
  const dataDir = createTempDir();
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const store = createAcpMemoryStore({ dataDir, snapshotStore });

  store.ensureSession({ sessionId: "snap-session-1" });
  await store.appendTurn({
    sessionId: "snap-session-1",
    user: "Remember I like tea.",
    assistant: "Noted.",
  });

  const afterFirstTurn = store.getSession("snap-session-1");
  assert.equal(afterFirstTurn.turns.length, 1);

  store.setSessionGoal("snap-session-1", "Plan a trip");
  const beforeRename = store.getSession("snap-session-1");
  assert.equal(beforeRename.goal, "Plan a trip");

  const snapshots = snapshotStore.listSnapshots("memory-session");
  // One from appendTurn (of the pre-turn empty session), one from
  // setSessionGoal (of the pre-goal session).
  assert.equal(snapshots.length, 2);

  // Restoring the setSessionGoal snapshot undoes the goal change but keeps
  // the turn that was appended before it (that's what the snapshot payload
  // captured -- the session as it stood right before the goal write).
  const goalSnapshot = snapshots.find((s) => s.summary.startsWith("session goal change"));
  await snapshotStore.restoreSnapshot(goalSnapshot.id);
  const restored = store.getSession("snap-session-1");
  assert.equal(restored.goal, null);
  assert.equal(restored.turns.length, 1);
});

test("rememberFact snapshots the prior fact state; restoring a freshly-inserted fact deletes it", async () => {
  const dataDir = createTempDir();
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const store = createAcpMemoryStore({ dataDir, snapshotStore });

  const inserted = store.rememberFact({
    sessionId: "fact-session",
    key: "favorite-drink",
    text: "Likes tea",
  });
  assert.equal(inserted.action, "insert");
  assert.equal(store.listFacts().length, 1);

  const [insertSnapshot] = snapshotStore.listSnapshots("memory-fact");
  assert.ok(insertSnapshot);

  // The fact didn't exist before the insert -- restoring must remove it,
  // not error or leave a stale entry.
  await snapshotStore.restoreSnapshot(insertSnapshot.id);
  assert.equal(store.listFacts().length, 0);
});

test("rememberFact patch snapshots the pre-patch fact, restorable back to its prior text", async () => {
  const dataDir = createTempDir();
  const snapshotStore = createSnapshotStore({ dataDir: createTempDir() });
  const store = createAcpMemoryStore({ dataDir, snapshotStore });

  store.rememberFact({ sessionId: "s", key: "favorite-drink", text: "Likes tea" });

  const patched = store.rememberFact({
    sessionId: "s",
    key: "favorite-drink",
    text: "Likes coffee",
    action: "patch",
  });
  assert.equal(patched.action, "patch");
  assert.equal(store.listFacts()[0].text, "Likes coffee");

  const patchSnapshot = snapshotStore
    .listSnapshots("memory-fact")
    .find((s) => s.summary === "fact patch: favorite-drink");
  assert.ok(patchSnapshot);

  await snapshotStore.restoreSnapshot(patchSnapshot.id);
  assert.equal(store.listFacts()[0].text, "Likes tea");
});
```

Confirm `createTempDir` is already defined near the top of this test file (it is, at `node-bot/test/acp-memory-store.test.js:11-13`) — reuse it, no new helper needed.

- [ ] **Step 8: Run the updated suite**

Run: `node --test node-bot/test/acp-memory-store.test.js`
Expected: PASS, including the 3 new snapshot tests.

- [ ] **Step 9: Commit**

```bash
git add node-bot/acp-memory-store.js node-bot/test/acp-memory-store.test.js
git commit -m "feat: snapshot memory sessions and facts before every mutation"
```

---

## Task 4: Wire the skill restorer into `skills-store.js`

**Files:**
- Modify: `node-bot/skills-store.js:214-222` (options/snapshotStore setup + restorer registration), `:424-451` (updateSkill snapshot)
- Test: `node-bot/test/skills-store.test.js` (new case appended)

**Interfaces:**
- Consumes: `createSnapshotStore` from Task 1, passed in as `options.snapshotStore` (optional, same no-op-when-absent behavior as Task 3).
- Produces: when `options.snapshotStore` is provided, `createSkillsStore` registers a `"skill"` restorer, and `updateSkill` calls `recordSnapshot` before overwriting the skill file.

- [ ] **Step 1: Add `snapshotStore` option and restorer registration**

In `node-bot/skills-store.js:214-222`, replace:

```js
function createSkillsStore(options = {}) {
  const skillsDir =
    options.skillsDir ||
    process.env.MANA_SKILLS_DIR ||
    path.join(__dirname, "skills");
  const archiveDir = path.join(skillsDir, ".archive");
  const now = options.now || (() => new Date().toISOString());

  function ensureDir() {
    fs.mkdirSync(skillsDir, { recursive: true });
  }
```

with:

```js
function createSkillsStore(options = {}) {
  const skillsDir =
    options.skillsDir ||
    process.env.MANA_SKILLS_DIR ||
    path.join(__dirname, "skills");
  const archiveDir = path.join(skillsDir, ".archive");
  const now = options.now || (() => new Date().toISOString());
  // #426 sub-project 1: optional, same as acp-memory-store.js -- absence is
  // a silent no-op so existing construction sites keep working unchanged.
  const snapshotStore = options.snapshotStore || null;

  if (snapshotStore) {
    snapshotStore.registerRestorer("skill", async (fileName, fileContent) => {
      fs.writeFileSync(path.join(skillsDir, fileName), fileContent, "utf8");
      return { fileName };
    });
  }

  function ensureDir() {
    fs.mkdirSync(skillsDir, { recursive: true });
  }
```

- [ ] **Step 2: Snapshot in `updateSkill`**

In `node-bot/skills-store.js:424-451`, replace:

```js
  function updateSkill(name, { description, body, category } = {}) {
    const fileName = findFileForName(name);
    if (!fileName) return null;
    const skill = readSkill(fileName);
    if (description !== undefined) {
```

with:

```js
  function updateSkill(name, { description, body, category } = {}) {
    const fileName = findFileForName(name);
    if (!fileName) return null;
    const skill = readSkill(fileName);

    if (snapshotStore) {
      try {
        snapshotStore.recordSnapshot({
          kind: "skill",
          key: fileName,
          payload: serializeSkillFile(skill),
          summary: `skill update: ${skill.name}`,
        });
      } catch (e) {
        console.warn("Skill snapshot failed:", e?.message || e);
      }
    }

    if (description !== undefined) {
```

(The rest of `updateSkill` — the `description`/`body`/`category` field updates and the final `fs.writeFileSync`/`return` — is unchanged.)

- [ ] **Step 3: Run the existing skills-store suite to confirm nothing broke**

Run: `node --test node-bot/test/skills-store.test.js`
Expected: PASS (no `snapshotStore` passed by existing tests, exercising the no-op path).

- [ ] **Step 4: Add a new snapshot/restore test case**

Append to `node-bot/test/skills-store.test.js`:

```js
const { createSnapshotStore } = require("../snapshot-store");

test("updateSkill snapshots the pre-update file content, restorable via the generic store", async () => {
  const skillsDir = tempDir();
  const snapshotStore = createSnapshotStore({ dataDir: tempDir() });
  const store = createSkillsStore({
    skillsDir,
    snapshotStore,
    now: () => "2026-01-01T00:00:00.000Z",
  });

  const skill = store.createSkill({
    name: "Restart SearXNG",
    description: "Original description.",
    body: "Original body.",
  });

  store.updateSkill("Restart SearXNG", { description: "Updated description." });
  assert.equal(store.viewSkill("Restart SearXNG", { touch: false }).description, "Updated description.");

  const [snapshot] = snapshotStore.listSnapshots("skill");
  assert.ok(snapshot);
  assert.equal(snapshot.key, skill.fileName);

  await snapshotStore.restoreSnapshot(snapshot.id);
  const restored = store.viewSkill("Restart SearXNG", { touch: false });
  assert.equal(restored.description, "Original description.");
});
```

- [ ] **Step 5: Run the updated suite**

Run: `node --test node-bot/test/skills-store.test.js`
Expected: PASS, including the new snapshot test.

- [ ] **Step 6: Commit**

```bash
git add node-bot/skills-store.js node-bot/test/skills-store.test.js
git commit -m "feat: snapshot skill files before every updateSkill write"
```

---

## Task 5: Wire pipeline B's `file_write` in `acp-autonomous-loop.js` to the snapshot store

**Files:**
- Modify: `node-bot/acp-autonomous-loop.js:1-11` (require + module-level default store), `:663-673` (overwrite-mode backup block)
- Test: `node-bot/test/acp-autonomous-loop.test.js:1-10` (add `path`/`os` requires), `:225-267` (rewrite the existing overwrite-backup test), new restore round-trip test appended

**Interfaces:**
- Consumes: `createSnapshotStore` from Task 1. `executeAutonomousStep(rawModelReply, sessionId, options)` gains an optional `options.snapshotStore` override (same pattern as its existing `options.testRunner`), defaulting to a module-level `defaultSnapshotStore`.
- Produces: `file_write` overwrite mode now records a `kind: "file"` snapshot (`key`: repo-relative path, `scope`: `REPO_ROOT`, `payload`: prior file content) instead of writing an unreadable `.bak.<timestamp>` copy.

- [ ] **Step 1: Add the require and a module-level default store**

In `node-bot/acp-autonomous-loop.js`, find the top-of-file requires (around `:1-6`):

```js
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { safeJsonParse } = require("./utils/json-extract");
const { scanDir } = require("./tools/dir_scanner");
const { createAcpTestRunner } = require("./acp-test-runner");
```

Replace with:

```js
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { safeJsonParse } = require("./utils/json-extract");
const { scanDir } = require("./tools/dir_scanner");
const { createAcpTestRunner } = require("./acp-test-runner");
const { createSnapshotStore } = require("./snapshot-store");
```

Then find `const defaultTestRunner = createAcpTestRunner();` (`:293`) and add a matching default snapshot store right after it:

```js
const defaultTestRunner = createAcpTestRunner();
// #426 sub-project 1: shared across calls that don't inject their own, same
// as defaultTestRunner above -- a fresh store per call would defeat
// maxRetained pruning (every call would see an empty pool).
const defaultSnapshotStore = createSnapshotStore({});
```

- [ ] **Step 2: Pick up `options.snapshotStore` in `executeAutonomousStep`**

Find (`:295-300`):

```js
async function executeAutonomousStep(rawModelReply, sessionId, options = {}) {
  const testRunner = options.testRunner || defaultTestRunner;
  const makeScratchCopy =
    options.createScratchWorkspaceCopy || createScratchWorkspaceCopy;
  const removeScratchCopy =
    options.removeScratchWorkspaceCopy || removeScratchWorkspaceCopy;
```

Replace with:

```js
async function executeAutonomousStep(rawModelReply, sessionId, options = {}) {
  const testRunner = options.testRunner || defaultTestRunner;
  const snapshotStore = options.snapshotStore || defaultSnapshotStore;
  const makeScratchCopy =
    options.createScratchWorkspaceCopy || createScratchWorkspaceCopy;
  const removeScratchCopy =
    options.removeScratchWorkspaceCopy || removeScratchWorkspaceCopy;
```

- [ ] **Step 3: Replace the `.bak` copy with a `recordSnapshot` call**

In `node-bot/acp-autonomous-loop.js:663-673`, replace:

```js
        } else {
          // Overwrite mode: backup if exists
          try {
            const st = await fs.promises.stat(resolvedPath);
            if (st && st.isFile()) {
              const bak = `${resolvedPath}.bak.${Date.now()}`;
              await fs.promises.copyFile(resolvedPath, bak);
            }
          } catch (e) {
            // ignore if not exists
          }
```

with:

```js
        } else {
          // Overwrite mode: snapshot the prior content instead of writing
          // an unreadable .bak.<timestamp> copy that nothing ever read back
          // -- this makes the write actually undoable via the shared
          // snapshot store's built-in "file" restorer.
          try {
            const st = await fs.promises.stat(resolvedPath);
            if (st && st.isFile()) {
              const priorContent = await fs.promises.readFile(resolvedPath, "utf8");
              try {
                snapshotStore.recordSnapshot({
                  kind: "file",
                  key: path.relative(REPO_ROOT, resolvedPath),
                  scope: REPO_ROOT,
                  payload: priorContent,
                  summary: "file_write overwrite",
                });
              } catch (snapshotErr) {
                console.warn(
                  "file_write snapshot failed:",
                  snapshotErr?.message || snapshotErr,
                );
              }
            }
          } catch (e) {
            // ignore if not exists
          }
```

- [ ] **Step 4: Add `path`/`os` requires to the test file**

In `node-bot/test/acp-autonomous-loop.test.js:1-10`, replace:

```js
const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const fs = require("fs");

const {
  executeAutonomousStep,
  resetSessionTestRetryCounts,
  MAX_TEST_RETRY_ATTEMPTS,
} = require("../acp-autonomous-loop");
```

with:

```js
const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const fs = require("fs");
const os = require("node:os");
const path = require("node:path");

const {
  executeAutonomousStep,
  resetSessionTestRetryCounts,
  MAX_TEST_RETRY_ATTEMPTS,
} = require("../acp-autonomous-loop");
const { createSnapshotStore } = require("../snapshot-store");
```

- [ ] **Step 5: Rewrite the overwrite-backup test to assert on the snapshot instead of the old `.bak` copy**

In `node-bot/test/acp-autonomous-loop.test.js:225-267`, replace:

```js
test("acp-autonomous-loop: file_write overwrite backups and writes when enabled", async (t) => {
  const origEnv = process.env.ALLOW_FILE_WRITE;
  const origApproval = process.env.FILE_WRITE_REQUIRE_APPROVAL;
  const origStat = fs.promises.stat;
  const origCopy = fs.promises.copyFile;
  const origWrite = fs.promises.writeFile;
  try {
    process.env.ALLOW_FILE_WRITE = "1";
    process.env.FILE_WRITE_REQUIRE_APPROVAL = "0";
    let lastWriteSize = null;
    let copyCalled = false;

    // stat behaves: before write -> exists with size 10; after write -> returns {size: lastWriteSize}
    fs.promises.stat = async (p) => {
      if (lastWriteSize === null) return { isFile: () => true, size: 10 };
      return { isFile: () => true, size: lastWriteSize };
    };

    fs.promises.copyFile = async (src, dest) => {
      copyCalled = true;
    };
    fs.promises.writeFile = async (p, content, opts) => {
      lastWriteSize = Buffer.byteLength(content, "utf8");
    };

    const mockModelReply =
      'Write file:\n[{"tool":"file_write","args":{"path":"src/out.txt","content":"hello world","mode":"overwrite"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    assert.ok(Array.isArray(res.results));
    assert.equal(res.results[0].tool, "file_write");
    assert.equal(res.results[0].status, "ok");
    assert.equal(res.results[0].action, "overwritten");
    assert.equal(res.results[0].size, Buffer.byteLength("hello world", "utf8"));
    assert.ok(copyCalled);
  } finally {
    process.env.ALLOW_FILE_WRITE = origEnv;
    process.env.FILE_WRITE_REQUIRE_APPROVAL = origApproval;
    fs.promises.stat = origStat;
    fs.promises.copyFile = origCopy;
    fs.promises.writeFile = origWrite;
  }
});
```

with:

```js
test("acp-autonomous-loop: file_write overwrite records a restorable snapshot instead of a .bak file", async (t) => {
  const origEnv = process.env.ALLOW_FILE_WRITE;
  const origApproval = process.env.FILE_WRITE_REQUIRE_APPROVAL;
  const origStat = fs.promises.stat;
  const origRead = fs.promises.readFile;
  const origWrite = fs.promises.writeFile;
  try {
    process.env.ALLOW_FILE_WRITE = "1";
    process.env.FILE_WRITE_REQUIRE_APPROVAL = "0";
    let lastWriteSize = null;

    // stat behaves: before write -> exists with size 10; after write -> returns {size: lastWriteSize}
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
        return { id: "snap-fake-1", ...record };
      },
    };

    const mockModelReply =
      'Write file:\n[{"tool":"file_write","args":{"path":"src/out.txt","content":"hello world","mode":"overwrite"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session", {
      snapshotStore: fakeSnapshotStore,
    });

    assert.ok(Array.isArray(res.results));
    assert.equal(res.results[0].tool, "file_write");
    assert.equal(res.results[0].status, "ok");
    assert.equal(res.results[0].action, "overwritten");
    assert.equal(res.results[0].size, Buffer.byteLength("hello world", "utf8"));

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].kind, "file");
    assert.equal(recorded[0].key, path.join("src", "out.txt"));
    assert.equal(recorded[0].payload, "previous content");
  } finally {
    process.env.ALLOW_FILE_WRITE = origEnv;
    process.env.FILE_WRITE_REQUIRE_APPROVAL = origApproval;
    fs.promises.stat = origStat;
    fs.promises.readFile = origRead;
    fs.promises.writeFile = origWrite;
  }
});
```

- [ ] **Step 6: Add a restore round-trip test**

Append to `node-bot/test/acp-autonomous-loop.test.js`, immediately after the test from Step 5:

```js
// REPO_ROOT is resolved once at module load (acp-autonomous-loop.js top
// level), so it can't be redirected per-test via process.env -- this test
// exercises the exact record shape file_write now produces (kind: "file",
// a repo-relative key, REPO_ROOT as scope, prior content as payload)
// directly against a real snapshot store and a real temp target directory,
// rather than fighting that fixed REPO_ROOT to drive the restore through
// executeAutonomousStep itself.
test("a file_write snapshot's record shape round-trips through the real snapshot store", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-autonomous-loop-restore-"));
  const snapshotStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-autonomous-loop-snapshots-"));
  fs.writeFileSync(path.join(targetDir, "out.txt"), "new content", "utf8");
  try {
    const snapshotStore = createSnapshotStore({ dataDir: snapshotStoreDir });
    const recorded = snapshotStore.recordSnapshot({
      kind: "file",
      key: "out.txt",
      scope: targetDir,
      payload: "previous content",
      summary: "file_write overwrite",
    });

    await snapshotStore.restoreSnapshot(recorded.id);
    assert.equal(fs.readFileSync(path.join(targetDir, "out.txt"), "utf8"), "previous content");
    assert.equal(snapshotStore.getSnapshot(recorded.id), null);
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(snapshotStoreDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 7: Run the updated suite**

Run: `node --test node-bot/test/acp-autonomous-loop.test.js`
Expected: PASS, including the rewritten overwrite test and the new restore round-trip test.

- [ ] **Step 8: Commit**

```bash
git add node-bot/acp-autonomous-loop.js node-bot/test/acp-autonomous-loop.test.js
git commit -m "feat: pipeline B file_write records a restorable snapshot instead of a .bak file"
```

---

## Task 6: Wire a shared snapshot store into `server.js`

**Files:**
- Modify: `node-bot/server.js:493` (require + module-level store construction), `:494-...` (`createAcpMemoryStore` call), `:614` (`createSkillsStore` call), `:1904-1911` (`getEditorIntegrations`)

**Interfaces:**
- Consumes: `createSnapshotStore` from Task 1, `createAcpMemoryStore`/`createSkillsStore`/`createEditorIntegrations`'s new `snapshotStore` option from Tasks 2-4.
- Produces: one shared `snapshotStore` instance at module scope, threaded into all three factories, so `GET /editors/workspace/snapshots`-style listing has a single place to eventually list every kind, not three disconnected stores.

- [ ] **Step 1: Require `snapshot-store.js` and construct the shared instance**

In `node-bot/server.js`, find the memory-graph/memory-store setup (around `:491-494`):

```js
const memoryGraph = createMemoryGraph();

// ACP memory store (conversation/session memory)
const acpMemoryStore = createAcpMemoryStore({
```

Replace with:

```js
const memoryGraph = createMemoryGraph();

// #426 sub-project 1: one shared snapshot/rollback store, threaded into
// every subsystem below that owns undoable state (memory sessions/facts
// here, skills a bit further down, editor file-edits via
// getEditorIntegrations) -- one store means one place to eventually list
// "everything that's undoable right now", not three disconnected pools.
const snapshotStore = createSnapshotStore({});

// ACP memory store (conversation/session memory)
const acpMemoryStore = createAcpMemoryStore({
  snapshotStore,
```

- [ ] **Step 2: Add the require alongside the other top-level requires**

Find the existing `const { createAcpMemoryStore } = ...`-style require near the top of `node-bot/server.js` (grep for `createAcpMemoryStore` to find its require line) and add the new one immediately after it:

```js
const { createSnapshotStore } = require("./snapshot-store");
```

- [ ] **Step 3: Pass the shared store into `createSkillsStore`**

In `node-bot/server.js:614`, replace:

```js
const skillsStore = createSkillsStore({});
```

with:

```js
const skillsStore = createSkillsStore({ snapshotStore });
```

- [ ] **Step 4: Pass the shared store into `getEditorIntegrations`**

In `node-bot/server.js:1904-1911`, replace:

```js
  let editorIntegrations = deps.editors || null;
  const mobileMemoryStore = deps.mobileMemoryStore || createMobileMemoryStore();
  function getEditorIntegrations() {
    if (!editorIntegrations) {
      editorIntegrations = createEditorIntegrations();
    }
    return editorIntegrations;
  }
```

with:

```js
  let editorIntegrations = deps.editors || null;
  const mobileMemoryStore = deps.mobileMemoryStore || createMobileMemoryStore();
  function getEditorIntegrations() {
    if (!editorIntegrations) {
      editorIntegrations = createEditorIntegrations({ snapshotStore });
    }
    return editorIntegrations;
  }
```

- [ ] **Step 5: Run the full node-bot suite**

Run: `node --test node-bot/test/`
Expected: PASS across the whole suite -- this is the first point where all four kinds share one real store instance in the same process, the same way production will.

- [ ] **Step 6: Commit**

```bash
git add node-bot/server.js
git commit -m "feat: wire a shared snapshot store into acpMemoryStore, skillsStore, and editor integrations"
```

---

## Self-Review

**Spec coverage:**
- New `snapshot-store.js` with `{id, kind, key, scope, payload, summary, appliedAt}` shape, `registerRestorer`/`restoreSnapshot`/`listSnapshots(kind?)` — Task 1. ✓
- Built-in `"file"` restorer registered by the store itself — Task 1, Step 1. ✓
- `memory-session`/`memory-fact` restorers + the three session mutators + `rememberFact` — Task 3. ✓
- `skill` restorer + `updateSkill` — Task 4. ✓
- Per-kind retention (`MANA_MAX_EDIT_SNAPSHOTS` applied 4x) — Task 1, `pruneOldest(kind)`; tested in Task 1 Step 2. ✓
- Restore-preserves-on-failure — Task 1, `restoreSnapshot`; tested in Task 1 Step 2. ✓
- `recordSnapshot` best-effort at every mutator call site — Tasks 3, 4, 5 all wrap in `try/catch` + `console.warn`. ✓
- Deleting `edit-snapshot-store.js` + its test, migrating `zed-integration.js`'s three functions, REST routes/UI unaffected except the now-async restore route — Task 2. ✓
- No migration of existing on-disk #428 snapshots — Task 2 Step 1 deletes the old store outright; nothing reads its old files. ✓
- Wiring pipeline B's `file_write` — Task 5. ✓
- Testing section's five files (`snapshot-store.test.js`, `acp-memory-store.test.js`, `skills-store.test.js`, `zed-integration.test.js`, `acp-autonomous-loop.test.js`) — Tasks 1, 3, 4, 2, 5 respectively. ✓
- Explicitly out of scope (hook config, "ask" mode, PostToolUse, agent-triggered restore) — untouched by every task above; no task reads a hook config or adds an autonomous restore trigger. ✓

**Placeholder scan:** No TBD/TODO/"add appropriate error handling" — every step above shows the exact code to write, including full test bodies. No task defers to "similar to Task N" without repeating the actual code.

**Type/name consistency check:** `createSnapshotStore` (Task 1) is the name used consistently by every later task (2-6) — no task refers to it as `createGenericSnapshotStore` or similar. `recordSnapshot({kind, key, scope, payload, summary})` / `listSnapshots(kind?)` / `getSnapshot(id)` / `deleteSnapshot(id)` / `registerRestorer(kind, fn)` / `restoreSnapshot(id)` are the only six methods the store exposes, and every consuming task (2-5) calls only these six, with matching argument names (`kind`, `key`, `scope`, `payload`, `summary`) throughout. `snapshotStore` is the option name used consistently across `zed-integration.js` (already existed pre-migration), `acp-memory-store.js`, `skills-store.js`, and `executeAutonomousStep`'s `options.snapshotStore`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-24-generic-snapshot-rollback-store.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
