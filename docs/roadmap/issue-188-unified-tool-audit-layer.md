# Issue 188: Unified Tool-Execution Audit/Approval Layer

## Goal

Inspired by comparing Mana against moeru-ai/airi's `computer-use-mcp`,
which treats browser control and remote tools as first-class entries in
one MCP tool surface with one approval queue and one audit log, rather
than each capability gating itself separately. Mana already had the three
pieces this unifies -- `ai/tool-policy.js`, `runToolAwareReply` (#183),
`approval-gate.js` (#152), and `plugins/browser-automation` (#150) -- but
they were separate. This issue is the layer on top, built once #169
(outbound MCP client) existed to unify with.

## Status: Implemented (core, opt-in via the existing `MANA_TOOL_CALLING_ENABLED`)

1. **#169 built first, unchanged** -- this issue's own prerequisite.
2. **`browser-automation`'s actions register alongside `read_file` and MCP
   tools.** New `plugins/browser-automation/browser-automation-tool-source.js`
   exposes navigate/snapshot/click/type as OpenAI-function-shaped tool
   schemas (`browser_automation__<action>`), and
   `buildToolPolicyWithBrowserAutomation(basePolicy, source)` merges them
   into the same `{tools, isKnownTool, executeTool}` shape #169's
   `buildToolPolicyWithMcp` already established -- rather than modifying
   `tool-policy.js`'s internals a second time, following the same
   compositional-merge precedent #169 set. It reuses
   `plugins/browser-automation/index.js`'s own exported `getSession()`
   singleton, so a tool-calling-initiated browser action and an
   HTTP-route-initiated one share the same live tab, not two Chromium
   instances.
3. **Every tool call routes through `approval-gate.js` -- at the right
   granularity.** Read carefully, not literally: gating *every individual
   call* on a human would freeze `runToolAwareReply`'s loop mid-reply
   waiting on a person, which nothing else in this codebase does (`read_file`
   has never needed approval; an MCP server's tools are approved once, at
   registration, per #169 -- not re-approved per call). The coherent
   reading, matching `approval-gate.js`'s own `isAlwaysAllowed` design: the
   *first* tool-calling use of browser-automation requires approval
   (`browser-automation-tool-use` actionType); once a human "always-allow"s
   it, subsequent navigate/click/type/snapshot calls execute immediately.
   An unapproved call throws an error naming the pending request id, which
   flows back through `runToolAwareReply`'s existing tool-error-to-the-
   model path (the same path a `ToolPolicyError` already takes) rather than
   silently blocking.
   `read_file` and MCP tools deliberately keep their existing trust
   boundaries unchanged (path-scoping; per-server registration approval)
   rather than retroactively gating already-shipped, already-narrow
   behavior nobody asked to change -- see Deliberate simplifications.
4. **One shared audit/trace log for every tool call.** New
   `node-bot/tool-call-log.js`: JSON-lines, same "one line per event"
   pattern `windows-launcher`'s `voice-crash.log` already uses.
   `wrapWithToolCallLog(policy, log)` wraps any `{tools, isKnownTool,
   executeTool}`-shaped policy so every call is logged (name, capped args,
   ok/error, duration) regardless of source -- applied *last* in
   `server.js`'s merge chain (base -> +MCP -> +browser-automation -> +log),
   so this one wrap catches everything. New read-only route
   `GET /tool-calls/recent` (`capabilities/tool-call-log-capability.js`)
   -- "one place to see what any tool actually did," not just a file
   nobody looks at.

## Wiring (`server.js`)

`replyMaybeWithTools` now builds the merged policy fresh per reply:
`buildToolPolicyWithMcp` (#169) -> conditionally
`buildToolPolicyWithBrowserAutomation` (only when the plugin is enabled in
Settings > Plugins, checked via the newly-exported `isPluginEnabled` from
`capabilities/registry.js` -- the same gate every other browser-automation
entry point already respects) -> `wrapWithToolCallLog`.

## Deliberate simplifications

- **`read_file` and already-registered MCP tools are not retroactively
  gated per-call.** They already have their own trust boundary (path
  scoping; one-time server-registration approval). Only browser-automation
  -- a materially larger risk surface (arbitrary navigation, arbitrary
  click/type) newly being exposed as a tool here -- gets the first-use
  approval gate.
- **No dedup of duplicate pending approval requests.** If the model
  attempts a browser-automation tool call multiple times before a human
  decides, each attempt creates its own pending entry for the same
  actionType. Harmless (approving any one makes all future calls succeed
  immediately via `isAlwaysAllowed`), just a little visual clutter in
  `/approvals/pending` at worst -- not worth the bookkeeping to prevent.
- **Desktop-level control (window focus, screenshot, keyboard/mouse
  injection) stays explicitly out of scope**, per the issue's own text --
  a much larger, separate Windows-specific surface with no current use
  case.
- **No log rotation/size cap on `tool-calls.jsonl`.** Matches the existing
  precedent `voice-crash.log` already sets (also unbounded-append); args
  are capped per-entry (2000 chars) so one call can't dominate the file,
  but the file itself isn't rotated.

## Out of scope

- Remote/cloud MCP servers beyond what #169 itself scopes.
- A Settings UI for reviewing `/tool-calls/recent` or approving pending
  requests visually -- routes exist; UI is left for a future Settings pass,
  same gap several other capabilities already have.

## Verified

- `node-bot/test/tool-call-log.test.js` (7 tests, new): append/readRecent,
  args truncation, `wrapWithToolCallLog`'s success/failure logging and
  passthrough of `tools`/`isKnownTool`.
- `node-bot/test/tool-call-log-capability.test.js` (3 tests, new): the
  route's shape, `?limit`, and `getHealth`.
- `plugins/browser-automation/test/browser-automation-tool-source.test.js`
  (6 tests, new): tool schema shape, name-prefix detection, first-use
  approval gating (and that the browser session is never touched before
  approval), real execution once always-allowed (against the plugin's own
  fake-page test harness, not a real browser), rejecting an unrecognized
  tool name, and `buildToolPolicyWithBrowserAutomation`'s merge/routing.
- `node-bot/test/health-components.test.js`: updated component-key
  snapshot for `toolCallLog`.
- Full regression pass: `node-bot`'s 68 test files plus
  `plugins/browser-automation`'s test files (73 files total, one process
  per file) -- no regressions.
