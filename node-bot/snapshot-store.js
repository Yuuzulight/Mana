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
