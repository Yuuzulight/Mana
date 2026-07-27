const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApprovalGate } = require("../approval-gate");
const {
  assertValidHttpUrl,
  validateTransport,
  createMcpClientRegistry,
  buildToolPolicyWithMcp,
} = require("../mcp-client-registry");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-mcp-registry-"));
}

// A fake @modelcontextprotocol/sdk client/transport surface -- enough for
// the registry to drive without spawning a real process or opening a real
// socket. resolveServerName maps a constructed transport back to whichever
// "server name" the test cares about (tests give each server a distinct
// URL/command, so a simple per-test lookup is enough).
function createFakeSdk({ toolsByServerName = {}, unreachableServerNames = [], resolveServerName } = {}) {
  const capturedTransports = [];
  const closedServerNames = [];
  const resolve =
    resolveServerName ||
    ((transport) => (transport.kind === "http" ? transport.url.toString() : transport.opts.command));

  class FakeStdioClientTransport {
    constructor(opts) {
      this.kind = "stdio";
      this.opts = opts;
      capturedTransports.push(this);
    }
  }
  class FakeStreamableHTTPClientTransport {
    constructor(url) {
      this.kind = "http";
      this.url = url;
      capturedTransports.push(this);
    }
  }
  class FakeClient {
    async connect(transport) {
      const name = resolve(transport);
      if (unreachableServerNames.includes(name)) {
        throw new Error("connection refused");
      }
      this._serverName = name;
    }
    async listTools() {
      return { tools: toolsByServerName[this._serverName] || [] };
    }
    async callTool({ name, arguments: args }) {
      return { content: [{ type: "text", text: `${this._serverName}:${name}:${JSON.stringify(args)}` }] };
    }
    async close() {
      closedServerNames.push(this._serverName);
    }
  }

  return {
    sdk: {
      Client: FakeClient,
      StdioClientTransport: FakeStdioClientTransport,
      StreamableHTTPClientTransport: FakeStreamableHTTPClientTransport,
      getDefaultEnvironment: () => ({ PATH: "/usr/bin" }),
    },
    capturedTransports,
    closedServerNames,
  };
}

function createRegistry(overrides = {}) {
  const approvalGate = overrides.approvalGate || createApprovalGate({ dataDir: createTempDir() });
  const { sdk } = overrides.fakeSdk ? { sdk: overrides.fakeSdk } : createFakeSdk(overrides.fakeSdkOptions);
  return createMcpClientRegistry({
    dataDir: createTempDir(),
    approvalGate,
    sdk: overrides.sdk || sdk,
  });
}

async function registerAndApprove(registry, approvalGate, { name, transport, allowedTools }) {
  const result = await registry.registerServer({ name, transport, allowedTools });
  await approvalGate.decide(result.requestId, "allow-once");
  return registry.listServers().find((s) => s.name === name);
}

test("assertValidHttpUrl accepts http/https and rejects everything else", () => {
  assert.doesNotThrow(() => assertValidHttpUrl("https://example.com/mcp"));
  assert.throws(() => assertValidHttpUrl("not a url"), /invalid URL/);
  assert.throws(() => assertValidHttpUrl("ftp://example.com"), /http:\/\/ or https:\/\//);
});

test("validateTransport accepts stdio and http, rejects unknown kinds", () => {
  const stdio = validateTransport({ kind: "stdio", command: "npx", args: ["-y", "some-mcp"] });
  assert.equal(stdio.kind, "stdio");
  assert.deepEqual(stdio.envAllowlist, []);

  const http = validateTransport({ kind: "http", url: "https://example.com/mcp" });
  assert.equal(http.kind, "http");

  assert.throws(() => validateTransport({ kind: "stdio" }), /command/);
  assert.throws(() => validateTransport({ kind: "websocket" }), /unsupported transport kind/);
  assert.throws(() => validateTransport(null), /transport is required/);
});

test("registerServer requires approval -- listServers is empty until decided", async () => {
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const registry = createRegistry({ approvalGate });

  const result = await registry.registerServer({
    name: "docs",
    transport: { kind: "http", url: "https://example.com/mcp" },
    allowedTools: ["search_docs"],
  });
  assert.equal(result.status, "pending");
  assert.equal(registry.listServers().length, 0);

  await approvalGate.decide(result.requestId, "allow-once");
  const servers = registry.listServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "docs");
  assert.deepEqual(servers[0].allowedTools, ["search_docs"]);
});

test("registerServer validates name and allowedTools", async () => {
  const registry = createRegistry();
  await assert.rejects(
    () => registry.registerServer({ transport: { kind: "http", url: "https://example.com" }, allowedTools: ["x"] }),
    /name is required/,
  );
  await assert.rejects(
    () =>
      registry.registerServer({
        name: "docs",
        transport: { kind: "http", url: "https://example.com" },
        allowedTools: [],
      }),
    /allowedTools must list/,
  );
});

test("each registration gets its own actionType -- approving one server never auto-approves a later, different one", async () => {
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const registry = createRegistry({ approvalGate });

  const first = await registry.registerServer({
    name: "docs",
    transport: { kind: "http", url: "https://example.com/mcp" },
    allowedTools: ["search"],
  });
  await approvalGate.decide(first.requestId, "always-allow");
  assert.equal(registry.listServers().length, 1);

  const second = await registry.registerServer({
    name: "weather",
    transport: { kind: "http", url: "https://weather.example.com/mcp" },
    allowedTools: ["forecast"],
  });
  // Still pending -- "always-allow" on the first server's unique actionType
  // must not have silently pre-approved this materially different server.
  assert.equal(second.status, "pending");
  assert.equal(registry.listServers().length, 1);
});

test("removeServer deletes a registered server and returns false for an unknown id", async () => {
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const registry = createRegistry({ approvalGate });
  await registerAndApprove(registry, approvalGate, {
    name: "docs",
    transport: { kind: "http", url: "https://example.com/mcp" },
    allowedTools: ["search"],
  });
  const serverId = registry.listServers()[0].id;

  assert.equal(registry.removeServer("not-a-real-id"), false);
  assert.equal(registry.removeServer(serverId), true);
  assert.equal(registry.listServers().length, 0);
});

test("listApprovedToolSchemas returns only allow-listed tools, correctly prefixed and shaped", async () => {
  const { sdk, capturedTransports } = createFakeSdk({
    toolsByServerName: {
      "https://example.com/mcp": [
        { name: "search_docs", description: "Search the docs", inputSchema: { type: "object", properties: {} } },
        { name: "delete_everything", description: "not allowed" },
      ],
    },
  });
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const registry = createRegistry({ approvalGate, sdk });
  await registerAndApprove(registry, approvalGate, {
    name: "docs",
    transport: { kind: "http", url: "https://example.com/mcp" },
    allowedTools: ["search_docs"],
  });

  const schemas = await registry.listApprovedToolSchemas();
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0].type, "function");
  assert.equal(schemas[0].function.name, "mcp__docs__search_docs");
  assert.equal(schemas[0].function.description, "Search the docs");
  assert.equal(capturedTransports.length, 1);
});

test("listApprovedToolSchemas skips an unreachable server instead of throwing", async () => {
  const { sdk } = createFakeSdk({ unreachableServerNames: ["https://unreachable.example.com/mcp"] });
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const registry = createRegistry({ approvalGate, sdk });
  await registerAndApprove(registry, approvalGate, {
    name: "down",
    transport: { kind: "http", url: "https://unreachable.example.com/mcp" },
    allowedTools: ["anything"],
  });

  const schemas = await registry.listApprovedToolSchemas();
  assert.deepEqual(schemas, []);
});

test("executeTool routes to the right server/tool and rejects unknown servers or disallowed tools", async () => {
  const { sdk } = createFakeSdk({ toolsByServerName: { "https://example.com/mcp": [{ name: "search_docs" }] } });
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const registry = createRegistry({ approvalGate, sdk });
  await registerAndApprove(registry, approvalGate, {
    name: "docs",
    transport: { kind: "http", url: "https://example.com/mcp" },
    allowedTools: ["search_docs"],
  });

  const result = await registry.executeTool("mcp__docs__search_docs", { q: "hi" });
  assert.match(result, /search_docs/);

  await assert.rejects(() => registry.executeTool("mcp__unknown__x", {}), /no registered MCP server/);
  await assert.rejects(() => registry.executeTool("mcp__docs__not_allowed", {}), /not allowed/);
});

test("isMcpToolName distinguishes MCP-qualified names from local tool names", () => {
  const registry = createRegistry();
  assert.equal(registry.isMcpToolName("mcp__docs__search"), true);
  assert.equal(registry.isMcpToolName("read_file"), false);
});

test("a stdio transport only passes through explicitly allow-listed env vars", async () => {
  const { sdk, capturedTransports } = createFakeSdk({ toolsByServerName: { npx: [{ name: "run" }] } });
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const registry = createRegistry({ approvalGate, sdk });
  process.env.MANA_TEST_MCP_SECRET = "shh";
  try {
    await registerAndApprove(registry, approvalGate, {
      name: "local",
      transport: {
        kind: "stdio",
        command: "npx",
        args: ["-y", "local-mcp"],
        envAllowlist: ["MANA_TEST_MCP_SECRET"],
      },
      allowedTools: ["run"],
    });
    await registry.listApprovedToolSchemas();
    const stdioTransport = capturedTransports.find((t) => t.kind === "stdio");
    assert.equal(stdioTransport.opts.env.MANA_TEST_MCP_SECRET, "shh");
    assert.equal(stdioTransport.opts.env.PATH, "/usr/bin"); // from getDefaultEnvironment()
    assert.equal("SOME_OTHER_ENV_VAR" in stdioTransport.opts.env, false);
  } finally {
    delete process.env.MANA_TEST_MCP_SECRET;
  }
});

test("buildToolPolicyWithMcp merges base and MCP tools and routes executeTool to the right source", async () => {
  const { sdk } = createFakeSdk({ toolsByServerName: { "https://example.com/mcp": [{ name: "search_docs" }] } });
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const registry = createRegistry({ approvalGate, sdk });
  await registerAndApprove(registry, approvalGate, {
    name: "docs",
    transport: { kind: "http", url: "https://example.com/mcp" },
    allowedTools: ["search_docs"],
  });

  const basePolicy = {
    tools: [{ type: "function", function: { name: "read_file" } }],
    isKnownTool: (name) => name === "read_file",
    executeTool: (name) => `local:${name}`,
  };
  const merged = await buildToolPolicyWithMcp(basePolicy, registry);
  assert.deepEqual(
    merged.tools.map((t) => t.function.name).sort(),
    ["mcp__docs__search_docs", "read_file"],
  );
  assert.equal(merged.isKnownTool("read_file"), true);
  assert.equal(merged.isKnownTool("mcp__docs__search_docs"), true);
  assert.equal(merged.isKnownTool("nope"), false);

  assert.equal(await merged.executeTool("read_file", {}), "local:read_file");
  assert.match(await merged.executeTool("mcp__docs__search_docs", { q: "x" }), /search_docs/);
});
