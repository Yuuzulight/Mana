// Issue #188: read-only HTTP surface for the shared tool-call audit log --
// "one place to see what any tool actually did," not just a file on disk
// nobody looks at.
const KEY = "toolCallLog";

function registerToolCallLogRoutes(app, context = {}) {
  const toolCallLog = context.toolCallLog;

  app.get("/tool-calls/recent", (req, res) => {
    try {
      const limit = Number(req.query?.limit) || undefined;
      return res.json({ calls: toolCallLog.readRecent(limit) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
}

const toolCallLogCapability = {
  key: KEY,
  registerRoutes: registerToolCallLogRoutes,
  getHealth: (context = {}) => {
    const toolCallLog = context.toolCallLog;
    const count = toolCallLog ? toolCallLog.readRecent().length : 0;
    return {
      status: "configured",
      configured: true,
      message: count > 0 ? `${count} recent tool call(s) logged.` : "No tool calls logged yet.",
      count,
    };
  },
};

module.exports = { registerToolCallLogRoutes, toolCallLogCapability };
