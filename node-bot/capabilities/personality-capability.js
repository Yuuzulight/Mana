// Issue #357: the write surface for the editable personality layer. Without
// this the store has no way to be changed and the feature is inert.
//
// Deliberately user-driven only -- there is no tool here that lets the model
// rewrite its own personality. Self-modification is a different question
// from persistence, and belongs behind the approval gate (see #355's split
// between approval-to-exist and permission-to-run) rather than being handed
// out as a side effect of making the layer durable.
const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");

const KEY = "personality";

function registerPersonalityRoutes(app, context = {}) {
  const personalityStore = context.personalityStore;

  app.get("/personality", (req, res) => {
    try {
      return res.json(personalityStore.get());
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/personality", (req, res) => {
    try {
      const traits = requireString(req.body?.traits, "traits");
      // reason is what the user actually said ("be more chill"), optional
      // because a direct edit from a settings field has no phrasing behind it.
      const reason = req.body?.reason ? String(req.body.reason) : undefined;
      return res.json(personalityStore.set(traits, { reason }));
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/personality/revert", (req, res) => {
    try {
      return res.json(personalityStore.revert());
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.delete("/personality", (req, res) => {
    try {
      return res.json(personalityStore.clear());
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
}

const personalityCapability = {
  key: KEY,
  registerRoutes: registerPersonalityRoutes,
  getHealth: (context = {}) => {
    const personalityStore = context.personalityStore;
    const state = personalityStore ? personalityStore.get() : null;
    const adjusted = Boolean(state && state.traits);
    return {
      status: "configured",
      configured: true,
      // Running on the core alone is a perfectly healthy state, not a
      // missing configuration -- most installs will never adjust it.
      message: adjusted
        ? `Personality adjusted (${state.history.length} prior version(s) kept).`
        : "Running on the base persona, no adjustments made.",
      adjusted,
    };
  },
};

module.exports = {
  registerPersonalityRoutes,
  personalityCapability,
};
