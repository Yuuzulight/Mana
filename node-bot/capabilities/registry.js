function requireCapabilityKey(capability) {
  const key = String(capability?.key || "").trim();
  if (!key) {
    throw new Error("capability key is required");
  }
  return key;
}

function registerCapabilities(app, capabilities = [], context = {}) {
  for (const capability of capabilities) {
    requireCapabilityKey(capability);
    if (typeof capability.registerRoutes === "function") {
      capability.registerRoutes(app, context);
    }
  }
}

function buildCapabilityHealth(capabilities = [], context = {}) {
  const components = {};
  for (const capability of capabilities) {
    const key = requireCapabilityKey(capability);
    if (typeof capability.getHealth === "function") {
      components[key] = capability.getHealth(context);
    }
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
  for (const capability of capabilities) {
    if (typeof capability.contributePromptContext !== "function") continue;
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
