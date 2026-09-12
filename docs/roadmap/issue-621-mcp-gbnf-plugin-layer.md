# Issue 621: Add GBNF Grammar-Constrained Tool Calling (MCP Already Shipped)

## Correction notice

A follow-up codebase audit (2026-09-12) found this issue's MCP-related
premise was wrong: Mana already ships both an MCP server and an MCP
client. Scope narrowed to the one part that's genuinely still missing:
GBNF grammar-constrained decoding.

## Goal

Reduce malformed tool-call failures from Mana's local models by wiring
GBNF grammar constraints into the existing tool-calling call site.

## Why

The original research assumed Mana's plugins "presumably expose ad hoc
tool-calling" with no MCP use, and proposed prototyping a plugin as a
local MCP server "to validate the integration shape." Both are already
done:

- **MCP server**: `node-bot/mcp-server.js` already exposes Mana
  capabilities (FFXIV market, web search/read, wiki lookup) as an MCP
  server over stdio via `@modelcontextprotocol/sdk`, opt-in via
  `MANA_MCP_SERVER_ENABLED=1`, documented as "Phase 1: implemented" in
  `docs/roadmap/issue-42-mcp-support.md`.
- **MCP client**: `node-bot/mcp-client-registry.js` (339 lines) already
  consumes third-party MCP servers over stdio and streamableHttp
  transports, registering `mcp__`-prefixed tools wired directly into
  `server.js`'s tool loop (lines 697 and 2090-2104).

What's genuinely still missing, confirmed absent from
`node-bot/tool-policy.js` and `node-bot/llama-server-runtime.js`: **GBNF
grammar-constrained decoding**. llama.cpp natively supports GBNF grammars
that constrain decoding token-by-token so the model can't emit invalid
JSON against a tool's schema -- this is not currently used anywhere in
Mana's tool-calling path, including for the fast/small model role where
malformed tool-call JSON is most likely.

## Proposed Scope

- Add GBNF grammar generation for existing plugin/MCP tool schemas at the
  llama.cpp call site in `llama-server-runtime.js` (or wherever inference
  requests are constructed).
- Measure malformed-tool-call rate before/after on the fast/small model
  role specifically.
- Evaluate whether a cheap deterministic/embedding-based router (before
  any LLM call) for high-frequency simple commands is worth adding ahead
  of the tool-calling loop, given the gaming-mode resource constraint --
  this part of the original research is still open and unaffected by the
  MCP correction above.

## Acceptance Criteria

- Measured reduction in malformed/invalid tool-call JSON from at least
  the fast/small model role after adding GBNF grammars.
- No regression to the existing MCP server/client functionality.

## Related

`docs/roadmap/issue-42-mcp-support.md` (MCP, already shipped).
`docs/roadmap/oss-inspiration-survey-2026-09.md`.
