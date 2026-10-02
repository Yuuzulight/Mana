// Plugin store, add-on consent and short-video-gen add-on routes, moved out
// of server.js's registerRoutes() (#500). Behaviour is unchanged.
const https = require("https");
const { pluginStore } = require("./plugin-store");
const {
  handleGetAddonStatus,
  handleGenerateVideo,
  handleAddonConsent,
} = require("./routes/addons");

// deps: checkAdminAuth, activePluginSettingsStore, and the optional test
// injections pluginStore / fetchAvailablePlugins (same as registerRoutes').
function registerPluginStoreRoutes(app, deps) {
  const { checkAdminAuth, activePluginSettingsStore } = deps;

  // Plugin store API endpoints. Previously lived in startServer() (bolted
  // onto `app` after createApp() had already returned), which meant no
  // test using this codebase's actual pattern -- createApp(deps) +
  // withServer() -- could ever reach them; moved here so deps.pluginStore/
  // deps.pluginSettingsStore/deps.fetchAvailablePlugins can be injected
  // like every other route in this function, and CI actually exercises
  // them. Also fixes real bugs found in the process:
  // - referenced a separate, independently-buggy plugin-manager.js
  //   instead of the already-hardened plugin-store.js (pluginStore) --
  //   swapped to that.
  // - the consent routes shadowed the correct module-scope
  //   pluginSettingsStore (line 674-ish, aliased here as
  //   activePluginSettingsStore) with `require("./plugin-settings-store")
  //   .pluginSettingsStore`, which doesn't exist (that module only
  //   exports createPluginSettingsStore) -- always undefined, so both
  //   routes threw on every call. Removed the shadowing require.
  // - toggle used to call a togglePlugin() that doesn't exist on
  //   pluginStore; now uses activePluginSettingsStore.setEnabled(), the
  //   same enable/disable mechanism every other plugin/capability in this
  //   file already uses (see GET /plugins).
  const activePluginStore = deps.pluginStore || pluginStore;
  const fetchAvailablePlugins =
    deps.fetchAvailablePlugins ||
    (() =>
      new Promise((resolve, reject) => {
        https
          .get(
            "https://api.github.com/repos/Yuuzulight/Mana/contents/tools/plugins",
            (res) => {
              let data = "";
              res.on("data", (chunk) => (data += chunk));
              res.on("end", () => {
                try {
                  resolve(JSON.parse(data));
                } catch (e) {
                  reject(e);
                }
              });
              res.on("error", reject);
            },
          )
          .on("error", reject);
      }));

  app.get("/plugins/store", async (req, res) => {
    try {
      const installed = activePluginStore.list();
      const available = await fetchAvailablePlugins();
      const installedNames = new Set(installed.map((plugin) => plugin.name));

      const githubPlugins = Array.isArray(available)
        ? available
            .filter((item) => item.name.endsWith("/"))
            .map((item) => ({
              name: item.name.replace("/", ""),
              url: `https://github.com/Yuuzulight/Mana/tree/main/tools/plugins/${item.name}`,
              description: "Official Mana plugin from GitHub",
              category: "Core",
              installed: installedNames.has(item.name.replace("/", "")),
            }))
        : [];

      const allPlugins = [
        ...installed.map((plugin) => ({
          name: plugin.name,
          url: `https://github.com/Yuuzulight/Mana/tree/main/tools/plugins/${plugin.name}`,
          version: plugin.version,
          author: plugin.author,
          description: plugin.description || "Installed plugin",
          category: "User Installed",
          installed: true,
          enabled: activePluginSettingsStore.isEnabled(plugin.name),
        })),
        // #499: an installed plugin appears once, as installed.
        ...githubPlugins.filter((plugin) => !plugin.installed),
      ];

      // Segment by tier (plugin vs addon) -- default to "plugin" if not specified
      const plugins = allPlugins.filter((p) => p.tier === "plugin" || !p.tier);
      const addons = allPlugins.filter((p) => p.tier === "addon");

      res.json({
        installed,
        available: githubPlugins,
        all: allPlugins,
        plugins,
        addons,
      });
    } catch (error) {
      console.error("[PluginStore] Failed to fetch plugins:", error.message);
      res.status(500).json({ error: `Failed to fetch plugins: ${error.message}` });
    }
  });

  app.get("/addons/consent/:name", (req, res) => {
    try {
      const name = req.params.name;
      const consentKey = `addon_consent_${name}`;
      const consented = activePluginSettingsStore.getConsent(consentKey);

      res.json({
        consented: consented === true,
        required: name.startsWith("@mana/"), // Add-Ons require explicit consent
      });
    } catch (error) {
      console.error("[PluginStore] Failed to check addon consent:", error.message);
      res.status(500).json({ error: `Failed to check consent: ${error.message}` });
    }
  });

  app.post("/addons/consent/:name", (req, res) => {
    try {
      const name = req.params.name;

      if (!req.body || typeof req.body.consented !== "boolean") {
        return res.status(400).json({ error: "consented field is required" });
      }

      const consentKey = `addon_consent_${name}`;
      activePluginSettingsStore.setConsent(consentKey, req.body.consented);

      res.json({ ok: true, name });
    } catch (error) {
      console.error("[PluginStore] Failed to record addon consent:", error.message);
      res.status(500).json({ error: `Failed to record consent: ${error.message}` });
    }
  });

  app.post("/plugins/store/install", async (req, res) => {
    // CodeQL review: installFromLocal can read an arbitrary local file path
    // -- a legitimate admin capability (same trust level as e.g. the
    // /admin/plugins_install.html UI this backs), not something any
    // unauthenticated caller should be able to trigger. Same
    // checkAdminAuth gate every other sensitive route in this file already
    // uses.
    if (!checkAdminAuth(req, res)) return;
    try {
      const { sourceType, urlOrPath } = req.body || {};

      if (!sourceType || !urlOrPath) {
        return res.status(400).json({ error: "sourceType and urlOrPath are required" });
      }

      let result;
      if (sourceType === "github") {
        result = await activePluginStore.installFromGitHub(urlOrPath);
      } else if (sourceType === "local") {
        result = await activePluginStore.installFromLocal(urlOrPath);
      } else {
        return res.status(400).json({ error: `Unknown source type: ${sourceType}` });
      }

      res.json(result);
    } catch (error) {
      console.error("[PluginStore] Install failed:", error.message);
      res.status(500).json({ error: `Install failed: ${error.message}` });
    }
  });

  // #499: the store modal's Uninstall button. Admin-gated like install;
  // pluginStore.uninstall() already contains the name to pluginsDir.
  app.post("/plugins/store/uninstall", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const { name } = req.body || {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    if (!activePluginStore.uninstall(name)) {
      return res.status(404).json({ error: `Plugin ${name} not found` });
    }
    res.json({ success: true, name });
  });

  app.post("/plugins/store/toggle", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const { name, enabled } = req.body || {};

      if (!name || typeof enabled !== "boolean") {
        return res.status(400).json({ error: "name and enabled are required" });
      }
      if (!activePluginStore.get(name)) {
        return res.status(404).json({ error: `Plugin ${name} not found` });
      }

      const result = activePluginSettingsStore.setEnabled(name, enabled);
      res.json({ success: true, name, enabled: result });
    } catch (error) {
      console.error("[PluginStore] Toggle failed:", error.message);
      res.status(500).json({ error: `Toggle failed: ${error.message}` });
    }
  });

  // Issue #492: short-video-gen add-on tier routes (routes/addons.js),
  // previously written but never registered on `app`. Registered here
  // (registerRoutes), not inside startServer() where they were first
  // wired -- checkAdminAuth is a closure private to this function, out of
  // scope in startServer(), so gating them there would throw
  // ReferenceError on the first request. checkAdminAuth-gated like this
  // file's other sensitive routes (/admin/*, /zed/open, /editors/*):
  // node-bot listens on all interfaces with CORS wide open, and /generate
  // spawns real ffmpeg processes (will eventually trigger OAuth-gated
  // publish calls too), so leaving these open would let anyone who can
  // reach this machine's port trigger them.
  app.get("/api/v1/addons/short-video-gen/status/:id", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return handleGetAddonStatus(req, res);
  });
  app.post("/api/v1/addons/short-video-gen/generate", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return handleGenerateVideo(req, res);
  });
  app.post("/api/v1/addons/short-video-gen/consent/:id", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return handleAddonConsent(req, res);
  });
}

module.exports = { registerPluginStoreRoutes };
