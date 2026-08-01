# Issue 284: Guardian Pre-Check on the Approval Gate

## Goal

`approval-gate.js` (issue #152) already pauses agent-authored actions (a
skill write, a generated script run) for a human to approve, with an
optional deterministic content scan that can flag a request for attention.
The issue asked for a JARVIS-style "Guardian" step: judge each specific
action's risk directly, rather than a fixed allowlist, so a genuinely
low-risk action can skip the human queue entirely.

## Status: Implemented, opt-in and off by default (`node-bot/approval-gate.js`,
`node-bot/ai/guardian-precheck.js`, `node-bot/server.js`,
`node-bot/capabilities/approval-gate-capability.js`)

`MANA_GUARDIAN_PRECHECK_ENABLED=1` turns it on; unset or any other value
leaves `requestApproval` behaving exactly as before #284.

- `ai/guardian-precheck.js`'s `judgeActionRisk({actionType, summary,
  payload, scanText, runLocalReply})` asks whatever model is already loaded
  for the "fast" profile (reused via `runLocalLlamaReply`, same convention
  #281 established for cheap classification calls -- no dedicated Guardian
  model, no extra VRAM) to answer exactly `SAFE` or `RISKY` for one
  specific action. Any failure -- the model throws, returns empty, or
  answers something that isn't clearly `SAFE`/`RISKY` -- resolves to
  `{safe: false}`. This is the load-bearing fail-safe: Guardian can only
  ever *skip* the human queue for an action the model confidently
  recognized as low-risk; every other outcome (including its own failure)
  routes to the human exactly like before.
- `approval-gate.js`'s `createApprovalGate` takes two new options:
  `guardianEnabled` (off by default) and `guardianPreCheck` (an injected
  async judge function -- server.js wires the real
  `ai/guardian-precheck.js` one; tests inject a fake, same DI pattern as
  `summarizeFn`/`computeEmbeddingsFn` elsewhere in this codebase).
  `requestApproval` calls it after the existing `isAlwaysAllowed` check and
  the content scan, before ever creating a pending entry.
- **The deterministic content scan always wins.** Guardian is only
  consulted when `scanContent` (or a caller-supplied `scanText`) found
  nothing -- a hit on `shell-execution`/`filesystem-write`/
  `credential-like-string`/`remote-code-fetch` forces the human queue
  regardless of what the model thinks. A lexical heuristic and a model's
  own judgment are complementary defensive layers, not one gate deferring
  to the other.
- **Real audit logging.** A Guardian auto-clearance is written to its own
  log via `approval-gate.js`'s `guardianAuditLog` -- an instance of the
  already-existing `tool-call-log.js` (same JSON-lines format, same
  `append`/`readRecent` API, just pointed at `guardian-audit.jsonl` under
  the approval gate's own data dir instead of building a new logging
  mechanism). `GET /approvals/guardian-audit` surfaces it, mirroring how
  `tool-call-log-capability.js` already exposes `/tool-calls/recent`.
- **A post-clearance executor failure propagates, it doesn't silently
  re-queue.** If `runExecutor` throws after Guardian said "safe," that
  error is not caught inside the Guardian branch -- it propagates exactly
  like a thrown executor already does on the `isAlwaysAllowed` fast path
  above it. Catching it there and falling through to the pending queue
  would risk the executor running a second time once a human later
  approved the (now-duplicate) pending entry.

## Why the `SAFE`/`RISKY` design instead of a numeric risk score

A single-word binary answer is trivially parseable from a small model with
no JSON-formatting failure mode to guard against, and the fail-safe design
above only ever needs a boolean -- there's no threshold to tune, and no
"medium risk" bucket that would need its own handling. If finer-grained
risk tiers become useful later (e.g. auto-clear only, flag-but-still-queue,
deny outright), that's a real design change to `judgeActionRisk`'s return
shape, not something this pass tried to anticipate.

## Test coverage

`test/guardian-precheck.test.js`: SAFE/RISKY/unclear/empty/throwing model
replies, scanText-vs-payload prompt construction, and a circular-payload
edge case that must never throw. `test/approval-gate.test.js`: auto-approval
+ audit logging on a safe verdict, fall-through to pending on a risky
verdict or a thrown judge, off-by-default even with a judge injected, the
content-scan-always-wins rule, and the post-clearance executor-failure
propagation case. `test/approval-gate-capability.test.js`: the new
`GET /approvals/guardian-audit` route.

## Out of scope

No UI surface for Guardian-cleared history (the API exists;
Settings-side display is a separate, not-yet-scoped change), no
configurable risk threshold or model profile choice, no Guardian pre-check
on the content scan's own flag list (that list stays purely deterministic,
per the "scan always wins" design above).
