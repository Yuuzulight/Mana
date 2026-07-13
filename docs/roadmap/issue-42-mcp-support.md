# Issue 42: Add Model Context Protocol (MCP) Support

## Status

Phase 1 is implemented: `node-bot/mcp-server.js` exposes `ffxiv_market_lookup`,
`web_search`, `web_read`, and `wiki_lookup` as MCP tools over stdio, reusing
the same functions as the matching HTTP routes. It is opt-in via
`MANA_MCP_SERVER_ENABLED=1` and disabled by default; Doctor reports its
status. Run it with `npm run mcp` (from `node-bot/`) so an MCP client (Claude
Desktop, Claude Code, etc.) can spawn it as a subprocess. Phase 2 (Mana as an
MCP client) remains unstarted, see below.

## Goal

Let Mana participate in the Model Context Protocol (MCP) ecosystem — start by
exposing Mana's own local capabilities as an MCP server, and scope (but not
necessarily build yet) what it would take for Mana's local LLM to consume
external MCP tools as a client.

## Why

MCP is becoming a common way AI tools interoperate (Claude Desktop, Claude
Code, and others all speak it). Mana already has a clean capability-module
boundary (`node-bot/capabilities/`, `registry.js` — see issue #13) where each
capability is `{key, registerRoutes(app, context), getHealth(context)}`. That
shape maps onto MCP tool definitions with minimal rework: the same underlying
functions the HTTP routes call (FFXIV market/crafting, web search/read,
directory scanning, etc.) can be reused as MCP tool handlers instead of
duplicating logic.

## Proposed Scope

**Phase 1 — Mana as an MCP server:**

- Stand up a local MCP server (using `@modelcontextprotocol/sdk`) that
  exposes a subset of existing capabilities as MCP tools, reusing their
  existing implementation functions rather than re-implementing them.
- Start with read-only, side-effect-free capabilities: FFXIV market/crafting
  and web access (search/read) are the most direct fits.
- Opt-in via env var (matching the existing `MANA_ALLOW_REMOTE_AI`-style
  opt-in precedent), disabled by default, with a Doctor check reporting its
  status.

**Phase 2 — Mana as an MCP client (exploratory, separate follow-up issue):**

- Today, Mana's local LLM runtime (`node-bot/ai/llama-server-runtime.js`)
  has no tool-calling loop. Replies are built by stuffing context from a
  regex/heuristic intent classifier (`textLooksLikeMarketQuestion`, etc. in
  `server-routes.js`) directly into the prompt — the model never requests a
  tool call.
- Making Mana consume external MCP servers would first require:
  (a) invoking llama.cpp/llama-server with a tool-calling-capable chat
  template (`--jinja`; Qwen3/Qwen2.5-Coder templates support this to
  varying degrees, needs verification), and
  (b) an actual tool-call loop in the runtime.
- This is real, separate work — don't block phase 1 on it. File as its own
  issue once phase 1 ships and local-model tool-calling reliability has
  been evaluated.

## Open Questions

- **Transport**: stdio (simplest for a local MCP client like Claude
  Desktop/Claude Code running on the same machine) vs. HTTP/SSE (would let
  the existing mobile-auth model extend to a remote MCP client)? Leaning
  stdio first, matching Mana's local-first default.
- **Auth**: stdio has no auth surface (trusted local process). An HTTP/SSE
  MCP endpoint would need to reuse Mana's existing mobile auth/token model
  rather than inventing a new one.
- Which capabilities besides FFXIV market and web access are worth exposing
  first?

## Acceptance Criteria (Phase 1)

- Mana can run as a local MCP server exposing at least the FFXIV market and
  web-access capabilities as MCP tools.
- MCP tool handlers reuse the same underlying functions as the existing
  HTTP routes — no duplicated business logic.
- MCP server startup is opt-in (disabled by default) and Doctor reports its
  status.
- README.md and relevant docs note MCP support alongside the existing
  capability list.
