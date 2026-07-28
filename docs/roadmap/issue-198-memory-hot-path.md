# Issue 198: Explicit Hot-Path Memory Tool + Update Policies

## Goal

Mana's memory today is entirely automatic/implicit: `acp-memory-store.js`'s
`getRelatedFacts()` is injected into replies automatically, and idle-triggered
consolidation ("Dream Mode") runs as a background pass. There was no path
for Mana to explicitly decide mid-conversation "this is worth remembering
specifically" or "that's no longer true, forget it" -- facts only ever got
in through the passive consolidation pass, which only ever inserted, never
updated or removed anything.

## Status: Implemented (`ai/memory-tool-source.js`, `acp-memory-store.js`, always available when tool-calling is enabled)

## What Mana's memory model actually is (verified before designing)

`acp-memory-store.js`'s existing "facts" aren't structured assertions --
`entity-index.json` just tracks *mentions* (who/what was mentioned, where,
when), via `recordEntityMentions()`, which always appends and never
patches or removes. There was no existing concept of a discrete, assertable
fact with a lifecycle. Rather than force a "patch/remove" policy onto
mention records (which don't represent claims that can be contradicted --
a mention is just an occurrence, not an assertion), this adds a genuinely
new, parallel concept: **explicit facts**, stored separately
(`data/acp-memory/facts.json`, `{facts: [...]}`), each with a real
`status: "active" | "stale"` lifecycle. The passive entity-mention index is
untouched.

## Design

- **`acp-memory-store.js`'s `rememberFact({sessionId, key, text, action})`**
  -- the actual update-policy implementation:
  - `action: "insert"` (default): always creates a new active fact.
  - `action: "patch"`: updates the existing active fact with the same
    `key` (case-insensitive) if one exists; **falls back to insert** if
    nothing exists yet to patch, so "patch" is always a safe verb to call
    without checking existence first.
  - `action: "remove"`: marks the existing active fact with that `key` as
    `stale` (soft delete, not a hard delete -- matches this store's
    general append-safe philosophy elsewhere, e.g. capped-not-pruned
    entity mentions). A no-op (`found: false`) if nothing with that key
    exists.
- **`getRelatedFacts()` extended, not replaced** -- active facts whose
  `key` appears as a direct substring of the current message are surfaced
  under a new `Remembered:` block, alongside the existing
  `Related from other sessions:` entity-mention block (both can appear
  together). Zero new call sites in `server.js` -- this reuses the exact
  injection point issue #141 already wired in.
- **`ai/memory-tool-source.js`'s `remember` tool** -- a new
  `memory__remember` tool-calling schema (`{key, text?, action?}`), same
  merge shape #169 (`buildToolPolicyWithMcp`) and #188
  (`buildToolPolicyWithBrowserAutomation`) already established:
  `buildToolPolicyWithMemory(basePolicy, memoryToolSource)` combines a base
  `{tools, isKnownTool, executeTool}` policy with this source's tool into
  the same shape. Wired into `server.js`'s `replyMaybeWithTools` merge
  chain, built fresh per reply (bound to that reply's real `sessionId`,
  never a model-supplied one -- same "server-managed context" principle
  browser-automation's tool source already follows for its session)
  alongside the MCP and browser-automation merges, and covered by the
  same `wrapWithToolCallLog` audit wrapper (#188) automatically since it's
  applied last, after every source is merged in.

## Deliberate simplifications

- **No approval-gate for the `remember` tool itself.** Browser-automation's
  tool source gates its first tool-calling use because it's genuinely
  invasive (reaches other sites/machines); writing a local memory fact
  carries the same risk level as the existing automatic idle-consolidation
  pass, which was never gated either, and matches `read_file`'s own
  ungated pattern -- not every tool needs the same trust ceremony.
- **Exact key-substring matching, not fuzzy/semantic matching.** A fact
  only surfaces when its `key` appears verbatim (case-insensitive) in the
  current message. A more specific key (e.g. "Acme Corp Q2 numbers") won't
  surface for a more general mention ("what's up with Acme Corp"). This is
  a real, known limitation -- upgrading to fuzzy/entity-based matching is
  real future work if it turns out to matter in practice, not attempted
  here to keep the initial implementation predictable and easy to reason
  about.
- **No new UI for browsing/editing remembered facts.** The tool and the
  store function exist; a Settings panel to view/edit facts directly is
  separate, real UI work not attempted here.

## Out of scope

Taking `langmem` itself as a dependency (Python) or adopting its storage
backend -- this borrows the hot-path/background-manager conceptual split
and update-policy idea, reimplemented against Mana's existing
`acp-memory-store.js`.

## Verified

- `node-bot/test/acp-memory-store.test.js` (+8 tests): `rememberFact`
  validation, insert, patch (including patch-falls-back-to-insert), remove
  (including remove-of-unknown-key), and `getRelatedFacts` surfacing
  remembered facts alone and alongside entity mentions.
- `node-bot/test/memory-tool-source.test.js` (7 tests, new): tool schema
  shape, name-prefix detection, arg forwarding with the bound sessionId,
  unknown-tool rejection, error propagation from the store, and the full
  merge-into-a-base-policy behavior.
- Full `node-bot` suite (one process per file): no regressions.
