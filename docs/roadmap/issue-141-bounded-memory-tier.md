# Issue 141: Bounded Memory Tier

## Goal

Confirm Mana's cross-session recall keeps the always-injected context
bounded rather than growing with total memory volume, and give her a
two-tier split: a small, hard-capped set of always-in-context facts, plus a
larger on-demand archive that's only pulled in when actually relevant.

## Status: Implemented

- **Tier 1 -- always injected, hard-capped**: two independent blocks, both
  already token/char-bounded before this issue:
  - `acp-memory-store.js`'s `buildPromptMemory(sessionId)` -- the current
    session's own summary + last few turns, capped by `maxPromptTokens`
    (default ~500 tokens / `maxPromptChars=2000`).
  - `server.js`'s `BACKGROUND_MEMORY_BLOCK` -- a cross-session digest built
    from every session's stored summary, capped by
    `MANA_BACKGROUND_MEMORY_MAX_CHARS` (default 2000 chars) regardless of
    how many sessions exist.
- **Tier 2 -- on-demand, not always injected**: `acp-memory-store.js`'s
  `getRelatedFacts(text, options)`. Extracts entities from the current
  message (reusing the existing `extractEntities`/entity-index machinery
  from issue #78), looks up which *other* sessions mentioned them, and
  returns a small bounded block -- capped independently by
  `MANA_RELATED_FACTS_MAX_ENTITIES` (default 3) and
  `MANA_RELATED_FACTS_MAX_CHARS` (default 300 chars). Empty string (no
  prompt cost at all) when the message doesn't name anything previously
  discussed elsewhere.
- Both tiers are visible in the system prompt as distinctly labeled blocks
  (`Conversation memory:`, `[BACKGROUND MEMORY]`, `Related from other
  sessions:`), so which facts are "always known" vs. "recalled just now"
  is legible from the prompt itself rather than needing separate tooling.

## Real bug found

`server.js` built `memoryBlock` (Tier 1's per-session summary) every turn
but never actually appended it anywhere -- `finalPrompt` was only
`retrievedText + prompt`, and `selectedSystemPrompt` never referenced
`memoryBlock`. Session-level conversational memory was computed and then
silently discarded on every single reply. Fixed by appending it to
`selectedSystemPrompt` right after it's built, same pattern already used
for `BACKGROUND_MEMORY_BLOCK`.

## Deliberate simplifications

- **No FTS5 / real full-text search.** The issue's framing referenced an
  "existing FTS5 cross-session recall" that, on audit, didn't actually
  exist anywhere in the codebase -- the only cross-session search-adjacent
  structure was the entity index, which was written to (`appendTurn`) but
  never read from for recall. Wiring that existing index into the reply
  path is the deterministic, dependency-free fix; a real FTS5 index is a
  much bigger addition that nothing here currently needs.
- **Entity-name lookup, not semantic search.** `getRelatedFacts` matches on
  the same Title-Case entity extraction issue #78 already built, not
  embeddings or fuzzy matching -- consistent with this codebase's
  "deterministic before ML" bias (skills pruning, issue #140).

## Verified

- `node-bot/test/acp-memory-store.test.js` (20 tests, 4 new): related
  facts surfaced across sessions, excluded for the current session, empty
  for unknown/no entities, and bounded by `maxChars` regardless of match
  count.
- Full regression pass across every test file that touches
  `acpMemoryStore`, run one file at a time: `server-routes.test.js` (59),
  `mana-acp-agent.test.js` (17), `sessions-capability.test.js` (6),
  `deep-research-capability.test.js` (14). 0 failures.
