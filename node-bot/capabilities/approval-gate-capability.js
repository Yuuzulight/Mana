const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");

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

  app.post("/approvals/:id/decide", async (req, res) => {
    try {
      const id = requireString(req.params?.id, "id");
      const decision = requireString(req.body?.decision, "decision");
      if (!["allow-once", "always-allow", "deny"].includes(decision)) {
        throw new ValidationError('decision must be "allow-once", "always-allow", or "deny"');
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
