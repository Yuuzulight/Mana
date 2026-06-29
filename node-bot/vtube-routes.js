function registerVTubeRoutes(app, { vtubeRuntime }) {
  const vtubeStudio = vtubeRuntime?.vtubeStudio || null;
  const vtubeStudioUrl = vtubeRuntime?.vtubeStudioUrl || "ws://127.0.0.1:8001";

  app.get("/vtube/status", async (req, res) => {
    if (!vtubeStudio) {
      return res.json({ enabled: false });
    }

    try {
      const state = await vtubeStudio.getState();
      return res.json({
        enabled: true,
        connected: true,
        authenticated: vtubeStudio.authenticated,
        url: vtubeStudioUrl,
        state,
      });
    } catch (error) {
      return res.status(503).json({
        enabled: true,
        connected: false,
        authenticated: false,
        url: vtubeStudioUrl,
        error: error.message,
      });
    }
  });

  app.post("/vtube/auth", async (req, res) => {
    if (!vtubeStudio) {
      return res.status(400).json({ error: "VTube Studio integration disabled" });
    }

    try {
      const result = await vtubeStudio.authenticate();
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.get("/vtube/hotkeys", async (req, res) => {
    if (!vtubeStudio) {
      return res.status(400).json({ error: "VTube Studio integration disabled" });
    }

    try {
      const hotkeys = await vtubeStudio.listHotkeys();
      return res.json({ hotkeys });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post("/vtube/hotkey", async (req, res) => {
    if (!vtubeStudio) {
      return res.status(400).json({ error: "VTube Studio integration disabled" });
    }

    try {
      const hotkeyID =
        typeof req.body?.hotkeyID === "string" ? req.body.hotkeyID.trim() : "";
      const hotkeyName =
        typeof req.body?.hotkeyName === "string"
          ? req.body.hotkeyName.trim()
          : "";
      const result = await vtubeStudio.triggerHotkey({ hotkeyID, hotkeyName });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });
}

module.exports = {
  registerVTubeRoutes,
};
