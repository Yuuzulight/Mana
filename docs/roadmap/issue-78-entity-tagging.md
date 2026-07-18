# Issue 78: Lightweight Cross-Session Entity Tagging

## Goal

Let Mana's memory recall be aware of recurring people/topics across
sessions, not just full-text/summary blobs.

## Why

Mana's memory today is a flat per-session summary plus one joined
`BACKGROUND_MEMORY_BLOCK`, with no entity-level structure -- a follow-up
like "what did we say about X two weeks ago" has no targeted way to find it.

## Status: Implemented

- **`extractEntities(text)`** (`node-bot/acp-memory-store.js`): pure regex
  pattern matching, zero LLM calls. Matches runs of 1-3 Title Case words.
  Multi-word runs ("Acme Corp", "New York") are treated as real entities
  outright; single-word matches are checked against a short stopword list
  (`the`, `what`, `is`, ...) to cut down on ordinary sentence-initial
  capitalization noise.
- **`entity-index.json`** (alongside the existing `sessions/` directory in
  `data/acp-memory/`): a flat `entity (lowercased) -> [{sessionId, at,
  display}]` map, capped at the 100 most recent mentions per entity.
- **Wired into `appendTurn`**: every turn's combined user+assistant text is
  run through `extractEntities` and recorded before the summary/turns list
  update -- an independent side-effect, not touching the existing session
  file structure at all.
- **`lookupEntity(name)`** on the store's returned API: case-insensitive
  lookup returning every `{sessionId, at, display}` mention for a given
  name/topic, so a future prompt or tool can pull targeted cross-session
  history instead of only the generic `buildPromptMemory` blob.

### Deliberate simplifications

- `ponytail:` naive regex heuristic, not real NER -- upgrade to a proper
  extraction pass if the false-positive rate on real usage becomes a
  problem.
- `ponytail:` fixed 100-mention cap per entity (drops oldest), not
  age-based pruning -- revisit if a heavily-recurring entity needs smarter
  trimming.
- No new dependency: this is exactly the kind of thing the issue itself
  asked for ("pure pattern matching, zero LLM calls") and stdlib regex
  covers it completely.

### Verified

- `node-bot/test/acp-memory-store.test.js`: 6 new tests --
  `extractEntities` correctness (multi-word entities, stopword filtering,
  single-word proper nouns kept), cross-session retrieval (both session ids
  come back for a shared entity), case-insensitive lookup + empty result for
  an unmentioned entity, and persistence across separate store instances.
- Full suite (`node run_tests.js`): all files pass, no regressions --
  existing `buildPromptMemory`/session behavior is unchanged since the
  entity index is a fully separate file untouched by anything else.
