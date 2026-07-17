const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");

const KEY = "presets";

function registerPresetsRoutes(app, context = {}) {
  const presetsStore = context.presetsStore;

  app.get("/presets", (req, res) => {
    try {
      return res.json({ presets: presetsStore.listPresets() });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/presets", (req, res) => {
    try {
      const name = requireString(req.body?.name, "name");
      const instructions = requireString(req.body?.instructions, "instructions");
      const preset = presetsStore.createPreset({ name, instructions });
      return res.status(201).json(preset);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.patch("/presets/:id", (req, res) => {
    try {
      const id = requireString(req.params?.id, "id");
      const updates = {};
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "name")) {
        updates.name = requireString(req.body.name, "name");
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "instructions")) {
        updates.instructions = requireString(req.body.instructions, "instructions");
      }
      const preset = presetsStore.updatePreset(id, updates);
      if (!preset) {
        return res.status(404).json({ error: "preset not found" });
      }
      return res.json(preset);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.delete("/presets/:id", (req, res) => {
    try {
      const id = requireString(req.params?.id, "id");
      const deleted = presetsStore.deletePreset(id);
      if (!deleted) {
        return res.status(404).json({ error: "preset not found" });
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

const presetsCapability = {
  key: KEY,
  registerRoutes: registerPresetsRoutes,
  getHealth: (context = {}) => {
    const presetsStore = context.presetsStore;
    const count = presetsStore ? presetsStore.listPresets().length : 0;
    return {
      status: "configured",
      configured: true,
      message: `Prompt/behavior presets are available (${count} saved).`,
      count,
    };
  },
};

module.exports = {
  registerPresetsRoutes,
  presetsCapability,
};
