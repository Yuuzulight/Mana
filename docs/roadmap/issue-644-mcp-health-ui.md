# Issue 644: Surface MCP Server Health/Status In The Launcher UI

## Goal

Show the MCP server-health data Mana's backend already computes, instead
of it being dead data with no UI.

## Why

`node-bot`'s MCP client capability already has a working health check —
`mcpClientCapability.getHealth({ mcpClientRegistry })` returns a
registered-server count and status message (confirmed via
`node-bot/test/mcp-client-capability.test.js`). But
`windows-native-launcher/McpServerDialog.cs`, the only MCP-related UI in
either launcher, is registration-only: name, transport kind,
command/args/env, URL, allowed tools. No health, connection status, or
cost display anywhere.

Hermes Desktop's Pantheon release added an "MCP command center" with
health checks and cost overlays across all registered servers. Mana
doesn't need the cost-overlay part (no metered-API billing model for
local-first MCP servers), but the health/status half maps directly onto
data the backend already produces and simply never surfaces.

## Proposed Scope

- Add a status view (in `McpServerDialog.cs` or a new panel) listing
  every registered MCP server with live health from `getHealth()`:
  connected/disconnected, last-seen, registered-tool count.
- Surface connection errors inline (e.g. a stdio server that failed to
  spawn, an HTTP server that's unreachable) rather than failing silently.
- Not in scope: cost tracking/billing overlays — not applicable to
  Mana's local-first MCP usage.

## Acceptance Criteria

- A user can see, without leaving the launcher, which registered MCP
  servers are currently connected and which have failed, sourced from
  the existing `getHealth()` data.

## Related

`docs/roadmap/hermes-desktop-eval-2026-09.md`. Builds on the MCP
client/server work already shipped (`mcp-server.js`,
`mcp-client-registry.js`, issue #42).
