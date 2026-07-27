const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const test = require("node:test");

const { mcpClientCapability } = require("../capabilities/mcp-client-capability");
const { createApprovalGate } = require("../approval-gate");
const { createMcpClientRegistry } = require("../mcp-client-registry");
const { withServer } = require("./helpers");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-mcp-cap-"));
}

function createFakeSdk() {
  class FakeTransport {
    constructor(...args) {
      this.args = args;
    }
  }
  class FakeClient {
    async connect() {}
    async listTools() {
      return { tools: [] };
    }
    async close() {}
  }
  return {
    Client: FakeClient,
    StdioClientTransport: FakeTransport,
    StreamableHTTPClientTransport: FakeTransport,
    getDefaultEnvironment: () => ({}),
  };
}

function buildApp() {
  const approvalGate = createApprovalGate({ dataDir: createTempDir() });
  const mcpClientRegistry = createMcpClientRegistry({
    dataDir: createTempDir(),
    approvalGate,
    sdk: createFakeSdk(),
  });
  const app = express();
  app.use(express.json());
  mcpClientCapability.registerRoutes(app, { mcpClientRegistry });
  return { app, approvalGate, mcpClientRegistry };
}

test("GET /mcp-clients/servers starts empty", async () => {
  const { app } = buildApp();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp-clients/servers`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.servers, []);
  });
});

test("POST /mcp-clients/servers returns a pending approval, then GET reflects it once decided", async () => {
  const { app, approvalGate } = buildApp();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp-clients/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "docs",
        transport: { kind: "http", url: "https://example.com/mcp" },
        allowedTools: ["search_docs"],
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.status, "pending");

    const emptyList = await (await fetch(`${baseUrl}/mcp-clients/servers`)).json();
    assert.equal(emptyList.servers.length, 0);

    await approvalGate.decide(payload.requestId, "allow-once");
    const filledList = await (await fetch(`${baseUrl}/mcp-clients/servers`)).json();
    assert.equal(filledList.servers.length, 1);
    assert.equal(filledList.servers[0].name, "docs");
  });
});

test("POST /mcp-clients/servers rejects a missing name", async () => {
  const { app } = buildApp();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp-clients/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transport: { kind: "http", url: "https://example.com" }, allowedTools: ["x"] }),
    });
    assert.equal(response.status, 400);
  });
});

test("DELETE /mcp-clients/servers/:id removes a registered server and 404s for an unknown id", async () => {
  const { app, approvalGate } = buildApp();
  await withServer(app, async (baseUrl) => {
    const registerResponse = await fetch(`${baseUrl}/mcp-clients/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "docs",
        transport: { kind: "http", url: "https://example.com/mcp" },
        allowedTools: ["search_docs"],
      }),
    });
    const { requestId } = await registerResponse.json();
    await approvalGate.decide(requestId, "allow-once");
    const [server] = (await (await fetch(`${baseUrl}/mcp-clients/servers`)).json()).servers;

    const notFound = await fetch(`${baseUrl}/mcp-clients/servers/not-a-real-id`, { method: "DELETE" });
    assert.equal(notFound.status, 404);

    const removed = await fetch(`${baseUrl}/mcp-clients/servers/${server.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const afterList = await (await fetch(`${baseUrl}/mcp-clients/servers`)).json();
    assert.equal(afterList.servers.length, 0);
  });
});

test("getHealth reports the current registered-server count", () => {
  const { mcpClientRegistry } = buildApp();
  const empty = mcpClientCapability.getHealth({ mcpClientRegistry });
  assert.equal(empty.count, 0);
  assert.match(empty.message, /No MCP servers registered/);
});
