# Issue 183: Multi-Round Tool-Calling Loop

## Goal

Turn `ai/llama-server-runtime.js`'s `runToolAwareReply` (issue #51) from a
fixed two-call sequence into a bounded loop -- the actual prerequisite for
issue #169 (outbound MCP client support). A single-round loop can't let a
remote MCP tool's results inform a second tool call, which is most of the
point of giving Mana more tools to call.

## What was actually broken

`runToolAwareReply` called the model once to see if it wanted tools,
executed them, then called the model a second time for a final answer --
if that *second* response also contained `tool_calls`, they were never
even inspected, let alone executed. Confirmed by reading the code before
touching it (not just trusting the issue's own description): the loop
body ran exactly twice, with no branch that could ever call `complete()`
a third time.

## Status: Implemented (`ai/llama-server-runtime.js`, core, opt-in via existing `MANA_TOOL_CALLING_ENABLED`)

- **The `for` loop**: up to `maxRounds` (`MANA_TOOL_CALLING_MAX_ROUNDS`,
  default 4) iterations. Each round calls the model with tools enabled;
  if it returns no `tool_calls`, that's a real answer and the loop exits
  immediately (the common, single-round case is unchanged in shape --
  still exactly 1 completion call when the model doesn't want a tool at
  all, matching the pre-existing test `"runToolAwareReply skips the tool
  round entirely when the model doesn't request one"`).
- **Per-round tool-call cap** (`maxToolCallsPerRound`,
  `MANA_TOOL_CALLING_MAX_CALLS_PER_ROUND`, default 5): nothing bounded
  this before -- a model requesting 20 simultaneous tool calls in one
  response would have executed all 20. Only the first N execute; the rest
  are silently dropped for that round (a well-behaved model won't hit
  this in practice, since it can just ask again next round).
- **Consecutive-tool-error cap** (hardcoded `MAX_CONSECUTIVE_TOOL_ERRORS =
  3`, not exposed as an env var -- this is a sanity backstop, not a tuning
  knob anyone should need to raise): if the model keeps calling a broken
  tool, the loop stops after 3 consecutive failures instead of burning
  every remaining round on the same error.
- **Wall-clock budget** (`maxMs`, `MANA_TOOL_CALLING_MAX_MS`, default
  60000): checked after each round's own completion call resolves (using
  the time actually spent, not a pre-emptive estimate), so a round that's
  already slow doesn't get to start another one.
- **Forced final answer on any cap**: whenever a cap is hit, one more
  completion call fires with `tool_choice: "none"` and `tools` omitted
  entirely from the request body -- the model *cannot* request another
  tool call here, it must synthesize an answer from whatever's already in
  the conversation. This guarantees the loop never returns a blank or
  synthetic fallback string; the reply is always something the model
  actually generated.
- **`server.js`'s tool-calling log line** now includes the round count
  (`Mana tool-calling (N round(s)): ...`) since that's genuinely useful
  observability once rounds can vary, matching how Best-of-N's log
  already reports which candidate the judge picked.

## Deliberate simplifications

- **Expanding the tool surface is explicitly out of scope.** `ai/tool-
  policy.js` still has exactly one tool (`read_file`) -- this issue is the
  loop mechanism only, per its own scope. Adding more tools (or #169's
  remote MCP tools) is separate follow-on work that plugs into the same
  `toolPolicy.tools`/`executeTool` shape without further changes here.
- **No approval-gate (#152) wiring yet.** The only tool today is
  read-only, so there's nothing to gate. Noted in #183's own issue text
  as something whoever adds the next (possibly write/execute-shaped) tool
  should wire in, not something to build speculatively now for a tool
  that doesn't exist.
- **Still scoped to the "default" profile.** `server.js`'s existing
  `toolCallingEnabled && normalizedModelProfile === "default"` gate is
  unchanged -- this only touches the loop mechanism, not which profiles
  use it.

## Verified

- `node-bot/test/llama-server-runtime.test.js` (33 tests, 5 new):
  - Multi-round: the model requesting tools across two separate rounds
    before giving a real answer, confirming a third completion call
    actually happens and both tool rounds execute.
  - Round-cap exhaustion: a model that *always* wants another tool hits
    `maxRounds` and gets one forced `tool_choice: "none"` call instead of
    looping forever; asserts the exact `tool_choice`/`tools` shape of
    each request body.
  - Per-round call cap: 3 requested tool calls in one round, capped to 1
    actual execution.
  - Consecutive-error cap: a tool that always throws stops the loop after
    3 failures (with a high `maxRounds` so the round cap isn't what
    actually ends it), then forces a final answer.
  - Wall-clock budget: a fake `nowMs` clock advancing 40s per round,
    `maxMs: 60000` -- confirms the loop stops after the round where the
    *post-call* clock first exceeds the deadline (not a naive "before
    round" check), and that this is genuinely mid-`maxRounds`, not just
    hitting the round cap coincidentally.
  - All pre-existing single-round tests (tool execution, policy-error
    reporting, unknown-tool rejection, no-tool-requested short-circuit)
    pass unchanged -- confirms the common case's shape didn't regress.
- `node-bot/test/server-routes.test.js`: full regression pass.
