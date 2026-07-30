# Issue 269: Route Deep Research Subtasks to Different Model Profiles

## Goal

Deep Research's `decompose` and `reflect` calls are short, structured, and
cheap to judge correctly even with a smaller/faster model -- the issue asked
to map each subtask type to whichever profile actually fits it, rather than
running the entire pass on one profile.

## Status: Implemented, opt-in and off by default (`node-bot/server.js`)

`DEEP_RESEARCH_SUBTASK_PROFILE` resolves to `"fast"` only when
`MANA_DEEP_RESEARCH_SUBTASK_PROFILES=1` is set; otherwise it stays
`"quality"`, identical to pre-#269 behavior. Only `decompose` and `reflect`
use it -- `synthesize` and `compress` stay on `"quality"` unconditionally in
every code path.

## Why this is opt-in, not the default

A 5-independent-review pass on this change (round: `4ec0430..e9d1029`)
traced the real call sequence in `tools/deep-research.js`'s
`runDeepResearch()` and found that turning the flag on does not simply
"use a faster model for two calls" -- because `decompose`/`reflect` are
interleaved with `compress`/`synthesize` (which stay on `"quality"`), one
research pass with even the default single reflect cycle alternates
profiles up to **3 times** (`fast` → `quality` → `quality` → `fast` →
`quality` → `quality`); two reflect cycles produce 5 swaps. Since
`llama-server`'s model swap is a multi-second cold-start (benchmarked at
4.1s tuned / 11.4s untuned in `ai/llama-server-runtime.js`), and the
`decompose`/`reflect` calls themselves are capped at 200/100 tokens (so the
compute saved by a smaller model is on the order of ~1s), the flag is a net
time loss in essentially every realistic scenario on typical hardware --
validating, not contradicting, this codebase's pre-existing "avoid a
mid-research model swap" design note (see `issue-197-deep-research-reflect.md`,
which this doc's landing also updated to cross-reference this file instead
of silently going stale).

A genuinely swap-safe design exists -- decide one profile for the *whole*
research pass up front (e.g. by whether reflect cycles are enabled at all),
rather than switching per subtask-call -- but that doesn't satisfy the
issue's literal wording ("map each subtask type... rather than picking one
profile for the entire run"). The per-call design shipped here is the
faithful implementation of what was asked; the swap-cost tradeoff is the
honest cost of that literal interpretation, not a bug to fix in this pass.

## Why ship it at all, then

The flag is genuinely inert unless a user reads the code/docs and opts in
explicitly -- it appears nowhere in the README, no `.env.example`, and no
"recommended env vars" list, so there's no accidental-adoption path. It
remains available for the one case where it *could* help: fast local
storage, small enough profile models, and an aggressively tuned
`LLAMA_SERVER_SWAP_DEBOUNCE_MS`, where swap cost is closer to negligible.

## Test coverage

`node-bot/test/deep-research-subtask-profile.test.js` asserts the env-off
default resolves to `"quality"`, the env-on (`"1"` exactly) value resolves
to `"fast"`, and any other value (e.g. `"true"`, `"yes"`) stays `"quality"`
-- guarding against a future refactor silently flipping the default.

## Out of scope

No change to `synthesize`/`compress`'s profile, no per-pass (whole-run)
profile-selection mode, no wiring into `tools/subagent-delegation.js`
(a separate, not-yet-reviewed surface).
