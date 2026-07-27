# Issue 169: Outbound MCP Client Support

## Goal

`node-bot/mcp-server.js` only ever exposes Mana's own capabilities *as* an
MCP server. This issue gives her the other direction: connecting outward to
a third-party MCP server to use its tools. Scoped by issue #146's
investigation, explicitly blocked until the tool-calling loop supported
more than one hardcoded tool -- unblocked now that #183 shipped that loop.

## Status: Implemented (`node-bot/mcp-client-registry.js`, core, opt-in via the existing `MANA_TOOL_CALLING_ENABLED`)

Covers all 5 items #146/#169 scoped:

1. **Config store.** `createMcpClientRegistry({dataDir, approvalGate, sdk})`
   -- same injectable-`dataDir` pattern as `presets-store.js`/
   `telegram-bridge.js`. Persists `{id, name, transport, allowedTools,
   registeredAt}` per server.
2. **Per-server tool allowlisting.** `registerServer` requires a non-empty
   `allowedTools` array; `listApprovedToolSchemas()` only ever exposes
   tools on that list, even if the remote server advertises more.
3. **Environment-variable allowlist.** A stdio-spawned server's `env`
   starts from the SDK's own `getDefaultEnvironment()` (already a safe,
   minimal OS-variable set, not `process.env`), then merges in only the
   names the server's config explicitly lists (`envAllowlist`) -- e.g. an
   API key a specific server genuinely needs, opted into per-server, never
   inherited by default.
4. **Registration into the tool-calling loop.** `buildToolPolicyWithMcp
   (basePolicy, mcpRegistry)` merges `ai/tool-policy.js`'s local tools with
   the registry's currently-reachable MCP tools into one object matching
   the exact `{tools, isKnownTool, executeTool}` shape
   `runToolAwareReply` (#183) expects, built fresh per reply in
   `server.js`'s `replyMaybeWithTools` (MCP discovery is async;
   `tool-policy.js`'s own `tools` array stays a plain synchronous list,
   untouched).
5. **Approval gate integration.** `registerServer` routes through
   `approval-gate.js` (#152) before a server is ever usable. Each attempt
   gets its own uniquely-scoped `actionType`
   (`mcp-server-register:<generated-id>`) rather than one shared
   actionType for every registration -- approving one server's
   registration must never silently pre-approve a later, materially
   different server via the gate's "always-allow" path. The existing
   generic `/approvals/pending` and `/approvals/:id/decide` routes handle
   the decision with zero new UI needed.

## A real bug found and fixed along the way

`llama-server-runtime.js`'s tool-calling loop called
`toolPolicy.executeTool(name, args)` **without awaiting it**, then
immediately did `String(result)`. Harmless for the one existing tool
(`read_file`, synchronous), but an MCP tool call is inherently async
(network or child-process I/O) -- calling it through the old code would
have produced the literal string `"[object Promise]"` as the tool's
result, silently corrupting every MCP-sourced tool call. Fixed with one
`await` (backward-compatible: awaiting a non-Promise value is a no-op, so
`read_file` and every other existing sync tool behave identically).
Verified with a dedicated test asserting the real resolved value comes
back, not `"[object Promise]"`.

## New routes (`capabilities/mcp-client-capability.js`)

- `GET /mcp-clients/servers` -- list currently-approved servers.
- `POST /mcp-clients/servers` -- `{name, transport, allowedTools}`,
  returns the approval-gate result (almost always `{status: "pending",
  requestId}` on a fresh registration).
- `DELETE /mcp-clients/servers/:id` -- removes a server and disconnects
  its cached client.

## Deliberate simplifications

- **Two transports, not four.** The SDK ships stdio/sse/streamableHttp/
  websocket client transports; this only wires stdio (local child
  process) and streamableHttp (the current MCP spec's recommended remote
  transport, superseding SSE) -- narrower than the SDK's full surface on
  purpose, matching `tool-policy.js`'s own "narrow and explicit"
  philosophy this issue extends. SSE/websocket can be added the same way
  later if a real server needs them.
- **Tool discovery is fresh per reply, not cached.** A server's advertised
  tools can change, and the total tool count is small enough that
  re-listing over an already-open connection costs little. An unreachable
  server is skipped (logged, not thrown) rather than failing the whole
  reply -- same resilience philosophy `replyMaybeWithTools` already has
  for tool-calling as a whole.
- **No Settings UI for server registration.** Routes exist; a UI pass is
  left for whenever Settings > Plugins gets touched next, same gap
  `telegram-bridge`/`cron-scheduler` already have.
- **No new dependency.** `@modelcontextprotocol/sdk` (v1.29.0) was already
  installed for `mcp-server.js`'s server-side use; its `client/` module
  ships in the same package.

## Out of scope

- Desktop/browser-automation tools registering into this same merged
  policy -- that's issue #188 (unified tool-execution audit/approval
  layer), explicitly deferred as a separate follow-up on top of this.
- Remote server discovery/marketplace -- servers are configured
  one-by-one, explicitly, by whoever owns Mana.

## Verified

- `node-bot/test/mcp-client-registry.test.js` (12 tests, new): URL/
  transport validation, approval-gate-gated registration, per-registration
  unique actionType (approving one server never pre-approves a different
  later one), remove, tool-schema listing (allowlist filtering, correct
  `mcp__<server>__<tool>` naming), skipping an unreachable server, tool
  execution routing (including rejecting an unknown server or a
  disallowed tool), stdio env-var allowlisting, and
  `buildToolPolicyWithMcp`'s merge/routing behavior -- all against an
  injected fake SDK (`{Client, StdioClientTransport,
  StreamableHTTPClientTransport, getDefaultEnvironment}`), no real
  process spawned or socket opened.
- `node-bot/test/mcp-client-capability.test.js` (5 tests, new): the three
  routes' shapes, including the pending -> decide -> listed flow through
  the real `approval-gate.js`, and `getHealth`.
- `node-bot/test/llama-server-runtime.test.js` (34 tests, 1 new): the new
  async-`executeTool` regression test, confirming the loop now resolves a
  real async tool result instead of stringifying an unresolved Promise.
- `node-bot/test/health-components.test.js`: updated component-key
  snapshot for `mcpClients`.
- Full `node-bot` suite (68 files, one process per file): no regressions.
