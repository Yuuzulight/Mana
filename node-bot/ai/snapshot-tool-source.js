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
