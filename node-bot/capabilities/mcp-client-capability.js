// Issue #169: HTTP surface for registering/listing/removing outbound MCP
// servers. Registration itself doesn't return "registered" -- it goes
// through the approval gate (context.approvalGate, already wired into every
// other capability), so the actual result is usually {status: "pending",
// requestId}; the caller then uses the existing /approvals/:id/decide
// route (approval-gate-capability.js) to approve or deny it, same as any
// other gated action.
const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");

const KEY = "mcpClients";

function registerMcpClientRoutes(app, context = {}) {
  const mcpClientRegistry = context.mcpClientRegistry;

  app.get("/mcp-clients/servers", (req, res) => {
    try {
      return res.json({ servers: mcpClientRegistry.listServers() });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/mcp-clients/servers", async (req, res) => {
    try {
      const name = requireString(req.body?.name, "name");
      const transport = req.body?.transport;
      const allowedTools = req.body?.allowedTools;
      const result = await mcpClientRegistry.registerServer({ name, transport, allowedTools });
      return res.json(result);
    } catch (e) {
      if (e instanceof ValidationError) return sendValidationError(res, e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.delete("/mcp-clients/servers/:id", (req, res) => {
    try {
      const id = requireString(req.params?.id, "id");
      const removed = mcpClientRegistry.removeServer(id);
      if (!removed) {
        return res.status(404).json({ error: "no registered MCP server matches that id" });
      }
      return res.json({ ok: true });
    } catch (e) {
      if (e instanceof ValidationError) return sendValidationError(res, e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });
}

const mcpClientCapability = {
  key: KEY,
  registerRoutes: registerMcpClientRoutes,
  getHealth: (context = {}) => {
    const mcpClientRegistry = context.mcpClientRegistry;
    const count = mcpClientRegistry ? mcpClientRegistry.listServers().length : 0;
    return {
      status: "configured",
      configured: true,
      message: count > 0 ? `${count} MCP server(s) registered.` : "No MCP servers registered.",
      count,
    };
  },
};

module.exports = {
  registerMcpClientRoutes,
  mcpClientCapability,
};
