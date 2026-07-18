# Issue 77: Gap/Staleness Notes on Synthesized Research Answers

## Goal

When Mana synthesizes an answer from Deep Research sources, have it
explicitly note what's stale, missing, or conflicting -- not just cite what
it found.

## Why

`RESEARCH_SYSTEM_PROMPT` already told the model to "say so plainly" when
sources were insufficient or conflicting, folded into the main answer prose
-- not a distinct, reliably-present note. `runDeepResearch`'s `report` field
is free-form synthesized text, so this only needed a prompt change, not new
code.

## Status: Implemented

- `RESEARCH_SYSTEM_PROMPT` (`node-bot/tools/deep-research.js`) now
  explicitly instructs the model to check, before finishing, whether sources
  disagree, look outdated relative to each other, or leave an obvious gap --
  and if so, end the report with a line starting `Note:` naming the specific
  sources and the specific disagreement/gap. Clean, consistent sources get
  no note at all (no generic disclaimer).
- No code changes beyond the prompt string -- `report` stays a plain string,
  so no consumer (windows-launcher/desktop-client rendering, tests) needed
  updating.

### Real-model verification

A pure prompt change isn't something the automated suite can meaningfully
assert on (the existing `deep-research.test.js` suite already injects a fake
`synthesize` for exactly this reason -- LLM prompt quality isn't a CI-stable
check). Verified instead against the real local model
(`Qwen3-4B-Q4_K_M.gguf` via llama-server) with two synthetic source sets:

**Conflicting/stale sources** (a 2021 doc claiming v2.1 vs. a changelog
claiming v4.0 in 2024):

> The current version of the Widget API is 4.0, which was released in 2024
> and replaced the previous 2.x versions [2]. However, there is a
> discrepancy between the sources: [1] states that the Widget API is
> currently at version 2.1, released in 2021, while [2] indicates that
> version 4.0 was released in 2024, replacing the 2.x versions. **Note:
> There is a disagreement between sources [1] and [2] regarding the current
> version of the Widget API.**

**Clean, consistent sources** (two references agreeing on water's boiling
point):

> The boiling point of water at sea level is 100 degrees Celsius (212°F) at
> standard atmospheric pressure (1 atm) [1][2]. Both sources agree on this
> standard value for the boiling point of water at sea level.

No `Note:` line -- correct, since there was nothing to flag.

This satisfies both acceptance criteria directly: a real conflict produces a
real, specific note; a clean answer stays note-free.

### First attempt didn't work -- worth recording

The first prompt wording ("if sources are stale/conflicting, end with a Note
line") produced *no* note at all on the conflicting-sources test -- the
model just silently picked the newer-sounding source and answered normally.
Strengthening it into an explicit pre-finish checklist ("before you finish,
check: do any two sources disagree...") fixed it. Left as a reminder that
"ask the model to be honest about gaps" needs to be a directive check, not a
soft aside, or it gets skipped.

### Verified

- Full suite (`node run_tests.js`): all files pass, no regressions (existing
  tests inject a fake `synthesize`, so they don't depend on the prompt
  string's exact content).
- Real-model verification above.
