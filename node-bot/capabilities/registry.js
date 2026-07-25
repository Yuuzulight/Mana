function requireCapabilityKey(capability) {
  const key = String(capability?.key || "").trim();
  if (!key) {
    throw new Error("capability key is required");
  }
  return key;
}

// Capabilities with a `category` are "plugins" in the GET /plugins sense
// (see server.js's /plugins route) -- optional integrations a user can
// toggle from Settings > Plugins, as opposed to core capabilities like
// sessions/presets that are always on. This is the one place that
// distinction is enforced, across all three ways a plugin can act:
// registering routes, contributing chat-prompt context, and reporting
// health -- so gating a plugin here covers it everywhere, not just the
// dedicated UI that happens to call its routes.
function isPluginEnabled(capability, pluginSettingsStore) {
  if (!capability.category || !pluginSettingsStore) return true;
  return pluginSettingsStore.isEnabled(capability.key, capability.defaultEnabled !== false);
}

function disabledPluginMessage(capability) {
  return `${capability.name || capability.key} is disabled. Enable it in Settings > Plugins.`;
}

// Express has no clean way to unregister a route, so a disabled plugin's
// routes still get registered at startup -- this wraps app.get/post/etc
// for just that one capability's registerRoutes call, so every handler it
// registers checks the enabled flag per-request instead. Toggling in
// Settings takes effect immediately, no restart required.
function gatedApp(app, capability, pluginSettingsStore) {
  const methods = ["get", "post", "put", "patch", "delete"];
  const wrapped = Object.create(app);
  for (const method of methods) {
    wrapped[method] = (routePath, ...handlers) => {
      const guardedHandlers = handlers.map((handler) =>
        typeof handler === "function"
          ? (req, res, next) => {
              if (!isPluginEnabled(capability, pluginSettingsStore)) {
                return res.status(403).json({ error: disabledPluginMessage(capability) });
              }
              return handler(req, res, next);
            }
          : handler,
      );
      return app[method](routePath, ...guardedHandlers);
    };
  }
  return wrapped;
}

function registerCapabilities(app, capabilities = [], context = {}) {
  const pluginSettingsStore = context.pluginSettingsStore;
  for (const capability of capabilities) {
    requireCapabilityKey(capability);
    if (typeof capability.registerRoutes === "function") {
      const targetApp =
        capability.category && pluginSettingsStore
          ? gatedApp(app, capability, pluginSettingsStore)
          : app;
      capability.registerRoutes(targetApp, context);
    }
  }
}

function buildCapabilityHealth(capabilities = [], context = {}) {
  const components = {};
  const pluginSettingsStore = context.pluginSettingsStore;
  for (const capability of capabilities) {
    const key = requireCapabilityKey(capability);
    if (typeof capability.getHealth !== "function") continue;
    if (!isPluginEnabled(capability, pluginSettingsStore)) {
      components[key] = {
        status: "disabled",
        configured: false,
        message: disabledPluginMessage(capability),
      };
      continue;
    }
    components[key] = capability.getHealth(context);
  }
  return components;
}

// Generic replacement for hardcoding each plugin's prompt-context builder by
// name in server-routes.js (issue #108). Capabilities/plugins that want to
// inject context into Mana's chat replies expose contributePromptContext(text,
// context); this tries each in array order and returns the first non-empty
// result, same priority order the array already encodes for routes/health.
// Each plugin's own builder decides whether the text is relevant to it (see
// e.g. buildCraftProfitContextForPrompt's internal textLooksLike* guard) --
// this loop doesn't re-implement that detection.
async function contributePluginPromptContext(capabilities = [], text, context = {}) {
  const pluginSettingsStore = context.pluginSettingsStore;
  for (const capability of capabilities) {
    if (typeof capability.contributePromptContext !== "function") continue;
    if (!isPluginEnabled(capability, pluginSettingsStore)) continue;
    try {
      const result = await capability.contributePromptContext(text, context);
      if (result) return result;
    } catch (error) {
      console.warn(
        `Optional ${capability.key || "plugin"} prompt context unavailable:`,
        error.message,
      );
    }
  }
  return "";
}

module.exports = {
  buildCapabilityHealth,
  contributePluginPromptContext,
  registerCapabilities,
};
