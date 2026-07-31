// A "session_search" tool: lets the model search past conversations by
// keyword instead of only ever relying on the curated MEMORY.md-style
// summary (acp-memory-store.js's buildPromptMemory/getRelatedFacts), which
// only keeps a compacted gist, not the raw text. Same merge shape
// #169/#188/#198 already established (buildToolPolicyWithMcp/
// buildToolPolicyWithMemory).
const SESSION_SEARCH_TOOL_PREFIX = "session_search__";

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: `${SESSION_SEARCH_TOOL_PREFIX}query`,
      description:
        "Search past conversations when the user references something from an earlier session that isn't in the current memory summary (e.g. \"what did I say about X\", \"where did we leave off with Y\"). Matches both by keyword (supports FTS5 query syntax: phrases in quotes, AND/OR/NOT, and prefix* matching) and, when available, by meaning -- so a differently-worded question about the same topic can still surface a match.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keywords or FTS5 query syntax, e.g. \"docker deployment\", \"kubernetes OR swarm\", \"\\\"exact phrase\\\"\", \"deploy*\".",
          },
          scope: {
            type: "string",
            enum: ["this_session", "all_sessions"],
            description:
              "\"this_session\" (default): only search the current conversation. \"all_sessions\": search across every past session too.",
          },
          sort: {
            type: "string",
            enum: ["relevance", "newest", "oldest"],
            description:
              "\"relevance\" (default): best textual match first. \"newest\"/\"oldest\": for \"where did we leave X\" vs \"how did X start\" questions.",
          },
        },
        required: ["query"],
      },
    },
  },
];

function isSessionSearchToolName(name) {
  return typeof name === "string" && name.startsWith(SESSION_SEARCH_TOOL_PREFIX);
}

// options.acpMemoryStore: required.
// options.sessionId: bound at creation time, not trusted from model-supplied
// args -- same principle memory-tool-source.js already follows.
function createSessionSearchToolSource(options = {}) {
  const acpMemoryStore = options.acpMemoryStore;
  const sessionId = options.sessionId || null;
  if (!acpMemoryStore) {
    throw new Error("acpMemoryStore is required");
  }

  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  async function executeTool(qualifiedName, args) {
    const action = qualifiedName.slice(SESSION_SEARCH_TOOL_PREFIX.length);
    if (action !== "query") {
      throw new Error(`unknown session_search tool: ${qualifiedName}`);
    }
    const scope = args?.scope === "all_sessions" ? "all_sessions" : "this_session";
    const results = await acpMemoryStore.searchSessions({
      query: args?.query,
      sort: args?.sort,
      sessionId: scope === "this_session" ? sessionId : undefined,
      limit: 20,
    });
    return JSON.stringify({ results });
  }

  return { listToolSchemas, executeTool, isKnownToolName: isSessionSearchToolName };
}

async function buildToolPolicyWithSessionSearch(basePolicy, sessionSearchToolSource) {
  return {
    tools: [...basePolicy.tools, ...sessionSearchToolSource.listToolSchemas()],
    isKnownTool: (name) => basePolicy.isKnownTool(name) || isSessionSearchToolName(name),
    executeTool: async (name, args) => {
      if (isSessionSearchToolName(name)) return sessionSearchToolSource.executeTool(name, args);
      return basePolicy.executeTool(name, args);
    },
  };
}

module.exports = {
  SESSION_SEARCH_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isSessionSearchToolName,
  createSessionSearchToolSource,
  buildToolPolicyWithSessionSearch,
};
