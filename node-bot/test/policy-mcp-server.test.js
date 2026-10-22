// #1406: her self-work tools as a local MCP endpoint, the only tools Claude Code gets.
const assert = require("node:assert/strict");
const test = require("node:test");
const { Client } = require("@modelcontextprotocol/sdk/client");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const { startPolicyMcpServer } = require("../ai/policy-mcp-server");

const tool = (name, properties = {}) => ({ type: "function", function: { name, description: `${name} tool`, parameters: { type: "object", properties, required: Object.keys(properties) } } });

function policy(log = []) {
  return {
    tools: [tool("self_work__read", { path: { type: "string" } }), tool("coding__propose_edit", { path: { type: "string" }, new_text: { type: "string" } }), tool("boom")],
    isKnownTool: () => true,
    async executeTool(name, args) {
      log.push([name, args]);
      if (name === "boom") throw new Error("that path isn't mine to write");
      return JSON.stringify({ status: "ok", name, args });
    },
  };
}

async function connect(server) {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  return client;
}

test("lists exactly the policy's tools, with their schemas", async () => {
  const server = await startPolicyMcpServer(policy());
  try {
    const client = await connect(server);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["self_work__read", "coding__propose_edit", "boom"]);
    assert.deepEqual(tools[0].inputSchema.properties, { path: { type: "string" } });
    assert.equal(tools[0].description, "self_work__read tool");
    await client.close();
  } finally {
    await server.close();
  }
});

test("a call reaches executeTool with its arguments and returns its text", async () => {
  const log = [];
  const server = await startPolicyMcpServer(policy(log));
  try {
    const client = await connect(server);
    const out = await client.callTool({ name: "coding__propose_edit", arguments: { path: "a.js", new_text: "x" } });
    assert.deepEqual(log, [["coding__propose_edit", { path: "a.js", new_text: "x" }]]);
    assert.equal(JSON.parse(out.content[0].text).status, "ok");
    assert.notEqual(out.isError, true);
    assert.deepEqual(server.calls, [{ name: "coding__propose_edit", args: { path: "a.js", new_text: "x" } }]);
    await client.close();
  } finally {
    await server.close();
  }
});

test("a thrown error comes back as an error result, not a crash", async () => {
  const server = await startPolicyMcpServer(policy());
  try {
    const client = await connect(server);
    const out = await client.callTool({ name: "boom", arguments: {} });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /isn't mine to write/);
    await client.close();
  } finally {
    await server.close();
  }
});

test("refuses a request without the token, and listens on 127.0.0.1 only", async () => {
  const server = await startPolicyMcpServer(policy());
  try {
    assert.equal(new URL(server.url).hostname, "127.0.0.1");
    const res = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(res.status, 401);
    const wrong = await fetch(server.url, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
    assert.equal(wrong.status, 401);
  } finally {
    await server.close();
  }
});
