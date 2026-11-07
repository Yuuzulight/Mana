# DeepSeek escalation benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Flash, Pro, and Pro-orchestrating-Flash on about 50 verifiable cases, report pass rate and cost per solved case, then compare Flash and Mana's local reviewer on every diff produced.

**Architecture:** Extend the existing self-work bench (`node-bot/bench/self-work-bench.js`, `--remote` already runs her loop on DeepSeek). A setup flag keeps three parallel runs from colliding; in-loop helper calls move to Flash; a `delegate` tool lets Pro hand pieces to a Flash worker in the same worktree; new cases come from real merged fixes through a miner plus the preflight; a separate script runs the review phase over saved diffs.

**Tech Stack:** Node (`node:test`, no new dependencies), PowerShell run scripts, DeepSeek API (OpenAI format), `git`/`gh`.

**Spec:** `docs/superpowers/specs/2026-10-12-deepseek-escalation-benchmark-design.md`

## Global Constraints

- Work in worktree `D:\Mana-worktrees\1462-locate` (branch `feat/1467-multi-step-coding`); local commits only. No push, no PR without the user's OK.
- No `Co-Authored-By` or any attribution trailer in commits (CLAUDE.md). Commits are authored as the repo's git user.
- Only cost or the model's ability may end a case: `--no-round-cap`, no time stop (`--time-by-estimate --time-warn-only --max-minutes 300`), stuck stop (8) stays, API failures retried (`retries: 12`), a harness error skips the case (3 in a row stop the run).
- Models: `deepseek-flash`, `deepseek-v4-pro`. Window 1M, replies 128K. Prices from `node-bot/api-spending.js` `PRICES`; peak (09:00-12:00, 14:00-18:00 local) bills double.
- Spend cap $15 per setup (`--max-usd 15`). Balance on 2026-10-12 was $27. Keep the PC awake while a run script lives.
- Guardrail files (`self-work.js`, `ManaSettingsStore.cs`, `acp-autonomous-loop.js`, `tool-call-log.js`) cannot be changed by a case; such cases stay out.
- Run tests with `NODE_PATH=D:/Mana/node-bot/node_modules node --test <file>` from `node-bot`. Do not use sleeps in foreground shells; poll with loops.

## Review Focus

- A helper call to Flash returns empty or non-JSON: the goal check and repair fail open (never block, never throw into the loop).
- `delegate` called with an empty brief, or a worker that makes no edit: Pro gets a plain "no changes" result, not an error that ends the run.
- Three setups writing `api-spending.json` at once: each setup gets its own `MANA_ACP_MEMORY_DIR`, so no ledger is shared.
- The balance runs out mid-run (HTTP 402): the run stops cleanly and the case is not scored as a model failure.
- Two setups on the same case: worktree folders and hidden-test copies never collide.

---

### Task 0: Commit the existing harness changes

**Files:** modify nothing new; commit `node-bot/ai/llama-server-runtime.js`, `ai/llama/tool-reply.js`, `bench/self-work-bench.js`, `self-work.js`, `test/remote-tool-loop.test.js`, `test/self-work-bench.test.js`, `test/self-work.test.js`.

- [ ] **Step 1:** Run `node --test test/self-work-bench.test.js test/remote-tool-loop.test.js test/self-work.test.js`; expect all pass.
- [ ] **Step 2:** `git add` those seven files; commit "Bench: no round cap, time warning, Flash reviewer, API retries, 1M window, PCRE search fallback (#1467)".

### Task 1: Parallel-safe setups and per-model spend

**Files:** modify `node-bot/bench/self-work-bench.js`; test `node-bot/test/self-work-bench.test.js`.

**Interfaces:**
- Produces: CLI flag `--setup <name>` (sets worktree prefix `bench-<name>-` and the default `--out` to `bench/results/<label>`); `spend.byModel: { [model]: { usd, cacheHit, cacheMiss, output, reasoning } }` filled wherever `spend` is updated (loop and reviewer); exported `spendOf(spend, model)`.

- [ ] **Step 1:** Test `spend.byModel` adds up: two calls for `deepseek-flash`, one for `deepseek-v4-pro` give separate totals that sum to `spend.usd`.
- [ ] **Step 2:** Run it, expect FAIL (`byModel` undefined).
- [ ] **Step 3:** In `remoteModel`, make `onResponse` and the reviewer's accounting call one `addSpend(spend, model, tokens, usd)` that updates both the flat totals and `byModel`.
- [ ] **Step 4:** Add `--setup`: `prefix` passed to `runCase` becomes `bench-${setup}-` (must still start with `bench-` for `benchTestGate`). Test: `runCase` worktree path contains `bench-flash-<caseId>`.
- [ ] **Step 5:** Run both tests, expect PASS; commit "Bench: --setup worktree prefix, per-model spend".

### Task 2: Peak-hour hold

**Files:** modify `node-bot/api-spending.js`, `node-bot/bench/self-work-bench.js`; test `node-bot/test/api-spending.test.js`.

**Interfaces:**
- Produces: `minutesToPeak(date = new Date()): number` (0 when already in peak, else minutes until the next peak start).

- [ ] **Step 1:** Tests: at 08:35 local `minutesToPeak` is 25; at 10:00 it is 0; at 12:10 it is 110.
- [ ] **Step 2:** Run, expect FAIL (not exported). Implement next to `isPeak`/`nextOffPeak`, reusing their peak-window constants. Run, expect PASS.
- [ ] **Step 3:** In the bench main loop, replace the `isPeak()` wait with: wait while `isPeak()` or `minutesToPeak() < 30`, logging "Peak hours: waiting" once.
- [ ] **Step 4:** Commit "Bench: don't start a case within 30 minutes of peak".

### Task 3: In-loop helpers on Flash

**Files:** create `node-bot/ai/llama/remote-helpers.js`; modify `node-bot/ai/llama-server-runtime.js` (`remoteToolReply` option `helperModel`), `bench/self-work-bench.js` (flag `--helper-model`); test `node-bot/test/remote-helpers.test.js`.

**Interfaces:**
- Produces: `createRemoteHelpers({ baseUrl, apiKey, model, fetchImpl, onResponse, retries })` returning `{ reviewGoalCompletion(args), repairToolCalls(messages, tools, maxTokens) }` with the same signatures and return shapes as `ai/llama/goal-review.js` and `ai/llama/tool-calls.js` (`{complete, missing[], evidence?}` or `null`; array of tool calls or `[]`).
- `remoteToolReply({..., helperModel})` overrides `reviewGoalCompletion` and `repairToolCalls` on its context when `helperModel` is set.

- [ ] **Step 1:** Tests with a fake `fetchImpl`: (a) a JSON reply `{"complete":false,"missing":["x"]}` returns that; (b) an empty body, a non-JSON body and an HTTP 500 each return `null` from `reviewGoalCompletion` and `[]` from `repairToolCalls` without throwing; (c) the request goes to `<baseUrl>/chat/completions` with the helper model, thinking disabled, and `response_format: {type: "json_object"}`; (d) `onResponse` gets each reply's usage.
- [ ] **Step 2:** Run, expect FAIL (module missing).
- [ ] **Step 3:** Implement the module. Reuse the system prompt and the evidence logic from `goal-review.js` (`goalEvidence` first, so an evidence gap still decides without a call); describe the JSON shape in the prompt because DeepSeek takes `json_object`, not a schema. Parse defensively.
- [ ] **Step 4:** Wire `helperModel` in `remoteToolReply`; in `remoteModel` pass it from `--helper-model` and add its tokens to `spend`. Test: with `helperModel`, no request goes to `127.0.0.1` and `base.start` is never needed (no local llama-server).
- [ ] **Step 5:** Run tests, expect PASS; commit "Remote loop: goal check and tool-call repair on a DeepSeek helper model".

### Task 4: Pro orchestrates, Flash works

**Files:** create `node-bot/bench/orchestrate.js`; modify `bench/self-work-bench.js` (flags `--orchestrate <model> --worker <model>`); test `node-bot/test/bench-orchestrate.test.js`.

**Interfaces:**
- Produces: `orchestrate({ orchestratorLoop, workerLoop, policy, onDelegate }): runLoop` where `runLoop(prompt, policy, opts)` runs the orchestrator with a policy that (a) drops the edit tools (`coding__propose_edit`, any write tool) and (b) adds `self_work__delegate({ brief: string })`. A delegation runs `workerLoop` with the original policy (edit tools included, no `delegate`) and a goal built from the brief, then returns JSON `{ status: "done"|"stuck"|"no-changes", summary, files, lastTest }` to the orchestrator.
- `--orchestrate`/`--worker` set the orchestrator's `remoteToolReply` and the worker's; spend is recorded under each model (Task 1).

- [ ] **Step 1:** Tests with scripted fake loops: (a) the orchestrator sees `self_work__delegate` and no edit tool; (b) the worker sees edit tools and no `delegate`; (c) an empty `brief` returns `{status:"no-changes"}` without starting a worker; (d) a worker that ends stuck returns `{status:"stuck"}` and the orchestrator loop continues; (e) the worker's edits go through the same `executeTool`, so plan gates and the hidden-test guard still apply.
- [ ] **Step 2:** Run, expect FAIL. Implement `orchestrate.js`: wrap `policy.tools`/`executeTool`, route `self_work__delegate` to `workerLoop`, build the worker's goal from the brief plus "make the edits and run the tests; stop when done".
- [ ] **Step 3:** Add the orchestrator guidance to the prompt (one paragraph in the bench's issue body for this setup: design first, delegate pieces with files and tests named, check the result, you cannot edit).
- [ ] **Step 4:** Run tests, expect PASS; commit "Bench: Pro orchestrates, Flash works".

### Task 5: Report per kind and cost per solved case

**Files:** modify `node-bot/bench/self-work-bench.js` (`summarize`, `writeReport`); test `node-bot/test/self-work-bench.test.js`.

**Interfaces:**
- Produces: `summarize(results, meta)` adds `costUsd` per result (from `byModel`), `perKind[kind] = { cases, passed, usd, usdPerSolved }`, `totalUsd`, `usdPerSolved`; the Markdown report gets a "Cost" table (by model and by kind) and an "Ended by" count (handed in, stuck, window full, spend cap, error).

- [ ] **Step 1:** Test: three fake results (two pass, one fail, with costs) give `usdPerSolved = totalUsd / 2` and per-kind rows; zero solved gives `usdPerSolved: null`, not Infinity.
- [ ] **Step 2:** Run, expect FAIL. Implement; run, expect PASS; commit "Bench report: cost per solved case, by kind and model".

### Task 6: Case miner and the C# spike

**Files:** create `node-bot/bench/gen/mine-cases.js`; test `node-bot/test/mine-cases.test.js`; spike notes in `docs/superpowers/specs/2026-10-12-csharp-bench-spike.md`.

**Interfaces:**
- Produces: `node bench/gen/mine-cases.js --since <date> --out <dir>` writing candidate case JSON (same shape as `bench/cases/*.json`: `id, minRounds, kind, pr, issue, base, fix, title, body, fixFiles, hiddenTests, testCommand, why`) for merged PRs whose diff touches both source and a test file; `classify(prFiles, title, body): kind` returning one of the spec's taxonomy kinds (`refactor`, `log-bug`, `vague`, `security`, `performance`, `script-config-docs`, `write-tests`, `csharp`, `node-bug`, `node-feature`, `multi-file`).

- [ ] **Step 1:** Tests for `classify`: a PR touching only `.ps1`/`.json`/`.md` is `script-config-docs`; one touching `windows-native-launcher/*.cs` is `csharp`; a title starting "Refactor" with unchanged tests is `refactor`; a body with a stack trace is `log-bug`; "validate"/"sanitize"/"path traversal" in the title is `security`.
- [ ] **Step 2:** Run, expect FAIL. Implement `classify` and the miner (uses `gh pr list --state merged --json` and `git diff --name-only`; `minRounds` from changed-file count and diff size is only a guess, the preflight corrects it).
- [ ] **Step 3:** Spike (read-only first): can `dotnet test` run inside the bench sandbox for `windows-native-launcher/` (needs the `folio-feed` package; do not touch Folio). Write findings in the spike note; if it cannot, mark C# cases as a gap in the report instead.
- [ ] **Step 4:** Run tests, expect PASS; commit "Bench: case miner, kind classifier, C# spike notes".

### Task 7: Build the new cases

**Files:** create `node-bot/bench/cases/<id>.json` (about 28) and `node-bot/bench/hidden/<id>/...` where hidden tests must be held back.

**Interfaces:** consumes Task 6's candidates. Produces cases in the spec's table: C# 5 (if possible), refactor 4, log-bug 3, vague 3, security 3, performance 2, script-config-docs 3, write-tests 3, generated one-spot bugs 2 (`bench/gen/generate-tasks.js --count 2`).

- [ ] **Step 1:** Run the miner, pick candidates per row (prefer the ones with the clearest tests and not in guardrail files); for `write-tests` cases the hidden check is the real fix's tests run against injected bugs (reuse `bench/gen/mutate.js`).
- [ ] **Step 2:** For each case run `node bench/self-work-bench.js --check --case <id>`; expect "sound". Drop and list any that fail; replace from the candidates.
- [ ] **Step 3:** Total sound cases is 50 or the shortfall is listed with the reason per row. Commit "Bench: 28 new cases (#1467)".

### Task 8: Run the three setups

**Files:** create `D:\Mana-worktrees\bench-results\2026-10-10-queue\run-three-setups.ps1`.

- [ ] **Step 1:** The script starts three hidden background runs in parallel (each from `D:\Mana-worktrees\1462-locate\node-bot`, keep-awake once, off-peak hold from Task 2): `--setup flash --remote deepseek-flash`, `--setup pro --remote deepseek-v4-pro`, `--setup combo --orchestrate deepseek-v4-pro --worker deepseek-flash`, all with `--helper-model deepseek-flash --no-round-cap --time-by-estimate --time-warn-only --max-minutes 300 --max-usd 15 --repeat 1 --label 2026-10-13-<setup>` and their own `MANA_ACP_MEMORY_DIR` (`.../ledger-<setup>`).
- [ ] **Step 2:** Launch with `Win32_Process.Create` and `-WindowStyle Hidden`; confirm the first case of each setup starts and no `llama-server` runs. Check progress, spend and balance on request; stop everything if the balance falls under $2.
- [ ] **Step 3:** When all three finish, read each report; record pass rate, `totalUsd`, `usdPerSolved` per setup and per kind.

### Task 9: Review-phase script and run

**Files:** create `node-bot/bench/review-eval.js`; test `node-bot/test/review-eval.test.js`.

**Interfaces:**
- Produces: `node bench/review-eval.js --results <dir>... --reviewer flash|local --out <dir>`; for every `*.diff` in the given results dirs plus each case's real fix diff (`git diff base..fix` limited to `fixFiles`), runs the three passes from `REVIEW_PASSES` (correctness, edge cases, scope) through the reviewer, and writes `verdicts.json` (`{ id, setup, source, label: "pass"|"fail"|"reference", pass, verdict }`); `score(verdicts): { caughtFailing, falseAlarms, n }` per reviewer, where a diff counts as flagged when any pass refutes it.
- Flash goes through the API; local goes through `refuteEdit` with `runLocalReplyIfSafelyLoaded` on the 9B (needs the GPU, so run it after the benchmark).

- [ ] **Step 1:** Tests for `score` with fixed verdicts: 3 failing diffs of which 2 flagged and 4 good diffs of which 1 flagged give `caughtFailing = 2/3` and `falseAlarms = 1/4`; reference diffs count as good.
- [ ] **Step 2:** Run, expect FAIL. Implement; run, expect PASS; commit "Bench: reviewer comparison script".
- [ ] **Step 3:** Run Flash, then the local 9B, over all three setups' diffs; write both scores side by side with cost and time.

### Task 10: The answer

**Files:** create `docs/superpowers/specs/2026-10-13-deepseek-bench-results.md`.

- [ ] **Step 1:** Read every passing diff (size, scope creep, style) and note the weak ones.
- [ ] **Step 2:** Write the result: pass rate, cost and cost per solved case for the three setups and per kind, where each setup breaks, the escalation recommendation, and the reviewer verdict against the spec's 15-point bar. Commit locally and give the user the path.

## Self-review

Every spec section maps to a task: setups and flags (1, 3, 4), limits (0, 2, 3, 8), cases (6, 7), measures and report (1, 5), review phase (9), running (8), the answer (10). The Pro+Flash tool, the helper module and the miner are the only new files with logic; everything else extends the bench.
