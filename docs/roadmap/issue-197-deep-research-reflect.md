# Issue 197: Reflect-on-Gaps Step for Deep Research

## Goal

`tools/deep-research.js`'s `runDeepResearch()` was single-pass: generate sub-queries,
search, read, synthesize once. An existing prompt instruction already asked
the model to flag an "obvious gap the sources don't cover" as a trailing
"Note:" line in the report, but nothing acted on that flag -- it was a note
in the output text, never a trigger for another round. Add an explicit
reflect step, inspired by `langchain-ai/local-deep-researcher`'s
search-summarize-reflect-repeat loop, bounded so it can't run away.

## Status: Implemented (`tools/deep-research.js`, opt-in via `options.reflect`)

## Design

- **`options.reflect: (prompt) => Promise<string>`**, optional -- same
  injection pattern as the existing `options.decompose`. Never runs unless
  the caller supplies it (server.js wires a real one by default, same as
  `decompose`/`synthesize`, using a new `REFLECT_SYSTEM_PROMPT` and, by
  default, the same "quality" model profile as `synthesize`/`compress` to
  avoid a mid-research model swap -- issue #269 later added an opt-in flag
  that lets `decompose`/`reflect` use a different profile instead; see
  `docs/roadmap/issue-269-deep-research-subtask-profiles.md` for why that's
  off by default).
- After the initial report synthesizes, `buildReflectPrompt(question,
  report)` asks the model for a structured decision: reply with exactly
  one search query that would close a genuine gap, or reply `"NONE"` if
  the report is already sufficient. `parseReflectDecision()` treats
  anything malformed (empty, over-long, multi-line commentary) the same as
  "no gap" -- a garbage response degrades to "stop", never risks running a
  garbage search.
- If a gap query comes back, one more search-and-read cycle runs for just
  that query, folding the new source(s) into the existing pool (continuing
  citation numbering, not restarting) rather than re-running the whole
  research pass. The report is then re-synthesized from the combined
  source set. Repeats up to `maxReflectCycles` (default 1, hard cap 2) --
  small and capped on purpose, per the issue's own scope, so this closes
  one genuine named gap rather than becoming an open-ended loop.
- **Search+read logic extracted into a reusable closure** (`searchAndRead`)
  so the initial pass and each reflect cycle share the exact same
  search/dedupe/per-domain-cap/concurrent-read code path, rather than
  duplicating it. The per-domain cap (`maxPerDomain`) and URL-dedup set
  are shared across cycles by design -- a reflect cycle isn't exempt from
  the same source-diversity bound the initial pass has.
- **Each source is tagged with which cycle found it** (`cycle: 0` for the
  initial pass, `1`/`2` for reflect cycles) and returned in
  `result.sources`, satisfying the issue's "surface which cycle a source
  came from" ask.
- New `MANA_RESEARCH_MAX_REFLECT_CYCLES` env var and `maxReflectCycles`
  request field, wired through `capabilities/deep-research-capability.js`
  the same way `maxSubQueries`/`maxPerDomain` already are.

## Resilience

Matches the existing philosophy throughout this file: a failing `reflect`
call is caught and treated as "no gap found" (never sinks an already-good
report); a gap query that finds nothing new stops the loop immediately
rather than re-synthesizing an unchanged report; the existing
`maxTotalMs`/cancellation checks apply to reflect cycles exactly like the
initial pass.

## Out of scope

Adopting LangGraph or any part of the LangChain framework -- this ports
one technique (reflect-and-iterate) into the existing hand-built loop, not
a rewrite.

## Verified

- `node-bot/test/deep-research.test.js` (+11 tests): reflect prompt
  building, decision parsing (NO_GAP_MARKER case-insensitivity, multi-line
  commentary, overlong garbage), the full one-cycle reflect flow
  (search->read->re-synthesize, continuing citation numbering), never
  exceeding `maxReflectCycles`, clamping to `MAX_REFLECT_CYCLES_CAP`,
  surviving a failing `reflect` call, and stopping when a gap query finds
  nothing new.
- `node-bot/test/deep-research-capability.test.js` (+1 test):
  `MANA_RESEARCH_MAX_REFLECT_CYCLES` env default and `reflect` forwarding.
- Full `node-bot` suite (one process per file): no regressions.
