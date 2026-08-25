# Agent-triggered snapshot restore (#475)

## Context

The generic snapshot/rollback store (`node-bot/snapshot-store.js`, #426
sub-project 1) exposes `restoreSnapshot(id)`, reachable today only through
explicit human action — the REST route
(`POST /editors/workspace/snapshots/:id/restore`) and both apps' "Applied
edits" UI panels. That design deliberately left `restoreSnapshot` open to
non-human callers but did not design for one — agent-triggered restore was
explicitly scoped out as a different risk profile with its own unanswered
questions, tracked as this issue.

This document is that design. It answers the four questions the original
spec left open (approval-gate integration, human-vs-agent authorship,
mid-task safety, audit trail) and adds one requirement neither spec
anticipated: a staleness check, closing a real data-loss gap that exists
in every restore path today, not just the new one this document adds.

## What's actually undoable, restated

`restoreSnapshot(id)` looks up a snapshot, calls the restorer registered
for its `kind`, and deletes the snapshot only after the restorer resolves
successfully. Four kinds exist: `"file"`, `"memory-session"`,
`"memory-fact"`, `"skill"`. Every one of them is fair game for this
feature — the store's whole design point is one generic mechanism across
all four, and there's no principled reason for an agent-restore tool to
special-case a subset of them.

## Design

### 1. New `node-bot/ai/snapshot-tool-source.js`

Mirrors `ai/skill-tool-source.js`'s exact shape — `{listToolSchemas(),
executeTool(qualifiedName, args), isKnownToolName(name)}` — since that's
the established pattern every tool source in Pipeline A already follows,
and the shape is pipeline-agnostic enough that Pipeline B's tool switch
can call the same `executeTool`/module functions directly (see Wiring
below) without needing its own reimplementation.

Two tools, always registered (matching `skill__create`/`skill__run`'s own
always-visible precedent — no runtime-data-gated conditional registration
exists anywhere else in this codebase, and `snapshot__list` returning an
empty array is already a complete, unambiguous "nothing to restore"
signal, so building a new dynamic-registration mechanism for a cosmetic
catalogue-size win isn't worth the new machinery):

```js
snapshot__list(kind?)   // wraps listSnapshots(kind) -- lets the model
                         // look before it picks, the same way a human
                         // picks off the REST route's list before restoring
snapshot__restore(id)   // wraps restoreSnapshot(id), gated (see below)
```

`snapshot__restore`'s tool description explicitly restricts *proposing* a
restore of a human-sourced snapshot (see `source` field, below) to only
when the user has explicitly asked to undo/revert/roll back a specific
action. Restoring the agent's own prior actions (`source: "agent"`) may be
proposed freely, proactively, without being asked first.

This restriction is **prompt-level guidance, not a code-level check** —
there is no way to mechanically verify "did the user actually ask for
this" from the tool call alone; that's a judgment the model makes from
conversation context, not data the system can independently confirm. The
approval gate (below) remains the actual, code-enforced safety boundary
regardless of why the model decided to call the tool. The distinction
being guided against is a UX/trust one, not an execution-safety one:
proactively offering to fix the agent's *own* mistake is self-correction;
proactively offering to undo something a *human* deliberately did is the
agent forming an unprompted opinion about that human's intent, which it
has no basis to do uninvited — even though both, if proposed, still
require the same explicit human approval before anything executes.

### 2. New `source` field on every snapshot record

`recordSnapshot`'s shape gains one field: `source: "human" | "agent"`,
populated at every existing call site (7 sites across 4 files —
`zed-integration.js`'s `approveEditProposal`; `acp-memory-store.js`'s
`renameSession`/`setSessionGoal`/`appendTurn` for `"memory-session"` and
`rememberFact` for `"memory-fact"`; `skills-store.js`'s `updateSkill`;
`acp-autonomous-loop.js`'s `file_write` overwrite path). Each call site
already knows unambiguously which flow it's in — `zed-integration.js`'s
`approveEditProposal` is always a human clicking approve in an editor UI
(`source: "human"`), `acp-autonomous-loop.js`'s `file_write` is always the
autonomous coding loop's own action (`source: "agent"`), and so on for
the rest — so this is a one-line, zero-uncertainty addition at each site,
not new design.

This field gates nothing at the code level (see Design 1's "prompt-level
guidance, not a code-level check" above) — it exists purely as data:
displayed to the human in the approval prompt ("this restores your own
manual edit" vs. "this restores one of my prior actions"), and as the
input a same-origin-restriction tool description can reference. Capturing
it now matters because it's point-in-time provenance — knowable only at
the moment of the write, not reconstructible afterward. A snapshot
recorded before this field existed simply has no `source`; nothing reads
this field as a hard requirement, so that's not a migration concern.

### 3. Staleness check, inside `restoreSnapshot()` itself

**This is a fix to an existing gap, not new-feature-only scope.**
`restoreSnapshot` today has no way to know whether a snapshot's target
(`key`+`scope`) has been legitimately written to again since the snapshot
was recorded — restoring silently overwrites whatever's there now with
the snapshot's old `payload`, with no warning. This blind spot already
exists for every current caller (the REST route, both apps' "Applied
edits" UI panels), not just the new agent tool being designed here; an
agent proposing a stale restore is not a new category of risk, it's the
same existing risk with a new way to trigger it.

Fix: before restoring, `restoreSnapshot` compares the target's actual
current live state against what it should be immediately after the
snapshot's own recorded state (i.e., detects whether something else has
written to the same `key`+`scope` since `appliedAt`). On a mismatch, it
does **not** silently proceed — it returns a `stale: true` signal (with
enough detail for a caller to show what would be clobbered) instead of
restoring outright. This is a warning-and-override, not a hard block: a
caller that receives `stale: true` re-invokes with an explicit
confirm-anyway flag to proceed. The exact staleness-detection mechanism
(the natural approach: compare current content against the snapshot's own
recorded payload, or check whether a newer snapshot exists for the same
`key`+`scope`) is an implementation detail for the plan to work out
against the real kind-by-kind restorer shapes — the requirement fixed
here is the behavior contract (warn instead of silently overwrite), not a
specific comparison algorithm.

Putting this in `restoreSnapshot()` itself — not only in the new
agent-tool code path — means every caller gets the same protection at
once: the existing REST route and both UI panels, which have carried this
exact risk unfixed since #428, plus the new agent tool. One
implementation, one thing to test, instead of duplicating (or forgetting
to duplicate) the check into a second code path.

The staleness warning surfaces through the same approval/confirmation
step each caller already has — for the REST route and UI panels, that's
whatever confirmation UI they already show before calling restore; for
the two new tool-calling paths below, it's folded into the existing
approval-gate/pending-request prompt.

### 4. Wiring: both pipelines

**Pipeline A** (`server.js`'s voice-companion tool loop): register
`snapshot-tool-source.js` in the `toolSources` array passed to
`buildToolPolicy` (`server.js:4519`, the same wiring point every other
tool source uses), and register a new `"snapshot-restore"` actionType via
`approvalGate.registerExecutor` — `snapshot__restore`'s `executeTool`
implementation calls `approvalGate.requestApproval("snapshot-restore",
{summary, payload, scanText})` exactly as `skill__create` does for
`"skill-write"` (`ai/skill-tool-source.js:187-206`), never auto-decided,
never added to any always-allow list (this is explicitly a reversal
action, not a routine write). If `restoreSnapshot` returns `stale: true`,
the approval summary includes that warning; approving proceeds with the
confirm-anyway call.

**Pipeline B** (`acp-autonomous-loop.js`'s autonomous coding loop): add a
`snapshot_restore` case to the tool switch, following `file_write`'s
existing approval shape exactly (`acp-autonomous-loop.js:559-611`) —
`createPendingRequest`/`waitForApprovalResult`/`archivePendingRequest`,
gated the same way `file_write` is (an env-var-controlled
require-approval flag). This reuses Pipeline B's own established
approval primitives rather than introducing `approval-gate.js` into a
pipeline that doesn't otherwise know about it — Pipeline B was
deliberately kept structurally separate from Pipeline A (its own
tool-call format, its own session/tool-cap tracking), and importing a
second gating mechanism into it would be a larger, unrelated change than
this feature needs. `snapshot__list`/`snapshot__restore`'s core logic
(the `ai/snapshot-tool-source.js` module) stays identical between both
wirings — only the approval adapter differs.

Both pipelines see the same, unscoped, global store — `snapshot__list`
has no session/pipeline filter beyond the existing optional `kind`
parameter, matching `listSnapshots`'s current signature exactly. Adding
scoping would mean a new session/pipeline identifier on every snapshot
record and filtering logic nothing else in the store does today, for a
boundary the human-approval step already provides in practice (a human
reviewing a specific proposed restore sees exactly what it targets,
regardless of which pipeline proposed it). One unified "everything Mana
can currently undo" view is the intended shape here, not per-pipeline
silos.

### 5. Audit trail

No new mechanism needed. Both pipelines already log every tool call —
Pipeline A via `wrapWithToolCallLog` (`tool-call-log.js:158-174`,
`{at, name, args, ok, error, durationMs}`), Pipeline B via its own
existing result-logging around the tool switch. Building
`snapshot__restore` as a plain tool call means this is a free side effect
of the design above, not something to build separately.

### 6. Concurrent-task safety

Explicitly still out of scope, and explicitly *not* the same gap the
staleness check (Design 3) closes. The staleness check catches "this
target has been written to again since the snapshot" — a fact about the
*data*. It does not catch "restoring this mid-task contradicts an
assumption a different, concurrently-running part of the same task
already made" — a fact about *task state* the snapshot store has no model
of at all (no task/turn boundaries exist anywhere in this design). Treat
a restore as an atomic, immediately-visible action once approved, the
same way `file_write` already is; the staleness check is real protection
against silent data loss, not a solution to task-level coordination,
which remains genuinely unanswered and is not addressed by anything in
this document.

## Testing

- `ai/snapshot-tool-source.js`: unit tests for `listToolSchemas`,
  `executeTool` (both tools, including the `stale: true` response path),
  `isKnownToolName` — mirroring `ai/skill-tool-source.js`'s existing test
  conventions.
- `snapshot-store.js`'s `restoreSnapshot`: new tests for the staleness
  check itself — a restore against an unmodified target succeeds
  normally; a restore against a target that's been written to since
  `appliedAt` returns `stale: true` instead of overwriting; a
  confirm-anyway re-invocation proceeds despite staleness. Verify this
  new behavior doesn't change `restoreSnapshot`'s existing return shape
  for the non-stale case (backward compatible with every existing
  caller).
- Pipeline A wiring: a test confirming `snapshot__restore` routes through
  `approvalGate.requestApproval("snapshot-restore", ...)`, never
  auto-approved, never addable to the always-allow list (or if it can be
  added, that this is a deliberate, tested choice — not accidental).
- Pipeline B wiring: a test confirming `snapshot_restore` follows the same
  pending-request/approval shape as the existing `file_write` tests
  (`acp-autonomous-loop.test.js`'s existing conventions for that tool).
- `source` field: a test confirming each of the 7 existing `recordSnapshot`
  call sites populates the correct value (`"human"` for
  `zed-integration.js`'s `approveEditProposal`, `"agent"` for
  `acp-autonomous-loop.js`'s `file_write`, etc.).

## Explicitly out of scope here

- **Concurrent/mid-task safety** (Design 6) — a real, still-open question,
  deliberately not solved by this document. Worth its own issue if it
  ever becomes a practical problem.
- **Cross-pipeline session scoping** — deliberately not built; see Design
  4's reasoning for the unscoped-global-view decision.
- Any change to the four kinds' actual restorer implementations
  (`"file"`/`"memory-session"`/`"memory-fact"`/`"skill"`) beyond adding
  the staleness check's comparison logic and the `source` field to their
  `recordSnapshot` calls.
- Any UI change to surface the `source` field or staleness warnings in
  the existing REST-route-driven "Applied edits" panels — those panels
  gain the *protection* (staleness checks now run underneath them
  automatically, since it's in `restoreSnapshot` itself) without this
  document specifying any UI work to *display* the new warning there.
  That's a reasonable, minimal follow-up, not required for this feature's
  own correctness.
