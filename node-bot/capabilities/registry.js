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

module.exports = {
  buildCapabilityHealth,
  registerCapabilities,
};
