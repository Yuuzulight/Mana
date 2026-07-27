# Issue 146: Can Mana Consume External MCP Servers?

## Question

`node-bot/mcp-server.js` exposes Mana's own capabilities *as* an MCP
server for other clients. Does Mana have any way to act as an MCP
*client* -- connecting outward to a third-party MCP server to use its
tools?

## Finding: No -- but the SDK already installed has everything needed to build it

Audited `node-bot/mcp-server.js` (217 lines) and every other reference to
`@modelcontextprotocol/sdk` in the repo: the only imports anywhere are
`@modelcontextprotocol/sdk/server/mcp.js` and
`@modelcontextprotocol/sdk/server/stdio.js` -- both *server*-side. There is
no `Client` import, no outbound-connection code, nothing that registers a
remote MCP server's tools into Mana's own tool set.

That said, `@modelcontextprotocol/sdk` (already a dependency, v1.29.0)
ships a full `client/` module out of the box: `stdio.js`, `sse.js`,
`streamableHttp.js`, `websocket.js` transports, plus `auth.js`. Building an
MCP client needs **no new dependency** -- just wiring the SDK's existing
client APIs, the same way `mcp-server.js` already wires its server APIs.

## What a client integration would need (scoped, not built here)

1. **Server registration/config.** A small store (same shape as
   `presets-store.js`/`plugin-settings-store.js`) listing configured
   remote MCP servers: name, transport (stdio command, or an SSE/HTTP
   URL), and which of its tools are allowed through.
2. **Per-server tool filtering.** An explicit allowlist per server, not
   "trust everything it advertises" -- mirrors `ai/tool-policy.js`'s
   existing philosophy for the one local tool Mana has today
   (`read_file`): narrow and explicit rather than broad and implicit.
3. **A safety boundary on environment/secrets.** An external MCP server
   -- especially a stdio one, spawned as a child process -- should not
   inherit Mana's full `process.env` by default (API keys, tokens). Needs
   an explicit env-var allowlist per configured server, analogous to how
   `tool-policy.js` scopes `read_file` to a single allowed root directory
   rather than the whole filesystem.
4. **A path into the model's tool-calling loop.** Right now the *only*
   place a tool reaches the model at all is
   `llama-server-runtime.js`'s `runToolAwareReply` (issue #51) --
   deliberately single-round, single-tool (`read_file`), opt-in via
   `MANA_TOOL_CALLING_ENABLED`, scoped to one model profile. An MCP
   client's tools would need to register into that same mechanism (or its
   future multi-round extension) rather than a second, parallel
   tool-calling path.
5. **Approval gate integration.** Issue #152 (approval gate for
   agent-authored content) is a natural fit for gating a *newly configured*
   remote server the first time it's used, similar to how a new skill or
   generated script would need approval -- connecting to an arbitrary
   third party's MCP server is a trust decision, not a read-only local
   action.

## Recommendation

Worth building as a follow-up, but only once (4) above -- the tool-calling
loop -- supports more than one tool/round; wiring MCP client tools into a
loop that can only ever use exactly one hardcoded tool wouldn't actually
let a remote server's tools do anything useful yet. Scoping this now,
rather than building it, avoids landing dead infrastructure ahead of its
actual prerequisite.

## Out of scope here (per the issue)

Building the full client integration -- this issue is the investigation
and scoping only. A follow-up issue should be opened once the
tool-calling loop above is ready to host it.
