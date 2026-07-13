/*
Mana as an MCP server (Phase 1 of docs/roadmap/issue-42-mcp-support.md).

Exposes a subset of Mana's existing capabilities as Model Context Protocol
tools over stdio, so MCP clients (Claude Desktop, Claude Code, etc.) running
on the same machine can call them. Tool handlers reuse the same functions as
the matching HTTP routes in capabilities/ffxiv-market-capability.js and
capabilities/web-access-capability.js rather than duplicating logic.

Opt-in: disabled unless MANA_MCP_SERVER_ENABLED=1. Run directly with
`npm run mcp` (equivalent to `node mcp-server.js`) so an MCP client can spawn
it as a subprocess.
*/

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const { version: SERVER_VERSION } = require("./package.json");
const {
  UNIVERSALIS_DEFAULT_WORLD,
  getUniversalisMarketSummary: defaultGetUniversalisMarketSummary,
  resolveFfxivItemByName: defaultResolveFfxivItemByName,
} = require("./ffxiv-market");
const {
  fetchPage: defaultFetchPage,
  searchWeb: defaultSearchWeb,
  wikiLookup: defaultWikiLookup,
} = require("./tools/web-access");

const SERVER_NAME = "mana";

function isMcpServerEnabled(env = process.env) {
  return String(env.MANA_MCP_SERVER_ENABLED || "").trim() === "1";
}

function textResult(value) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function errorResult(error) {
  return {
    content: [
      { type: "text", text: `Error: ${error?.message || String(error)}` },
    ],
    isError: true,
  };
}

function registerFfxivMarketTool(server, deps) {
  const resolveFfxivItemByName =
    deps.resolveFfxivItemByName || defaultResolveFfxivItemByName;
  const getUniversalisMarketSummary =
    deps.getUniversalisMarketSummary || defaultGetUniversalisMarketSummary;
  const defaultWorld = deps.UNIVERSALIS_DEFAULT_WORLD || UNIVERSALIS_DEFAULT_WORLD;

  server.registerTool(
    "ffxiv_market_lookup",
    {
      title: "FFXIV market lookup",
      description:
        "Look up current Universalis marketboard prices for a Final Fantasy XIV item, by name or numeric item id.",
      inputSchema: {
        itemName: z
          .string()
          .optional()
          .describe('Item name to search for, e.g. "Iron Ore"'),
        itemId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Numeric XIVAPI item id, if already known"),
        world: z
          .string()
          .optional()
          .describe(`FFXIV world/server name (default "${defaultWorld}")`),
      },
    },
    async ({ itemName, itemId, world } = {}) => {
      try {
        if (!itemId && !itemName) {
          throw new Error("itemId or itemName is required");
        }
        const targetWorld = world || defaultWorld;
        let resolvedItem = null;
        let resolvedItemId = itemId || null;
        let resolvedItemName = itemName || "";
        if (!resolvedItemId) {
          resolvedItem = await resolveFfxivItemByName(itemName);
          resolvedItemId = resolvedItem.itemId;
          resolvedItemName = resolvedItem.name;
        }
        const summary = await getUniversalisMarketSummary(
          targetWorld,
          resolvedItemId,
          resolvedItemName,
        );
        return textResult({ ...summary, resolvedItem });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

function registerWebAccessTools(server, deps) {
  const searchWeb = deps.searchWeb || defaultSearchWeb;
  const fetchPage = deps.fetchPage || defaultFetchPage;
  const wikiLookup = deps.wikiLookup || defaultWikiLookup;

  server.registerTool(
    "web_search",
    {
      title: "Web search",
      description:
        "Search the web via Mana's local SearXNG instance and return matching results.",
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("Max results to return (1-10, default 5)"),
      },
    },
    async ({ query, limit } = {}) => {
      try {
        const results = await searchWeb(query, { limit });
        return textResult({ query, results });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "web_read",
    {
      title: "Read web page",
      description:
        "Fetch a public URL and return its extracted page text. SSRF-guarded: private/internal hosts are refused.",
      inputSchema: {
        url: z.string().min(1).describe("Full URL to fetch"),
      },
    },
    async ({ url } = {}) => {
      try {
        const page = await fetchPage(url);
        return textResult(page);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "wiki_lookup",
    {
      title: "Wikipedia lookup",
      description: "Look up a Wikipedia page by search term and return a short extract.",
      inputSchema: {
        term: z.string().min(1).describe("Wikipedia search term"),
      },
    },
    async ({ term } = {}) => {
      try {
        const entry = await wikiLookup(term);
        if (!entry) {
          return textResult({ error: "no matching Wikipedia page" });
        }
        return textResult(entry);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

function createMcpServer(deps = {}) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerFfxivMarketTool(server, deps);
  registerWebAccessTools(server, deps);
  return server;
}

async function startMcpServerStdio(deps = {}) {
  const env = deps.env || process.env;
  if (!isMcpServerEnabled(env)) {
    throw new Error(
      "MCP server is disabled. Set MANA_MCP_SERVER_ENABLED=1 to enable it.",
    );
  }
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

if (require.main === module) {
  startMcpServerStdio().catch((error) => {
    process.stderr.write(`Mana MCP server failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createMcpServer,
  isMcpServerEnabled,
  startMcpServerStdio,
};
