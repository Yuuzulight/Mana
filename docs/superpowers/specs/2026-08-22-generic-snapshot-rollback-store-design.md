# Generic snapshot/rollback store (#426 sub-project 1)

## Context

Issue #426 asks for user-configurable PreToolUse/PostToolUse-style
hooks (Claude Code's own hooks are the cited prior art, not the
`docs/roadmap/oss-inspiration-survey-2026-08.md` file the issue names —
that file does not exist in this repo; only a `-07.md` version exists,
with no mention of hooks). Scoping it surfaced four separable pieces:

1. A generic snapshot/rollback store (this document).
2. PreToolUse hooks: config, matching, `command`/`rule` kinds, allow/deny.
3. "Ask" mode, wired into both existing approval mechanisms.
4. PostToolUse hooks: config, `command` kind, rollback wiring (built on 1 and 2).

This document covers only (1). It has no dependency on hooks existing
at all — it's valuable on its own, because pipeline B's `file_write`
tool has zero rollback today, and #428's already-shipped
`edit-snapshot-store.js` is a narrower, single-purpose version of the
same mechanism this generalizes.

## Two tool-calling pipelines, restated

- **Pipeline A** (`server.js`): the voice-companion tool loop (skills,
  memory, vision, coding-proposal, etc.), gated per-action by
  `approval-gate.js`.
- **Pipeline B** (`acp-autonomous-loop.js`): the autonomous coding loop
  (`file_write`/`file_read`/`dir_scan`/`run_tests`), with its own
  separate file-based pending-approval mechanism.

Both will eventually consume this store; neither is blocked on the
other.

## What's actually undoable

Investigated every tool source before deciding scope. Only state Mana
itself writes to its own storage can be rolled back:

| Target | Storage shape | Read-before-write moment |
|---|---|---|
| File writes (pipeline A's editor-approve flow, pipeline B's `file_write`) | one file on disk | `fs.readFileSync` immediately before `fs.writeFileSync` |
| Memory session records (`acp-memory-store.js`) | one JSON file per session (`sessionsDir/<id>.json`) | every mutator (`setSessionGoal`, `appendTurn`, `renameSession`, ...) calls `getSession` then `saveSession` |
| Memory facts (`acp-memory-store.js`'s `rememberFact`) | one shared array file (`facts.json`), in-place upsert | `rememberFact`'s own `existing = facts.find(...)` before `saveFacts` |
| Skill definitions (`skills-store.js`) | one `.md` file per skill | every mutator calls `readSkill` then `fs.writeFileSync` |

Explicitly **not** in scope, permanently, regardless of future work:
browser automation (real-world side effects already happened), MCP
tool calls (opaque passthrough, no idea what they did), a skill's
*runtime* effects (only its stored definition is undoable), vision/
expression (nothing persisted).

"Session goal" (issue #401, still open, whose own description is stale
relative to this repo — the feature is fully shipped) is **not** a
separate storage shape. `goal` is one field inside the session record
above; restoring a session record restores its goal along with
everything else in it. No dedicated goal restorer exists or is needed.

## Design

### 1. `node-bot/snapshot-store.js` — new, replaces `edit-snapshot-store.js`

Same on-disk shape and atomic tmp+rename write discipline as #428's
store, generalized:

```js
{
  id,            // snap-<timestamp>-<random>
  kind,          // "file" | "memory-session" | "memory-fact" | "skill"
  key,           // kind-scoped identifier (see below)
  scope,         // optional kind-scoped grouping key, or null
  payload,       // kind-scoped prior-state blob
  summary,
  appliedAt,
}
```

`key`'s meaning is kind-scoped: a workspace-relative file path for
`"file"`, a session id for `"memory-session"`, a fact key for
`"memory-fact"`, a skill file name for `"skill"`. `scope` exists so a
kind's own listing/filtering logic can group or restrict snapshots
without reading `payload` — `"file"` is the only kind that uses it
today (the absolute workspace/repo root the relative `key` is against;
see below), everything else leaves it `null`. Metadata listing
(`listSnapshots`) includes `key` and `scope` but never `payload`
(mirrors #428 — a list view doesn't need a potentially-large body).

This split matters: an earlier draft of this design made `key` the
*absolute* file path (self-contained, no `scope` needed) and moved
`workspacePath` inside `payload` instead. That silently broke #428's
existing cross-workspace filtering — the security fix where restoring
a snapshot from a since-abandoned workspace must not overwrite an
unrelated same-named file in whatever workspace is active *now* — because
`listSnapshots()` deliberately excludes `payload`, so a workspace check
living only there is invisible to the exact code path meant to enforce
it. `scope` fixes this by keeping the workspace/root identifier at the
metadata level, alongside `key`, exactly where #428's `workspacePath`
field already lived before this generalization.

New API surface beyond #428's store:

```js
registerRestorer(kind, async (key, payload, scope) => { ... })
restoreSnapshot(id)   // looks up the snapshot, calls the registered
                       // restorer for its kind, deletes the snapshot
                       // only after the restorer resolves successfully,
                       // then returns the restorer's result
listSnapshots(kind?)  // optional kind filter -- omit for all kinds
```

This mirrors `approval-gate.js`'s existing `registerExecutor(actionType, fn)`
idiom on purpose — the store doesn't know how to write a file vs. a
memory record any more than `approval-gate.js` knows how to perform the
action it's gating. `restoreSnapshot` throws `"no restorer registered
for kind: <kind>"` if nothing has registered for that snapshot's kind
yet (e.g. the process restarted with a different registration set) --
fails loud, not silently. `"file"` is a built-in, registered by
`snapshot-store.js` on itself (see below); the other three each
register once from their owning factory function
(`createAcpMemoryStore` registers both `"memory-session"` and
`"memory-fact"`; `createSkillsStore` registers `"skill"`) against
whichever store instance they're constructed with, the same way
`approval-gate.js`'s executors are registered once at construction
rather than lazily -- a snapshot store instance missing an expected
restorer is a wiring bug, not a valid runtime state.

If a registered restorer throws, `restoreSnapshot` does **not** delete
the snapshot -- deletion only happens after the restorer's promise
resolves. A transient failure (a briefly-locked file, a momentary
permission error) leaves the snapshot exactly as it was, so calling
`restoreSnapshot(id)` again is a valid retry, not a lost undo.

`listSnapshots` takes an optional `kind` argument. Every real caller
only ever wants its own kind (`zed-integration.js` wants `"file"`,
`acp-memory-store.js` wants `"memory-session"`/`"memory-fact"`,
`skills-store.js` wants `"skill"`) -- filtering in the store means no
caller needs to know or care that the other three kinds exist.

`recordSnapshot` is best-effort: if it fails (disk full, a permission
error), the caller logs a warning and proceeds with the primary write
anyway. The snapshot is safety infrastructure for the write the user
actually asked for, not a precondition for it -- refusing to save a
file, session record, fact, or skill because an unrelated bookkeeping
write failed would be a worse outcome than just proceeding without an
undo option for that one write.

Retention (`maxRetained`, env `MANA_MAX_EDIT_SNAPSHOTS` — **kept as
the same env var name**, since it's not part of any public API and
renaming it buys nothing) prunes oldest-first **per kind**, not across
one shared pool -- each of the four kinds gets its own independent
budget, using the same `maxRetained` value applied four times rather
than one combined cap. This is a deliberate change from #428's literal
semantics, not a carryover: #428 only ever had one kind, so "prune
oldest across everything" and "prune oldest per kind" were the same
policy there. With four kinds of wildly different write frequency
(`memory-session` snapshots on every mutator call vs. rare `file`
writes), a single shared pool lets high-frequency, low-stakes churn
evict the rare, high-stakes snapshot a user actually wanted -- a
correctness risk for an undo store, not just a tuning nicety. Per-kind
pools cost nothing extra to configure (still one number, just keyed by
kind internally) and fully remove the starvation risk.

### 2. Four restorer registrations

**`file`** — needs zero pipeline-specific knowledge (just `fs`/`path`),
so `snapshot-store.js` registers it on itself internally, as a
built-in, rather than leaving it to whichever of the two pipeline
modules happened to load first. Neither `zed-integration.js` nor
`acp-autonomous-loop.js` registers a `"file"` restorer themselves --
doing so from both would be a double-registration bug, and the
"generic store already knows how to restore a file" is exactly what
makes this kind reusable across both pipelines without either owning
it:

```js
snapshotStore.registerRestorer("file", async (relativePath, content, rootDir) => {
  const fullPath = path.resolve(rootDir, relativePath);
  fs.writeFileSync(fullPath, content, "utf8");
  const written = fs.readFileSync(fullPath, "utf8");
  if (written !== content) throw new Error("restore failed verification");
  return { restoredPath: fullPath };
});
```

`key` is the workspace-relative path (unchanged from #428's
`relativePath` field) and `scope` is the absolute workspace/repo root
it's relative to — `path.resolve(workspace.path)` for pipeline A,
`REPO_ROOT` for pipeline B. Both pipelines already have exactly this
"root directory" concept today, so this restorer is genuinely shared,
not pipeline-specific. #428's existing cross-workspace-mismatch check
(`record.scope !== path.resolve(workspace.path)`, called from
`zed-integration.js`'s `listEditSnapshots`/`restoreEditSnapshot`
*before* calling into the generic store) is unchanged behavior, just
renamed from `workspacePath` to `scope`.

**`memory-session`** — registered in `acp-memory-store.js`:

```js
snapshotStore.registerRestorer("memory-session", async (sessionId, session) => {
  saveSession(session);
  return { sessionId };
});
```

Snapshotted by a new internal helper called from the same handful of
mutators that already do `getSession` → change → `saveSession`
(`setSessionGoal`, `appendTurn`, `renameSession`) — one `recordSnapshot`
call inserted at the existing read point, no new read added.

**`memory-fact`** — registered in `acp-memory-store.js`, separately
from sessions because the storage shape is genuinely different (one
shared array, not one file per record):

```js
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
```

`rememberFact` snapshots `existing || null` (its own
`find`-before-mutate result) right before calling `saveFacts` — the
`null` case is what makes restoring a *newly-created* fact correctly
delete it rather than erroring or leaving a stale entry.

**`skill`** — registered in `skills-store.js`:

```js
snapshotStore.registerRestorer("skill", async (fileName, fileContent) => {
  fs.writeFileSync(path.join(skillsDir, fileName), fileContent, "utf8");
  return { fileName };
});
```

Snapshotted from `updateSkill`'s existing `readSkill` call, serialized
back to its raw file-content form (`serializeSkillFile`) before
storing as `payload` — restoring writes that raw content straight
back, without re-parsing. `createSkill` doesn't snapshot (nothing
existed before it; deleting a wrongly-created skill is a separate,
existing `pruneStaleSkills`-adjacent concern, not a "restore" in this
store's sense). `skills-store.js`'s writes stay plain `writeFileSync`
(non-atomic) — that's a pre-existing, unrelated property of that
store, not something this work fixes.

### 3. Migrating #428 onto the new store

- Delete `node-bot/edit-snapshot-store.js` and
  `node-bot/test/edit-snapshot-store.test.js`.
- `zed-integration.js`'s `approveEditProposal`/`listEditSnapshots`/
  `restoreEditSnapshot` call the generic store with `kind: "file"`,
  `key: target.relativePath`, `scope: path.resolve(workspace.path)`
  instead of the dedicated store's `recordSnapshot`/`listSnapshots`/
  `getSnapshot`/`deleteSnapshot`. The workspace-mismatch check moves
  from comparing a bespoke `workspacePath` field to comparing `scope`
  — same check, same place in the call flow, renamed field.
- REST routes (`GET /editors/workspace/snapshots`,
  `POST /editors/workspace/snapshots/:id/restore`) and both apps'
  "Applied edits" UI panels are unaffected — they only ever talked to
  `zed-integration.js`'s functions, never to the store directly.
- Existing `zed-integration.test.js` snapshot tests are updated to
  construct `createEditorIntegrations` with a `snapshotStore` (the new
  module) instead of a `snapshotsDir` pointing at the old one; test
  intent and assertions stay the same.
- **No migration of existing on-disk #428 snapshots.** The new store
  never reads the old store's file/format; anything sitting in it at
  deploy time becomes immediately inaccessible, not gradually aged out.
  Deliberate, not an oversight: these are short-lived working snapshots
  for "undo my last edit," already bounded to a small rolling window by
  `maxRetained` -- writing and testing a one-time migration script for
  state this transient and low-value to preserve isn't worth it.

### 4. Wiring pipeline B's `file_write`

`acp-autonomous-loop.js`'s existing `.bak.<Date.now()>` copy (the only
backup mechanism it has today, write-only, nothing ever reads it back)
is replaced with a `recordSnapshot({kind: "file", key:
path.relative(REPO_ROOT, resolvedPath), scope: REPO_ROOT, payload:
priorContent, summary})` call at the same point, using the
already-registered `"file"` restorer. This is the one concrete,
immediately-visible win of this sub-project on its own: pipeline B
gains real, working rollback where today it silently accumulates
unreadable backup files forever.

## Testing

- `snapshot-store.test.js` (new): record/get/list/delete/prune (mirrors
  #428's existing coverage), plus `registerRestorer`/`restoreSnapshot`
  round-trips per kind, plus "no restorer registered" failing loud.
  Also: pruning stays scoped to one kind (filling one kind's pool past
  `maxRetained` never evicts another kind's snapshots), a throwing
  restorer leaves its snapshot in place for a retry rather than
  deleting it, and `listSnapshots(kind)` only returns that kind's
  entries while `listSnapshots()` returns all of them.
- `acp-memory-store.test.js`: new cases for session-record and fact
  snapshot+restore, including the fact-didn't-exist-before → restore
  deletes it case specifically (the one genuinely tricky branch).
- `skills-store.test.js`: snapshot+restore round-trip for `updateSkill`.
- `zed-integration.test.js`: existing snapshot tests updated in place
  to the new store; no behavioral test should need to change its
  assertions, only its setup.
- `acp-autonomous-loop.test.js`: `file_write` overwrite now records a
  restorable snapshot instead of an unreadable `.bak` file; add a test
  that actually restores one and confirms the file content round-trips.

## Explicitly out of scope here

Sub-projects 2-4 (hook config/matching, "ask" mode, PostToolUse
wiring) — this store is a dependency for (4)'s rollback action, not
part of this document. Nothing in this sub-project reads a hook config
or executes a user-provided command.

**Agent-triggered restore.** `restoreSnapshot` is reachable in this
design only through the existing human-driven paths -- the REST routes
and both apps' "Applied edits" UI panels. This spec deliberately does
not restrict it to human-only callers, but also deliberately does not
design for an agent calling it autonomously mid-conversation (e.g. an
"undo that" voice command, or an agent deciding on its own that a prior
action was wrong) -- that's a different risk profile with its own
unanswered questions (does it need its own approval gate? can an agent
undo something a human did? what if it fires mid-task against
assumptions another part of the same task already made?) that the four
"what's undoable" targets above never considered from that angle.
Tracked separately as #475, blocked on this sub-project shipping first.
