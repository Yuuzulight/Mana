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

  // #426 review: pause/resume a rule without deleting it -- only `enabled`
  // is settable here, same narrow surface as the rest of this route file.
  app.patch("/hooks/:id", (req, res) => {
    try {
      const id = requireString(req.params?.id, "id");
      if (typeof req.body?.enabled !== "boolean") {
        throw new ValidationError("enabled must be a boolean");
      }
      const rule = hooksStore.setRuleEnabled(id, req.body.enabled);
      if (!rule) {
        return res.status(404).json({ error: "hook rule not found" });
      }
      return res.json(rule);
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
    const rules = hooksStore ? hooksStore.listRules() : [];
    const count = rules.length;
    // #426 review: a post-hook command's outcome was previously visible
    // only via a server-side console.warn -- surfaced here instead, so a
    // silently-broken hook shows up wherever this capability's health is
    // already checked, without changing the fire-and-forget execution.
    const failing = rules.filter((r) => r.lastRun && r.lastRun.ok === false);
    let message = count > 0 ? `${count} hook rule(s) configured.` : "No hook rules configured.";
    if (failing.length > 0) {
      message += ` ${failing.length} last ran with an error (${failing.map((r) => r.toolName).join(", ")}).`;
    }
    return {
      status: "configured",
      configured: true,
      message,
      count,
      failing: failing.length,
    };
  },
};

module.exports = { registerHooksRoutes, hooksCapability };
