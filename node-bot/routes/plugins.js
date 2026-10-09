function registerPluginRoutes(context) {
context.app.get("/plugins", (req, res) => {
    const grouped = {};
    for (const capability of context.capabilities) {
      if (!capability.category) continue;
      const bucket = grouped[capability.category] || (grouped[capability.category] = []);
      bucket.push({
        key: capability.key,
        name: capability.name || capability.key,
        description: capability.description || null,
        enabled: context.activePluginSettingsStore.isEnabled(
          capability.key,
          capability.defaultEnabled !== false,
        ),
      });
    }
    return res.json({ ok: true, plugins: grouped });
  });

context.app.post("/plugins/:key/enabled", (req, res) => {
    const capability = context.capabilities.find(
      (c) => c.category && c.key === req.params.key,
    );
    if (!capability) {
      return res.status(404).json({ ok: false, error: "no such plugin" });
    }
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "enabled must be a boolean" });
    }
    const resolved = context.activePluginSettingsStore.setEnabled(capability.key, enabled);
    return res.json({ ok: true, key: capability.key, enabled: resolved });
  });
}

module.exports = { registerPluginRoutes };
