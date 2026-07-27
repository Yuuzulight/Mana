# Issue 152: Approval Gate for Agent-Authored Content

## Goal

A shared, lightweight approval primitive that #140 (skills layer) and #142
(programmatic tool calling) can both hook into, so agent-authored content
(a skill file, a generated script) surfaces for a quick approve/deny before
it's trusted, rather than landing silently. Explicitly scoped to
agent-*authored* content, not a general command-level gate for every tool
call Mana already makes (web search, memory reads, etc.) -- see the issue's
"out of scope" section.

## Neither #140 nor #142 had a live autonomous caller yet

Auditing both before building: `skills-store.js`'s own comment already
flags this --

> Deliberately no agent-autonomous write loop here -- that's explicitly out
> of scope until the read/prune path is proven, and any future
> approval-gate work (issue #152) sits in front of whoever calls this, not
> inside it.

and `script-runner.js` (issue #142) is "Deliberately not wired into any
specific capability yet." So the one real write path to gate today is
`POST /skills` (skills-capability.js) -- a human (or Mana, via a person
calling it) creating a skill. `script-runner.js`'s `runToolScript` gets no
new caller here either; whenever it's wired into a real capability, that
capability should call `approvalGate.requestApproval('generated-script-run',
...)` before invoking it, the same way `skills-capability.js` now does for
skill writes.

## Status: Implemented (`node-bot/approval-gate.js` + `capabilities/approval-gate-capability.js`, core, always on)

- **`createApprovalGate({dataDir, contentScanEnabled})`**: same
  injectable-`dataDir` pattern as `acp-memory-store.js`/`cron-scheduler.js`.
  `registerExecutor(actionType, fn)` registers the real write function for
  an action type once at wiring time -- a pending request only stores a
  plain-JSON-serializable payload, never a closure. `requestApproval
  (actionType, {summary, payload, scanText})` runs the executor immediately
  if that action type is already always-allowed; otherwise it creates a
  pending request and returns `{status: "pending", requestId}` -- the write
  does not happen until a human decides.
- **Three decisions**: `allow-once` (runs the executor this one time only),
  `always-allow` (persists the action type to `always-allow.json` under
  `dataDir`, so it never nags again for that type), `deny` (drops the
  pending request, executor never runs).
- **Optional content scan, off by default**: `scanContent(text)` checks a
  handful of keyword/regex heuristics (shell execution, filesystem writes,
  `curl | sh`-shaped remote code fetch, credential-like strings) and
  attaches any matches as `flags` on the pending request for the human
  approver's attention. Never auto-denies -- it's a tripwire, not a
  sandbox, matching the issue's "simple keyword/pattern heuristics" scope.
- **Routes**: `GET /approvals/pending`, `POST /approvals/:id/decide` (body:
  `{decision}`).
- **`skills-capability.js`'s `POST /skills`** now routes through
  `approvalGate.requestApproval("skill-write", ...)` instead of calling
  `skillsStore.createSkill` directly. A 202 response means "queued for
  review," a 201 means the gate approved it (either because `skill-write`
  is already always-allowed, or -- once a Settings UI exists -- because a
  human just approved it).

## Deliberate simplifications

- **No approval UI page yet.** The routes exist; wiring a chat-card/
  Settings-page UI for reviewing pending requests is left for whenever a UI
  pass touches Settings next -- the same gap `cron-scheduler`'s job UI and
  `telegram-bridge`'s approval UI both have today.
- **Pending requests are in-memory only**, not persisted across a server
  restart -- they represent "waiting on a live human decision right now,"
  not a durable queue. `always-allow` state *is* persisted (JSON under
  `dataDir`), since that's meant to survive restarts.
- **`script-runner.js` untouched.** No fake caller was added just to
  exercise the gate -- see the "no live caller" section above.

## Verified

- `node-bot/test/approval-gate.test.js` (9 tests): pending-by-default,
  allow-once running the executor exactly once without persisting trust,
  always-allow persisting and short-circuiting future requests (including
  across a fresh gate instance sharing the same `dataDir`), deny dropping
  the request without running the executor, unknown-requestId handling, a
  clear error when no executor is registered, and the content-scan
  heuristics (off by default, each pattern recognized independently).
- `node-bot/test/approval-gate-capability.test.js` (5 tests): the HTTP
  routes end to end, an invalid decision value rejected, an unknown
  request id returning 404, and `getHealth`'s pending count.
- `node-bot/test/skills-capability.test.js` (11 tests, 2 new/updated):
  `POST /skills` now returns 201 with the created skill once the gate
  approves it, and 202 with the gate's pending response when it doesn't.
- `node-bot/test/health-components.test.js` (3 tests): updated snapshot for
  the new `approvalGate` component key.
