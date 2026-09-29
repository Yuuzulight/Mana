// Issue #700: read Mana's mood (values, history, a one-line summary for the
// tray/status line), reset it, and freeze it. No setters for the values on
// purpose -- the design has no direct sliders.
const {
  ValidationError,
  sendValidationError,
} = require("../request-validation");

const KEY = "mood";

function registerMoodRoutes(app, context = {}) {
  const moodStore = context.moodStore;

  app.get("/mood", (req, res) => {
    try {
      return res.json(moodStore.get());
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/mood/reset", (req, res) => {
    try {
      return res.json(moodStore.reset());
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/mood/freeze", (req, res) => {
    try {
      const frozen = req.body?.frozen;
      if (typeof frozen !== "boolean") throw new ValidationError("frozen must be a boolean");
      return res.json(moodStore.setFrozen(frozen));
    } catch (e) {
      if (e instanceof ValidationError) return sendValidationError(res, e);
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
}

const moodCapability = {
  key: KEY,
  registerRoutes: registerMoodRoutes,
};

module.exports = { registerMoodRoutes, moodCapability };
