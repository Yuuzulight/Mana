// Issue #169: an outbound MCP *client* -- connecting to a third-party MCP
// server to use its tools -- complementing mcp-server.js, which only ever
// exposes Mana's own capabilities as a server. Scoped by issue #146's
// investigation; unblocked once #183 made the tool-calling loop support
// more than one hardcoded tool.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_DATA_DIR = path.join(__dirname, "data", "mcp-client-registry");
const DEFAULT_CLIENT_INFO = { name: "mana", version: "1.0.0" };
const DEFAULT_LIST_TOOLS_TIMEOUT_MS = 5000;
// Every MCP-sourced tool's schema name is prefixed this way so it can never
// collide with a local tool-policy.js tool name, and so executeTool() can
// tell at a glance which registry owns a given call.
const MCP_TOOL_PREFIX = "mcp__";

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

// Same http/https-only validation model-management.js's brain-provider
// baseUrl already uses.
function assertValidHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`url must be http:// or https://: ${rawUrl}`);
  }
  return url;
}

// Scoped to exactly two transports (stdio, and streamableHttp for remote
// servers) rather than every transport the SDK ships (sse, websocket) --
// stdio covers "run a local MCP server as a child process," streamableHttp
// is the current spec's recommended remote transport superseding SSE.
// Narrower than the SDK's full surface on purpose, matching tool-policy.js's
// own "narrow and explicit" philosophy this issue is extending.
function validateTransport(transport) {
  if (!transport || typeof transport !== "object") {
    throw new Error("transport is required");
  }
  if (transport.kind === "stdio") {
    if (!transport.command || typeof transport.command !== "string") {
      throw new Error("a stdio transport requires a command");
    }
    return {
      kind: "stdio",
      command: transport.command,
      args: Array.isArray(transport.args) ? transport.args.map(String) : [],
      // Item 3: a stdio-spawned server does not inherit Mana's full
      // process.env by default (getDefaultEnvironment() already limits
      // this to a handful of safe OS variables) -- this lists the
      // additional names, if any, the user explicitly opted to pass
      // through (e.g. an API key a specific server genuinely needs).
      envAllowlist: Array.isArray(transport.envAllowlist) ? transport.envAllowlist.map(String) : [],
    };
  }
  if (transport.kind === "http") {
    const url = assertValidHttpUrl(transport.url);
    return { kind: "http", url: url.href };
  }
  throw new Error(`unsupported transport kind: ${transport && transport.kind}`);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// options.dataDir: injectable so tests never write into node-bot's real
// data directory (same pattern as acp-memory-store.js/telegram-bridge.js).
// options.approvalGate: required -- item 5, every new server registration
// is routed through it. options.sdk: injectable {Client,
// StdioClientTransport, getDefaultEnvironment, StreamableHTTPClientTransport}
// so tests never spawn a real process or open a real socket.
function createMcpClientRegistry(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const serversPath = path.join(dataDir, "servers.json");
  const approvalGate = options.approvalGate;
  const sdk =
    options.sdk ||
    (() => {
      const { Client } = require("@modelcontextprotocol/sdk/client");
      const { StdioClientTransport, getDefaultEnvironment } = require("@modelcontextprotocol/sdk/client/stdio.js");
      const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
      return { Client, StdioClientTransport, getDefaultEnvironment, StreamableHTTPClientTransport };
    })();
  const now = options.now || (() => new Date().toISOString());
  const makeId = options.makeId || (() => crypto.randomUUID());
  const listToolsTimeoutMs = Number(options.listToolsTimeoutMs) || DEFAULT_LIST_TOOLS_TIMEOUT_MS;

  // Connected clients (one persistent connection per server, lazily
  // established on first need) live only in memory, same reasoning as
  // llama-server-runtime.js's own lazy-started, cached server process --
  // a fresh node-bot process starts with nothing connected.
  const connectedClients = new Map();

  function ensureDir() {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  function readServers() {
    ensureDir();
    return readJson(serversPath, []);
  }
  function writeServers(list) {
    ensureDir();
    writeJson(serversPath, list);
  }

  function listServers() {
    return readServers();
  }

  function getServer(id) {
    return readServers().find((s) => s.id === id) || null;
  }

  // Item 5: routed through the approval gate. Each attempt gets its own
  // uniquely-scoped actionType (mcp-server-register:<id>) rather than one
  // shared actionType for every registration -- approving one server's
  // registration must never silently pre-approve a later, different
  // server's registration via the gate's "always-allow" path. Since a
  // server is registered once and then just exists, "allow-once" and
  // "always-allow" are functionally identical here; the distinct
  // actionType is what actually matters.
  async function registerServer({ name, transport, allowedTools } = {}) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("name is required");
    const validatedTransport = validateTransport(transport);
    const cleanAllowedTools = Array.isArray(allowedTools)
      ? [...new Set(allowedTools.map(String).filter(Boolean))]
      : [];
    if (!cleanAllowedTools.length) {
      throw new Error("allowedTools must list at least one tool name");
    }
    if (!approvalGate) {
      throw new Error("an approvalGate is required to register an MCP server");
    }

    const id = makeId();
    const actionType = `mcp-server-register:${id}`;
    approvalGate.registerExecutor(actionType, async () => {
      const servers = readServers();
      servers.push({
        id,
        name: cleanName,
        transport: validatedTransport,
        allowedTools: cleanAllowedTools,
        registeredAt: now(),
      });
      writeServers(servers);
      return { serverId: id };
    });

    return approvalGate.requestApproval(actionType, {
      summary: `Register MCP server "${cleanName}" (${validatedTransport.kind}), allowing tools: ${cleanAllowedTools.join(", ")}`,
      payload: null,
    });
  }

  function removeServer(id) {
    const servers = readServers();
    const next = servers.filter((s) => s.id !== id);
    if (next.length === servers.length) return false;
    writeServers(next);
    disconnect(id);
    return true;
  }

  async function getConnectedClient(server) {
    if (connectedClients.has(server.id)) return connectedClients.get(server.id);

    const client = new sdk.Client(DEFAULT_CLIENT_INFO, { capabilities: {} });
    let transport;
    if (server.transport.kind === "stdio") {
      const env = { ...sdk.getDefaultEnvironment() };
      for (const key of server.transport.envAllowlist) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      transport = new sdk.StdioClientTransport({
        command: server.transport.command,
        args: server.transport.args,
        env,
      });
    } else {
      transport = new sdk.StreamableHTTPClientTransport(new URL(server.transport.url));
    }
    await client.connect(transport);
    connectedClients.set(server.id, client);
    return client;
  }

  function disconnect(id) {
    const client = connectedClients.get(id);
    if (client) {
      Promise.resolve(client.close()).catch(() => {});
      connectedClients.delete(id);
    }
  }

  function disconnectAll() {
    for (const id of [...connectedClients.keys()]) disconnect(id);
  }

  function qualifyToolName(server, toolName) {
    return `${MCP_TOOL_PREFIX}${server.name}__${toolName}`;
  }

  function isMcpToolName(name) {
    return typeof name === "string" && name.startsWith(MCP_TOOL_PREFIX);
  }

  // Resolves the current, live tool set across every registered server.
  // Called fresh per reply (see server.js's replyMaybeWithTools) rather
  // than cached -- a server's advertised tools can change, and the total
  // tool count is small enough that re-listing costs little once a
  // connection is already established. An unreachable server is skipped,
  // not fatal to the whole reply -- same resilience philosophy
  // replyMaybeWithTools already applies to tool-calling as a whole.
  async function listApprovedToolSchemas() {
    const servers = readServers();
    const schemas = [];
    for (const server of servers) {
      try {
        const client = await withTimeout(
          getConnectedClient(server),
          listToolsTimeoutMs,
          `connecting to MCP server "${server.name}"`,
        );
        const { tools } = await withTimeout(
          client.listTools(),
          listToolsTimeoutMs,
          `listing tools for MCP server "${server.name}"`,
        );
        const allowed = new Set(server.allowedTools);
        for (const tool of tools) {
          if (!allowed.has(tool.name)) continue;
          schemas.push({
            type: "function",
            function: {
              name: qualifyToolName(server, tool.name),
              description: tool.description || `${tool.name} (from MCP server "${server.name}")`,
              parameters: tool.inputSchema || { type: "object", properties: {} },
            },
          });
        }
      } catch (e) {
        console.warn(`mcp-client-registry: skipping unreachable server "${server.name}": ${e.message}`);
      }
    }
    return schemas;
  }

  async function executeTool(qualifiedName, args) {
    const rest = qualifiedName.slice(MCP_TOOL_PREFIX.length);
    const separatorIndex = rest.indexOf("__");
    const serverName = separatorIndex === -1 ? rest : rest.slice(0, separatorIndex);
    const toolName = separatorIndex === -1 ? "" : rest.slice(separatorIndex + 2);
    const server = readServers().find((s) => s.name === serverName);
    if (!server) {
      throw new Error(`no registered MCP server named "${serverName}"`);
    }
    if (!server.allowedTools.includes(toolName)) {
      throw new Error(`tool "${toolName}" is not allowed for MCP server "${serverName}"`);
    }
    const client = await getConnectedClient(server);
    const result = await client.callTool({ name: toolName, arguments: args || {} });
    const textParts = Array.isArray(result.content)
      ? result.content.filter((c) => c.type === "text").map((c) => c.text)
      : [];
    return textParts.length ? textParts.join("\n") : JSON.stringify(result);
  }

  return {
    dataDir,
    listServers,
    getServer,
    registerServer,
    removeServer,
    listApprovedToolSchemas,
    isMcpToolName,
    // Issue #267: aliases matching the generic tool-source shape
    // (ai/tool-source.js's buildToolPolicy) so this registry can be passed
    // directly into a toolSources array -- listApprovedToolSchemas/
    // isMcpToolName above stay as the names every other caller/test
    // already uses.
    listToolSchemas: listApprovedToolSchemas,
    isKnownToolName: isMcpToolName,
    executeTool,
    disconnectAll,
    _resetForTests: () => disconnectAll(),
  };
}

// Combines a base tool-policy.js-shaped policy with an MCP registry's
// currently-approved tools into one object matching the exact same
// {tools, isKnownTool, executeTool} shape runToolAwareReply expects --
// built fresh per reply (see server.js) rather than a long-lived object,
// since MCP tool discovery is async and a request-scoped snapshot is
// simpler than keeping tool-policy.js itself aware of a second tool source.
async function buildToolPolicyWithMcp(basePolicy, mcpRegistry) {
  const mcpTools = await mcpRegistry.listApprovedToolSchemas();
  return {
    tools: [...basePolicy.tools, ...mcpTools],
    isKnownTool: (name) => basePolicy.isKnownTool(name) || mcpRegistry.isMcpToolName(name),
    executeTool: async (name, args) => {
      if (mcpRegistry.isMcpToolName(name)) return mcpRegistry.executeTool(name, args);
      return basePolicy.executeTool(name, args);
    },
  };
}

module.exports = {
  MCP_TOOL_PREFIX,
  assertValidHttpUrl,
  validateTransport,
  createMcpClientRegistry,
  buildToolPolicyWithMcp,
};
