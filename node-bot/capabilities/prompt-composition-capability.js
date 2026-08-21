const { ValidationError, requireString, sendValidationError } = require("../request-validation");

const KEY = "prompt-composition";

// Issue #400: reports what the last assembled prompt for a session
// actually contained, and what each block silently dropped -- see
// ../prompt-composition-report.js for what gets recorded and why.
function registerPromptCompositionRoutes(app, context = {}) {
  const getPromptComposition = context.getPromptComposition;

  app.get("/prompt-composition/:sessionId", (req, res) => {
    try {
      const sessionId = requireString(req.params?.sessionId, "sessionId");
      const composition = getPromptComposition(sessionId);
      if (!composition) {
        return res.status(404).json({ error: "no prompt has been assembled for this session yet" });
      }
      return res.json(composition);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
}

const promptCompositionCapability = {
  key: KEY,
  registerRoutes: registerPromptCompositionRoutes,
  getHealth: () => ({
    status: "configured",
    configured: true,
    message: "Prompt composition reporting is available.",
  }),
};

module.exports = {
  registerPromptCompositionRoutes,
  promptCompositionCapability,
};
