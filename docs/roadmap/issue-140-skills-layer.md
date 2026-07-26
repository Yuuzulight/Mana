# Issue 140: Procedural Skills Layer

## Goal

Give Mana somewhere to keep procedural knowledge -- "here's how I did X
successfully last time" -- separate from `background-memory-capability.js`'s
factual memory consolidation, so a solved task doesn't get solved from
scratch again next time.

## Why

Dream Mode already consolidates *facts* during idle time, but nothing turns
"here's how to fix a stuck TTS provider" into something Mana can cheaply
reach for later. [Hermes Agent's Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
does this with standalone `SKILL.md` files loaded in two levels -- a cheap
index (name/description only) always available, full content loaded only
when a skill is actually used -- plus an idle-gated curator that prunes
skills nobody's touched in a while.

## Status: Implemented

- **`node-bot/skills-store.js`**: each skill is a standalone `.md` file
  under `node-bot/skills/` with a small frontmatter block (name,
  description, category, created, lastUsed, status), parsed with a
  hand-rolled `key: value` parser rather than pulling in a YAML dependency
  for a format this flat. `listSkills()` returns the cheap index (no
  body); `viewSkill(name)` returns the full body and bumps `lastUsed`
  (un-staling the skill if it had gone stale); `createSkill(...)` is the
  write path; `pruneStaleSkills({staleDays, archiveDays})` is the
  deterministic, no-LLM prune pass.
- **`node-bot/capabilities/skills-capability.js`**: `GET /skills` (cheap
  index), `GET /skills/:name` (full content), `POST /skills` (create),
  `POST /skills/prune` (manual trigger, mirrors
  `/admin/background-memory/preview`'s role for the memory reviewer). Also
  wires `contributePromptContext` into the same generic hook FFXIV/stock
  market plugins use (issue #108) -- keyword-matches the message against
  skill names/descriptions and, if one looks relevant, injects that one
  skill's *full* body into the reply. No `category` field, so it's a core
  capability (always on, not a Settings > Plugins toggle), matching
  `presetsCapability`/`backgroundMemoryCapability`.
- **Idle-gated pruning**: `server.js`'s `triggerIdleConsolidation` (the
  same idle signal Dream Mode's compactor/reviewer/connections passes use,
  issue #69) now also calls `pruneStaleSkills` as a fourth, deterministic
  phase -- no model call, just frontmatter age checks. Configurable via
  `MANA_SKILL_STALE_DAYS` (default 30) / `MANA_SKILL_ARCHIVE_DAYS`
  (default 90), matching Hermes' own defaults.
- **Example skill**: `node-bot/skills/diagnosing-a-stuck-tts-provider.md`
  ships as a real, usable starting skill rather than a placeholder.

## Real bug found

`viewSkill` originally read the skill file from disk *before* calling
`touchSkillUsage` (which writes the bumped `lastUsed`/un-staled status),
then returned that stale pre-touch copy. Caught by a test asserting the
*returned* `lastUsed` matched the bump, not just the persisted file --
fixed by touching first, then reading.

## Deliberate simplifications

- **`contributePromptContext` never unconditionally contributes the
  index.** `contributePluginPromptContext` (registry.js) takes the first
  non-empty result across every capability in array order -- always
  returning the cheap index here would starve every other plugin's context
  on every single turn. Matching skills self-guard exactly like
  ffxiv-market/stock-market already do, just with a generic word-overlap
  heuristic instead of a hardcoded vocabulary, since skills are
  user-defined rather than a fixed domain.
- **No agent-autonomous skill writing.** `POST /skills` exists, but nothing
  calls it without a human (or Mana, with a human actually invoking it)
  deciding to. Full autonomous write-after-task-success, and the approval
  gate in front of it, are out of scope here -- see issue #152.
- **No LLM-assisted consolidation phase.** Hermes' curator has an optional
  (off-by-default) LLM pass that reviews and merges skills; only the
  deterministic stale/archive transitions are implemented here, matching
  what the issue's acceptance criteria actually require.
- **No skills marketplace/hub.** Purely local, per the issue's explicit
  scope.

## Verified

- `node-bot/test/skills-store.test.js` (8 tests): frontmatter round-trip,
  create/validate, cheap-index-has-no-body, view-touches-lastUsed and
  persists across store instances, stale/archive thresholds, using a stale
  skill un-stales it.
- `node-bot/test/skills-capability.test.js` (10 tests): all four routes,
  health reporting, `findMatchingSkill`'s name-phrase and word-overlap
  matching (including the negative case), and `contributePromptContext`
  returning the full body on match / `""` on no match.
- Full `node-bot` suite (52 files) run sequentially, one process per file:
  0 failures. `health-components.test.js` needed its hardcoded
  `Object.keys(body.components)` snapshot updated to include `"skills"` --
  expected, not a regression.
