// Issue #426: user-editable CRUD surface for hook rules -- same shape as
// presets-capability.js (a plain list/add/delete over its own JSON store).
const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");

const KEY = "hooks";

function registerHooksRoutes(app, context = {}) {
  const hooksStore = context.hooksStore;

  app.get("/hooks", (req, res) => {
    try {
      return res.json({ rules: hooksStore.listRules() });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/hooks", (req, res) => {
    try {
      const phase = requireString(req.body?.phase, "phase");
      const action = requireString(req.body?.action, "action");
      const toolName = requireString(req.body?.toolName, "toolName");
      const rule = hooksStore.addRule({
        phase,
        action,
        toolName,
        pathContains: req.body?.pathContains,
        command: req.body?.command,
        args: req.body?.args,
        reason: req.body?.reason,
      });
      return res.status(201).json(rule);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.delete("/hooks/:id", (req, res) => {
    try {
      const id = requireString(req.params?.id, "id");
      const deleted = hooksStore.removeRule(id);
      if (!deleted) {
        return res.status(404).json({ error: "hook rule not found" });
      }
      return res.json({ deleted: true, id });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
}

const hooksCapability = {
  key: KEY,
  registerRoutes: registerHooksRoutes,
  getHealth: (context = {}) => {
    const hooksStore = context.hooksStore;
    const count = hooksStore ? hooksStore.listRules().length : 0;
    return {
      status: "configured",
      configured: true,
      message: count > 0 ? `${count} hook rule(s) configured.` : "No hook rules configured.",
      count,
    };
  },
};

module.exports = { registerHooksRoutes, hooksCapability };
