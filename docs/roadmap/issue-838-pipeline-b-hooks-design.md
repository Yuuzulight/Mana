# Issue 838: Hooks For Pipeline B (The ACP Autonomous Loop)

Status: **Design only.** No code yet. This is the last unbuilt part of #486,
designed now at the user's request (grilling Q39, 2026-09-29). It builds on
#796 (`modify-input`, in-place rule edits) and #795 (plugin input hooks), and
has to fit with goal mode (#787) and the adversarial verifier (#788).

## Summary

Pipeline B should apply the same `hooks.json` rules as Pipeline A, in the same
order: `modify-input` first, then `deny`, then `ask`, then the tool itself,
then the `post` rules. Nothing new is needed in the rule format except one
safety check (a `modify-input` rule may not set `approved`). The work is small
once the dispatch chain in `executeAutonomousStep` has one place to hook
into. The open questions are mostly about where Pipeline B's approvals show up
and whether its `file_write` gets the adversarial review.

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

Only the per-call points Pipeline A already has. No new rule actions.

| Point | Actions | Where in `executeAutonomousStep` | Result the model sees |
| --- | --- | --- | --- |
| pre, rewrite | `modify-input` | First, before the #396 cap and every tool guard | Nothing extra; the call just runs with the new args |
| pre, block | `deny` | After the cap check | `{tool, status: "denied", detail: reason}` |
| pre, gate | `ask` | After `deny` | Waits for a human via `runApprovalGate`; on reject/timeout `{status: "rejected", detail}` |
| post | `run-command`, `rollback-on-failure` | After the tool, only when its result has `status: "ok"` | Nothing; fire-and-forget like Pipeline A |

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
- **Not needed now:** a step-level or `finish` ("Stop") hook. See open
  question 6.

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
- Today these requests are invisible in the launcher (see open question 1).
  Until they show up there, every `ask` just times out after 5 minutes, which
  makes it a slow `deny`.

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
    the user, don't retry.
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
- **Pipeline B's `file_write` is not covered.** It writes straight to disk
  after its own file-based approval, with no proposal and no review. See open
  question 3.

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
8. **No GPU or model use by hooks.** If the verifier is added (open
   question 3), it uses only a model that is already loaded, as in #788.

## Found while reading the code (not fixed here)

- **Limits that are shown but not enforced.** `mana-acp-agent.js` passes
  `maxIterations` (`MANA_AGENT_MAX_ITERATIONS`, 3) and `maxFilesChanged`
  (`MANA_AGENT_MAX_FILES_CHANGED`, 5) to `createAcpAutonomousLoop`, and shows
  them in its capabilities. The loop ignores both. See open question 7.
- **Post hooks on `coding__propose_edit` fire too early.** A `run-command`
  rule (the "prettier after a write" example) runs when the proposal is
  created, before the file changes, so it formats the old file. This is
  Pipeline A behaviour today. It would need a hook point on
  `approveEditProposal` if that example matters.
- **The `rollbackFile` basename search** from safety limit 6 also applies to
  Pipeline A.

## Open questions for the user

1. **Where should Pipeline B's approvals show up?** Today they only reach
   `/admin/pending-writes`, and nothing in the launcher lists them, so `file_write`
   approvals time out as well.
   *Recommendation:* list pending writes (and `hook-ask` requests) in the
   launcher's existing approvals list, with Approve/Reject. Do this before, or
   together with, the `ask` wiring. Without it, `ask` in Pipeline B is a slow
   `deny`.
2. **Should one rule cover both pipelines' write tools?** Rules match by tool
   name, and `file_write` is not `coding__propose_edit`, so "ask before
   touching package.json" needs one rule per tool.
   *Recommendation:* keep exact names and write one rule per tool, with no
   alias layer. Revisit with the Claude Code import (#486 comment), whose
   mapping table already sends `Write`/`Edit` to both.
3. **Should the adversarial verifier review Pipeline B's `file_write`?**
   *Recommendation:* yes, for source files only.
   - The ACP process has no model, so it asks the backend for a review only
     (one new bridge call to a route that wraps `refuteEdit`).
   - A `refuted` verdict forces the manual approval even with
     `args.approved === true` or `FILE_WRITE_REQUIRE_APPROVAL=0`.
   - The failing case goes into the pending request, so the approver sees it
     (Q16).

   The alternative is to send source-file writes through the proposal path
   instead of `file_write`. That is a bigger change to how Pipeline B works,
   because a write would no longer be on disk until someone approves it.
4. **One prompt or two?** If an `ask` rule matches a `file_write` that also
   needs its own approval, should the user be asked twice?
   *Recommendation:* once. An approved `hook-ask` also counts as that write's
   approval. The exception is a write the verifier refuted, which always gets
   its own prompt showing the failing case.
5. **What should happen when `hooks.json` is broken?** Today a file that
   won't parse means "no rules" in both pipelines, so `deny` rules silently
   stop working.
   *Recommendation:* for the unattended Pipeline B, fail closed on side
   effects. If `hooks.json` exists but won't parse, `file_write`,
   `snapshot_restore` and `run_tests` return `hooks_config_unreadable`, and
   reads still work. Leave Pipeline A as it is unless you want the same
   there.
6. **Should there be a `finish` hook (like Claude Code's `Stop`)?** It could,
   for example, run the tests and refuse `finish` while they fail.
   *Recommendation:* not now. `finish` is only a signal to the ACP client, so
   refusing it enforces nothing. Revisit together with #787's ACP continue
   hint and the import's `run-command-decide`.
7. **Should `maxIterations` / `maxFilesChanged` be enforced?**
   *Recommendation:* yes, as a separate small issue, not in the hooks PRs.
   - Count distinct files written per session in `file_write`, and stop at
     `maxFilesChanged`.
   - `maxIterations` belongs to the caller-driven loop. Either count
     `mana/agent/run` calls per session, or stop showing it as a capability.

## Proposed PR split (after the questions are answered)

1. **Pre hooks in Pipeline B:**
   - `applyInputRules` taken out of `wrapWithInputHooks`;
   - `normalizeRule` rejects `approved` in `set`;
   - the `runAction` move;
   - `modify-input` / `deny` / `ask` wired in, in the order above.

   Tests: a rewrite passes through the path guard and the approval; `deny`
   is reported and counted toward #396; `ask` is rejected on timeout; a rule
   can't set `approved`.
2. **Post hooks in Pipeline B**, plus the fix that makes rollback use the
   snapshot id (safety limit 6), in both pipelines.
3. **Launcher approvals list for pending writes** (question 1).
4. **Verifier on Pipeline B `file_write`** (questions 3 and 4).
5. **Separate issues:** the fail-closed config (question 5, if yes) and the
   agent limits (question 7).
