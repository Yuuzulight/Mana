// #1406: her self-work tools as a local MCP endpoint (streamable HTTP), the
// only tools Claude Code gets when she hands an issue to it. Every call goes
// through her own policy's executeTool, so her guardrails, sandboxed tests
// and reviewer apply exactly as for DeepSeek. 127.0.0.1 only, with a random
// bearer token, and gone when the run ends.
const http = require("node:http");
const crypto = require("node:crypto");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

function startPolicyMcpServer(tools) {
  const token = crypto.randomBytes(24).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const calls = [];
  const list = tools.tools.map(({ function: f }) => ({ name: f.name, description: f.description || "", inputSchema: f.parameters || { type: "object", properties: {} } }));

  // Stateless: a server and transport per request, as the SDK does for one.
  function mcpServer() {
    const server = new Server({ name: "mana", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: list }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const args = params.arguments || {};
      calls.push({ name: params.name, args });
      try {
        return { content: [{ type: "text", text: String(await tools.executeTool(params.name, args)) }] };
      } catch (e) {
        return { content: [{ type: "text", text: e.message || String(e) }], isError: true };
      }
    });
    return server;
  }

  const authorized = (req) => {
    const got = Buffer.from(String(req.headers.authorization || ""));
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  };

  const httpServer = http.createServer((req, res) => {
    if (!authorized(req)) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const server = mcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      } catch (e) {
        if (!res.headersSent) res.writeHead(400).end(e.message);
      }
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${httpServer.address().port}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
        calls,
        close: () => new Promise((done) => httpServer.close(() => done())),
      });
    });
  });
}

module.exports = { startPolicyMcpServer };
