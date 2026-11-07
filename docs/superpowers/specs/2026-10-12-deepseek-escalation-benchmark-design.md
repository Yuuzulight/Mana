# DeepSeek escalation benchmark (#1406, #1467)

Date: 2026-10-12. Status: draft for approval. Nothing is built from this until it is approved.

## Intent

Mana's self-work needs a model that can do multistep coding well, at a price that stays low. The question this benchmark
answers is: **are DeepSeek's two models good at multistep coding for what they cost, and which setup should Mana escalate to?**

Three setups, on the same cases, with the same limits:

1. **Flash**: `deepseek-flash` does the whole job.
2. **Pro**: `deepseek-v4-pro` does the whole job.
3. **Pro + Flash**: Pro is the orchestrator and designer, Flash is the worker. Pro reads the issue, decides the approach, splits
   the work into pieces and hands each to Flash with a written brief; Flash makes the edits and runs the tests; Pro looks at
   what came back and decides whether the piece is done or needs another round.

Afterwards, a second phase asks a different question: **is a cheap cloud model a better code reviewer than Mana's local
reviewer?** Flash and Mana's local reviewer each review every diff from all three setups, three passes each, and are scored
against the hidden tests. If Flash is not much better, Mana keeps reviewing locally.

## Goals

- A suite of about 50 verifiable cases that covers the kinds of work Mana is asked to do, including the ones models tend to
  fumble (see "The cases").
- A pass rate, a cost, and a cost per solved case for each of the three setups, overall and per kind of work.
- A plain recommendation: which setup, for which kind of work, and what it costs.
- A reviewer comparison with a clear verdict.

## Non-goals

- Comparing against the local models again (their results exist: 9B 3/22, 30B 2/22, 35B 1/22, 7B 0/22).
- Changing Mana's production reviewer or escalation code. This produces evidence; changing Mana is a separate decision and a
  separate PR.
- Training on the runs.

## Anti-goals (what would make this a failure even if it ran)

- A harness limit, not the model, deciding a result: round caps, time stops, a context label measured against the wrong
  window, a local 9B overruling the model being measured, an API blip scored as a model failure.
- A case that cannot be solved from the issue text, or whose hidden tests check something the issue never said.
- Spending past what the user topped up, or paying peak prices by accident.

## Constraints

- Budget: about $19 expected (range $11-33) off-peak, for 50 cases across the three setups plus reviews. The user tops up the
  DeepSeek balance (it was $17.78 on 2026-10-12). Peak hours (09:00-12:00 and 14:00-18:00 local) bill double.
- The PC stays usable for gaming; tests run at below-normal priority, one case per setup at a time.
- The harness is `node-bot/bench/self-work-bench.js` in the `1462-locate` worktree (branch `feat/1467-multi-step-coding`).
  Its uncommitted changes from 2026-10-12 stay: `--no-round-cap`, `--time-by-estimate`, `--time-warn-only`, `--reviewer`, a
  1M window for remote models, API retries, a hidden-test hint in the prompt, and the PCRE fallback in `self_work__search`.
- Guardrail files (`self-work.js`, `ManaSettingsStore.cs`, `acp-autonomous-loop.js`, `tool-call-log.js`) cannot be changed by
  a case, so cases that need them stay out (five already are).

## The limits (decided)

Only cost or the model's own ability may end a case. No round cap. No time stop (a 300-minute guard against a hang only; the
per-case estimate is a logged warning). The context window is DeepSeek's real 1M. The stuck stop (8 calls with nothing new)
stays, because it is a cost protection and only fires on repetition. A failed API request is retried with backoff for about an
hour and never scored against the model. A harness error on one case skips the case; three in a row stop the run.

## The cases

**Existing, 22 sound cases** from real merged fixes (Node bugs, Node features, multi-file work, a launcher case, live cases).

**New, about 28**, built to cover what those don't. Target counts (the real numbers depend on what can be made verifiable):

| Kind of work | New cases | Source |
| --- | --- | --- |
| C# launcher changes | 5 | real merged fixes, if the sandbox can run `dotnet test`; otherwise listed as a gap |
| Refactors that must not change behavior | 4 | real merged refactors, tests unchanged |
| Bugs found from a log or stack trace | 3 | real merged fixes with the trace in the issue |
| Vague issues that need an assumption | 3 | real merged fixes with a thin issue |
| Security and input validation | 3 | real merged fixes |
| Performance | 2 | real merged fixes with a measurable test |
| Scripts, config and docs (PowerShell, Python, JSON, Markdown) | 3 | real merged fixes |
| Writing tests for existing code | 3 | scored by how many injected bugs the new tests catch |
| One-spot bugs across more modules | 2 | the existing generator (`bench/gen/generate-tasks.js`) |

Every case needs: an issue text, the code before the fix, hidden tests that fail before and pass after the real fix, and
a preflight pass (`bench/preflight.js`) that proves it is sound. Cases that fail preflight are dropped and listed.

## How each setup runs

All three use the same loop, tools and prompts (Mana's self-work, `--remote`). In-loop helper calls (the per-edit review, the
"is it really done" check, and tool-call repair) go to `deepseek-flash` in all three setups, so the result is DeepSeek only,
needs no GPU, and the local reviewer is judged separately in the review phase. (My call, see below.)

**Pro + Flash:** Pro gets the read, search and test tools and one extra tool, `delegate(brief)`. It cannot edit files. A
delegation starts a Flash worker loop in the same case worktree with the coding tools; the worker ends when it hands in or is
stuck, and Pro gets back its summary, the diff it made and the last test result. Pro then delegates again, or finishes. Tokens
and dollars are counted per model.

## What is measured per case

Hidden tests pass or fail (the only scoring signal), rounds, tool calls, wall time, tokens and dollars split by model, diff
size, files touched outside the real fix, and why it ended (handed in, stuck, window full, spend cap, error). Failure labels
are fixed so "context overflow" is measured against the model's real window.

## The report

Per setup: pass rate, total cost, cost per solved case. Per kind of work: the same. Then a read of every passing diff for
size, scope creep and style, and the recommendation.

## The review phase (after all three setups finish)

For every diff from the three setups (about 150), plus each case's real merged fix as a known-good control, Flash and Mana's
local reviewer each run three passes: correctness, edge cases, scope. Mana's reviewer is the existing edit reviewer
(`ai/adversarial-verifier.js`) on the local 9B. Ground truth is the hidden-test result. Scored on: failing diffs caught, good
diffs wrongly refused, cost and time. Default bar for "much better": Flash catches 15 or more points more of the failing diffs,
or refuses clearly fewer good diffs at a similar catch rate. Otherwise the local reviewer stays.

## Running it

The three setups run in parallel, off-peak only, in separate worktree name spaces so cases don't collide. A case does not start
if peak hours begin within 30 minutes. Per-setup spend cap: $15. Each setup writes its own report to
`node-bot/bench/results/<date>-<setup>`; the run scripts live in `D:\Mana-worktrees\bench-results\2026-10-10-queue`.

## Left to the builder

The `delegate` brief format, how to find real merged refactors, security and performance fixes with tests, and the exact
sandbox changes for C# cases.

## Calls I made (the user can overrule)

- In-loop helpers on Flash in every setup (keeps the three setups comparable and the PC free).
- Spend cap $15 per setup instead of $10, because 50 cases can pass $10 on Pro.
- Peak-hour hold of 30 minutes before peak, and running the three setups in parallel.
- The case mix above, and dropping C# cases if `dotnet test` cannot run in the sandbox.
- Pro cannot edit in setup 3, and Flash workers are not given a round limit either.
- In the review phase each "pass" is Mana's own pass checklist (`REVIEW_PASSES` in `self-work.js`: correctness, edge cases,
  scope) given to the reviewer with the diff and the issue, the same for Flash and for the local model.
