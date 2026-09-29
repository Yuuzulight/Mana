# Issue 838: Hooks For Pipeline B (The ACP Autonomous Loop)

Status: **Decided** (2026-09-29). Being built in the PRs listed at the end. This is the last unbuilt part of #486,
designed now because I decided to (grilling Q39, 2026-09-29). It builds on
#796 (`modify-input`, in-place rule edits) and #795 (plugin input hooks), and
has to fit with goal mode (#787) and the adversarial verifier (#788).

## Summary

Pipeline B should apply the same `hooks.json` rules as Pipeline A, in the same
order: `modify-input` first, then `deny`, then `ask`, then the tool itself,
then the `post` rules. The rule format gets three additions: a `modify-input`
rule may not set `approved`, a shared tool name `write` covers both write
tools, and a new `finish` phase runs a command when the loop sends `finish`.
The work is small once the dispatch chain in `executeAutonomousStep` has one
place to hook into. The decisions at the end settle where Pipeline B's
approvals show up, the adversarial review of its `file_write`, and the limits.

## What Pipeline B is today

These facts come from reading the code on `main` (2026-09-29).

- **It is a step executor, not a loop.** An ACP client (Zed) calls
  `mana/agent/run` with the model's reply (`mana-acp-agent.js`).
  `executeAutonomousStep` (`acp-autonomous-loop.js`) parses it as
  `[{tool, args}]` and runs each action through one long `if (tool === ...)`
  chain. The client decides whether to call again. `finish` (#401) is only a
  signal to the client.
- **It runs in the ACP agent process, not in `server.js`.** It has no
  `approval-gate.js`, no risk gate (#669), no `tool-call-log.js` (#188) and no
  loaded model.
- **Tools:** `local_retrieve`, `file_read`, `dir_scan`, `snapshot_list`
  (read-only); `file_write`, `snapshot_restore`, `run_tests` (side effects);
  `finish`.
- **Approvals are file-based.** `runApprovalGate` writes a pending request to
  `MANA_PENDING_WRITES_DIR` and blocks until an `.approved.json` or
  `.rejected.json` appears, or `FILE_WRITE_APPROVAL_TIMEOUT_MS` (5 min)
  passes. The only way to approve is `POST /admin/pending-writes/:id/approve`.
  The native launcher has no view for these.
- **Existing limits:**
  - `MANA_AGENT_AUTONOMOUS=1` is needed at all.
  - `ALLOW_FILE_WRITE` is off by default.
  - Paths are checked by `resolveWithinRepo`, and `.git`, `.env` and the
    vector store are blocked.
  - Reads and writes have size caps.
  - #396 caps each tool at 50 calls per session.
  - `run_tests` has a command allowlist and 3 retries.
  - `file_write` skips approval when the model sends `args.approved === true`.
    This only matters once `ALLOW_FILE_WRITE=1`. `snapshot_restore` has no such
    escape hatch.

## What Pipeline A does (the pattern to match)

`server.js` wraps the tool policy like this (outermost first):

```
wrapWithInputHooks   #796 modify-input: rewrite args
  wrapWithToolCallLog  #188 audit log
    wrapWithRiskGate     #669 risk tiers
      wrapWithHooks        #426 deny, ask, post run-command / rollback-on-failure
        tool
```

Every gate and the log see the rewritten call, never the original. `ask` goes
through `approval-gate.js` and returns `{status: "pending"}` to the model.

## Hook points Pipeline B needs

The per-call points Pipeline A already has, plus the `finish` hook
(decision 6).

| Point | Actions | Where in `executeAutonomousStep` | Result the model sees |
| --- | --- | --- | --- |
| pre, rewrite | `modify-input` | First, before the #396 cap and every tool guard | Nothing extra; the call just runs with the new args |
| pre, block | `deny` | After the cap check | `{tool, status: "denied", detail: reason}` |
| pre, gate | `ask` | After `deny` | Waits for a human via `runApprovalGate`; on reject/timeout `{status: "rejected", detail}` |
| post | `run-command`, `rollback-on-failure` | After the tool, only when its result has `status: "ok"` | Nothing; fire-and-forget like Pipeline A |
| finish | `run-command` | After the step's other actions, when it contains `finish` | `finishChecks` on the step result (see below) |

Proposed per-action order:

```
args   = applyInputRules(pre rules for tool, action.args)   // modify-input
cap    = #396 per-tool count                                // unchanged
pre    = matchRules(tool, "pre", args)                      // re-matched on the new args
deny?  -> push {status: "denied"}; next action
ask?   -> runApprovalGate("hook_ask", ..., requireApproval = true); rejected -> push; next action
result = runAction(tool, args)                              // today's if-chain
push result
status ok? -> post rules (runPostCommandHook)
```

### Implementation shape

- **One mechanical move.** Move the body of today's `if` chain into
  `runAction(tool, args)`, which returns what each case pushes today
  (`continue` becomes `return`). The pre and post hooks then
  wrap it in one place instead of in eight cases.
- **Reuse, don't copy.** Take the `set` merge loop out of `wrapWithInputHooks`
  into an exported `applyInputRules(rules, args)`, and use it in both
  pipelines. `matchRules` and `runPostCommandHook` are already exported.
- **Same rules file.** The ACP process would create its own
  `createHooksStore({})`. It reads the same `node-bot/data/hooks/hooks.json`,
  and `matchRules` reads the file on every call. A rule added or edited
  through `POST`/`PATCH /hooks` applies from Pipeline B's next action, with
  no reload.
- **Shared name `write` (decision 2).** A rule with `toolName: "write"`
  matches both `file_write` and `coding__propose_edit`, in both pipelines and
  every phase. Exact names and `prefix*` still work. It lives in
  `ruleMatchesTool`, so every caller of `matchRules` gets it.
- **`finish` hook (decision 6).** A rule `{phase: "finish", action:
  "run-command", command, args}` (no `toolName` needed). When a step contains
  `finish`, each enabled `finish` rule runs in file order after the step's
  other actions: awaited, `execFile` with `shell: false`, the repo root as the
  working directory, and a 2-minute timeout (the same as the ACP test
  runner's default). The step result gets
  `finishChecks: [{rule, command, ok, exitCode, output}]`, with the last
  2000 characters of output, for the ACP client to read.
  **It can't truly block finishing.** `finish` is only a signal to the ACP
  client, which decides whether to call `mana/agent/run` again. The step still
  returns `status: "finished"`. A failed check is reported, not enforced.

## Interactions

### Approvals

- A hook `ask` in Pipeline B uses `runApprovalGate`, so it is the same kind of
  pending request as `file_write` (id prefix `hook-ask`). Its payload holds
  the tool name, the rule's reason, the session id, and the args with long
  strings cut to 2 KB (the same limit as `file_write`'s preview), because args
  can hold whole file contents.
- `ask` always needs a human. It passes `requireApproval = true` whatever
  `FILE_WRITE_REQUIRE_APPROVAL` or `args.approved` say.
- There is no `allow` action, so no hook can approve anything or skip a gate.
  This is the same guarantee #426 gives Pipeline A.
- `runApprovalGate` blocks, so a step with several `ask` matches waits for
  each one in turn.
- Today these requests are invisible in the launcher. Decision 1 adds them to
  the launcher's approvals list, with Approve/Reject. Until then, every `ask`
  just times out after 5 minutes, which makes it a slow `deny`.
- **One prompt (decision 4).** An approved `hook-ask` also counts as the
  matched `file_write`'s own approval. The exception is a write the verifier
  refuted: it always gets its own prompt, showing the failing case.

### Goal mode (#787)

- **Goal mode is Pipeline A only.** It lives in `runToolAwareReply`.
  Pipeline B has no loop in node-bot to put it in. #787 lists an ACP "continue
  hint" as a follow-up.
- **Hooks don't know about goal mode.** The same rules apply in and out of it,
  and no goal-mode-only rule field is proposed.
- **What already happens in Pipeline A goal mode:**
  - `ask` returns `pending`, and the loop stops (`awaitingApproval`).
  - `deny` throws, so it counts toward the 3-consecutive-errors stop.
  - `modify-input` is invisible to the loop, but the audit log records the
    rewritten call.
  - The completion review sees the denied or pending result, so it can't call
    the goal done.
- **Pipeline B:**
  - `ask` blocks the step until someone decides, so a caller-driven loop
    can't spin on it.
  - When the ACP continue hint is built, it should treat `denied`, `rejected`
    and `approval_timeout` the way #787 treats `pending`: stop and hand back to
    me, don't retry.
- **Hooks can't change who is in charge.** Per Q35b, Mana turns goal mode on
  when asked, and `MANA_GOAL_MODE` stays the master kill switch. Pipeline B
  autonomy stays behind `MANA_AGENT_AUTONOMOUS=1`. No hook action can change
  either.

### Adversarial verifier (#788)

- **Pipeline A:**
  1. `modify-input` rewrites the `coding__propose_edit` args.
  2. `deny` and `ask` run.
  3. The proposal is built.
  4. `refuteEdit` reviews the rewritten edit.
  5. The proposal is stored.

  A `refuted` verdict makes `approveEditProposal` require `confirmRefuted`
  (Q16). Hooks run before the verifier and can't approve anything, so they
  can't get around Q16.
- **The ACP agent's `mana/edit/*` path** already goes through the same
  proposal routes. It never sends `confirmRefuted`, so it is covered.
- **Pipeline B's `file_write` today** writes straight to disk after its own
  file-based approval, with no proposal and no review. Decision 3:
  - Source files only (`refuteEdit`'s own extension list).
  - The ACP process has no model, so it asks the backend for a review only,
    through one new bridge call to a route that wraps `refuteEdit`. The
    review sees a unified diff of the old and new content.
  - A `refuted` verdict forces the manual approval even with
    `args.approved === true` or `FILE_WRITE_REQUIRE_APPROVAL=0`. The failing
    case goes into the pending request, so the approver sees it (Q16).
  - An unreachable backend or a verifier error leaves the write as it was:
    the verifier only changes anything when it refutes.

## Safety limits

These are technical defaults, decided here:

1. **Hooks only add checks.** There is no `allow` action, and `ask` always
   needs a human (see Approvals).
2. **`modify-input` may not set `approved`.** `normalizeRule` rejects it for
   every tool in both pipelines. That closes the hole #796 pointed out, where
   a rule could turn on `file_write`'s model-controlled approval skip.
3. **A rewrite is checked like any other call.** It happens before every
   guard: the path check, the blocked paths, `ALLOW_FILE_WRITE`, the size
   caps, the `run_tests` allowlist and the approval. So a rewrite can't
   produce a call those would refuse. It changes args only, never the tool
   name.
4. **`deny` is a result, not an exception.** The model is told why, and the
   rest of the step still runs (the same reasoning #396 uses for its cap).
   The #396 cap is checked first, so a model that keeps retrying a denied call
   still hits the cap.
5. **Post commands keep Pipeline A's limits.** They run with `execFile` and
   `shell: false`, a 15 s timeout, and never block or fail the call. In
   Pipeline B they also run with the repo root as the working directory,
   because `args.path` there is relative to the repo, not to the ACP
   process's own working directory. They run
   only after a result with `status: "ok"`, never after
   denied/rejected/pending.
6. **`rollback-on-failure` restores only the snapshot this write took.**
   Pass the id `file_write` just recorded. Today `rollbackFile` picks the
   newest snapshot with the same basename. Pipeline B takes no snapshot for
   appends or new files, so that search could restore an older, unrelated
   file. With no snapshot, the rule acts like `run-command` and logs that
   there was nothing to roll back.
7. **Logs hold no values.** Rewrites log the rule id and key names only, as
   in #796.
8. **No GPU or model use by hooks.** The verifier (decision 3) uses only a
   model that is already loaded, as in #788.
9. **A broken `hooks.json` fails closed in Pipeline B (decision 5).** If the
   file exists but won't parse, `file_write`, `snapshot_restore` and
   `run_tests` return `hooks_config_unreadable`, and the read-only tools still
   work. Pipeline A is unchanged: it still reads a broken file as "no rules".

## Found while reading the code (not fixed here)

- **Limits that are shown but not enforced.** `mana-acp-agent.js` passes
  `maxIterations` (`MANA_AGENT_MAX_ITERATIONS`, 3) and `maxFilesChanged`
  (`MANA_AGENT_MAX_FILES_CHANGED`, 5) to `createAcpAutonomousLoop`, and shows
  them in its capabilities. The loop ignores both. Decision 7 enforces them.
- **Post hooks on `coding__propose_edit` fire too early.** A `run-command`
  rule (the "prettier after a write" example) runs when the proposal is
  created, before the file changes, so it formats the old file. This is
  Pipeline A behaviour today. It would need a hook point on
  `approveEditProposal` if that example matters.
- **The `rollbackFile` basename search** from safety limit 6 also applies to
  Pipeline A.

## Decisions (2026-09-29)

1. **Approvals show up in the launcher.** Pending writes and `hook-ask`
   requests go in the launcher's approvals list, with Approve/Reject.
2. **One rule covers both write tools.** I chose this over the
   one-rule-per-tool recommendation. The shared name `write` matches
   `file_write` and `coding__propose_edit`, in both pipelines. Exact tool
   names still work.
3. **The verifier reviews Pipeline B's `file_write`,** for source files only.
   A refuted verdict forces manual approval, even with `approved: true` or
   `FILE_WRITE_REQUIRE_APPROVAL=0`.
4. **One prompt.** An approved `hook-ask` counts as the write's approval,
   except for a refuted write, which gets its own prompt showing the failing
   case.
5. **A broken `hooks.json` fails closed in Pipeline B** on side effects
   (`file_write`, `snapshot_restore` and `run_tests` return
   `hooks_config_unreadable`). Reads still work. Pipeline A is unchanged.
6. **A `finish` hook now.** I chose this over waiting. A rule can run a
   command (the tests, say) when the loop sends `finish`, and the result goes
   back to the ACP client. It can't truly block finishing (see Implementation
   shape).
7. **The agent limits are enforced,** in a separate issue and PR:
   - distinct files written per session count against `maxFilesChanged`;
   - `mana/agent/run` calls per session count against `maxIterations`.

## PR split

Each step has its own issue (Refs #838). Steps 1, 2, 4, 5, 6 and 7 all
change `acp-autonomous-loop.js`, and step 1 moves its whole dispatch chain,
so they are stacked in that order. Step 3 only touches the launcher and the
pending-writes routes, so it goes straight onto `main`.

1. **Pre hooks in Pipeline B:**
   - `applyInputRules` taken out of `wrapWithInputHooks`;
   - `normalizeRule` rejects `approved` in `set`;
   - the shared `write` tool name (decision 2);
   - the `runAction` move;
   - `modify-input` / `deny` / `ask` wired in, in the order above.
2. **Post hooks in Pipeline B**, plus the fix that makes rollback use the
   snapshot id (safety limit 6), in both pipelines.
3. **Launcher approvals list for pending writes and hook asks** (decision 1).
4. **Verifier on Pipeline B `file_write`, and one prompt** (decisions 3 and 4).
5. **Fail-closed config** (decision 5).
6. **The `finish` hook** (decision 6).
7. **The agent limits** (decision 7), under their own issue.
