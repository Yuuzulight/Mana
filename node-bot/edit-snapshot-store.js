// Issue #428: restorable snapshots for applied editor-handoff edits,
// independent of git. zed-integration.js's approveEditProposal has always
// had proposal.originalContent sitting in memory right before the write
// that discards it -- this store persists it so an applied edit can be
// undone later, the same way Cursor auto-snapshots before each agent
// action. Deliberately generic, not editor-specific -- an applied edit's
// origin (which editor, if any, was open) doesn't matter to restoring it.
const fs = require("node:fs");
const path = require("node:path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Same atomic tmp+rename pattern acp-memory-store.js's writeJsonObject
// uses -- a crash mid-write must never leave a half-written, unreadable
// snapshot behind.
function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function createEditSnapshotStore(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.MANA_EDIT_SNAPSHOTS_DIR ||
    path.join(__dirname, "data", "edit-snapshots");
  const now = options.now || (() => new Date().toISOString());
  const idFactory =
    options.idFactory ||
    (() => `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  // A fixed-depth undo stack, not a date-based archive -- these are a
  // lightweight per-edit undo convenience, not an audit trail, so there's
  // no retention window worth preserving, only a cap on how many
  // (potentially large) originalContent copies accumulate on disk.
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

  // id ultimately comes from a REST route param (POST .../snapshots/:id/restore)
  // -- reject anything that would resolve outside dataDir (e.g. "../../etc/passwd")
  // or into a subdirectory, the same containment check toWorkspaceRelativePath
  // uses in zed-integration.js. getSnapshot/deleteSnapshot already treat a thrown
  // error here as "not found", so this needs no change at either call site.
  function snapshotPath(id) {
    const resolvedDir = path.resolve(dataDir);
    const resolved = path.resolve(resolvedDir, `${id}.json`);
    const relative = path.relative(resolvedDir, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
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

  // Metadata only (no originalContent) -- a list view doesn't need a
  // potentially-large file body, only getSnapshot() does, to actually
  // restore one entry. Newest first, same order a user expects from an
  // undo stack.
  function listSnapshots() {
    const records = listSnapshotFiles()
      .map((f) => {
        try {
          const record = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
          return {
            id: record.id,
            proposalId: record.proposalId,
            workspacePath: record.workspacePath,
            relativePath: record.relativePath,
            summary: record.summary,
            appliedAt: record.appliedAt,
          };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
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

  function pruneOldest() {
    const all = listSnapshots();
    if (all.length <= maxRetained) return;
    for (const record of all.slice(maxRetained)) {
      deleteSnapshot(record.id);
    }
  }

  function recordSnapshot({
    proposalId,
    workspacePath,
    relativePath,
    originalContent,
    summary,
  } = {}) {
    ensureDir(dataDir);
    const id = idFactory();
    const record = {
      id,
      proposalId: proposalId || null,
      workspacePath: workspacePath || null,
      relativePath,
      originalContent,
      summary: summary || "",
      appliedAt: now(),
    };
    writeJsonAtomic(snapshotPath(id), record);
    pruneOldest();
    return {
      id,
      proposalId: record.proposalId,
      workspacePath: record.workspacePath,
      relativePath,
      summary: record.summary,
      appliedAt: record.appliedAt,
    };
  }

  return { recordSnapshot, listSnapshots, getSnapshot, deleteSnapshot };
}

module.exports = { createEditSnapshotStore };
