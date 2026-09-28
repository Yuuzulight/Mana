const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");
const { MODES, resolveToolApprovalMode } = require("../ai/tool-risk");

const KEY = "approvalGate";

function registerApprovalGateRoutes(app, context = {}) {
  const approvalGate = context.approvalGate;

  app.get("/approvals/pending", (req, res) => {
    try {
      return res.json({ pending: approvalGate.listPending() });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  // Issue #284: read-only surface for the Guardian pre-check audit log --
  // same reasoning as tool-call-log-capability.js's /tool-calls/recent,
  // "one place to see what got auto-cleared" instead of just a file on
  // disk nobody looks at.
  app.get("/approvals/guardian-audit", (req, res) => {
    try {
      const limit = Number(req.query?.limit) || undefined;
      return res.json({ entries: approvalGate.guardianAuditLog.readRecent(limit) });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  // #669: which tool calls ask first. The saved choice wins over
  // MANA_TOOL_APPROVAL; neither set means "smart".
  const env = context.env || process.env;
  app.get("/approvals/tool-mode", (req, res) => {
    return res.json({
      mode: resolveToolApprovalMode(approvalGate.getToolApprovalMode(), env.MANA_TOOL_APPROVAL),
    });
  });

  app.post("/approvals/tool-mode", (req, res) => {
    if (!context.checkAdminAuth(req, res)) return;
    const mode = req.body?.mode;
    if (!MODES.includes(mode)) {
      return res.status(400).json({ error: `mode must be one of: ${MODES.join(", ")}` });
    }
    approvalGate.setToolApprovalMode(mode);
    return res.json({ mode });
  });

  app.post("/approvals/:id/decide", async (req, res) => {
    try {
      const id = requireString(req.params?.id, "id");
      const decision = requireString(req.body?.decision, "decision");
      // "allow-session": issue #669's in-memory grant, gone on restart.
      if (!["allow-once", "allow-session", "always-allow", "deny"].includes(decision)) {
        throw new ValidationError('decision must be "allow-once", "allow-session", "always-allow", or "deny"');
      }
      const result = await approvalGate.decide(id, decision);
      if (!result) {
        return res.status(404).json({ error: "no pending approval request matches that id" });
      }
      return res.json(result);
    } catch (e) {
      if (e instanceof ValidationError) return sendValidationError(res, e);
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });
}

const approvalGateCapability = {
  key: KEY,
  registerRoutes: registerApprovalGateRoutes,
  getHealth: (context = {}) => {
    const approvalGate = context.approvalGate;
    const count = approvalGate ? approvalGate.listPending().length : 0;
    return {
      status: "configured",
      configured: true,
      message: count > 0 ? `${count} approval request(s) awaiting review.` : "No approvals pending.",
      count,
    };
  },
};

module.exports = {
  registerApprovalGateRoutes,
  approvalGateCapability,
};
