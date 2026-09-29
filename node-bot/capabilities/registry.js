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

const DEFAULT_INPUT_HOOK_PRIORITY = 100;
const INPUT_HOOK_TIMEOUT_MS = 200;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

// Issue #677: plugins that export onUserInput(input, context) see (and can
// act on) the user's message before the prompt is built. Unlike
// contributePromptContext's first-wins contest, every enabled plugin runs,
// lowest inputHookPriority first (default 100; sort is stable, so ties keep
// capabilities-array order), each seeing the text as rewritten by the ones
// before it. A hook may return { text } (rewrite), { promptPatch: { system,
// user } } (patches accumulate), and/or { reply } (short-circuit: stops the
// chain, the caller skips the model). Fail-open: a hook that throws or takes
// longer than INPUT_HOOK_TIMEOUT_MS is logged and skipped, so one slow plugin
// can't stall a voice reply (ponytail: the late hook keeps running and a
// synchronous busy loop can't be cut off; a worker per hook if that bites). It never touches tool calls, so nothing here can
// get around the approval gate -- a rewritten message still goes through the
// normal model/tool path, and a short-circuit reply skips tools entirely.
async function runPluginInputHooks(capabilities = [], input = {}, context = {}) {
  const pluginSettingsStore = context.pluginSettingsStore;
  const priority = (capability) =>
    Number.isFinite(capability.inputHookPriority)
      ? capability.inputHookPriority
      : DEFAULT_INPUT_HOOK_PRIORITY;
  const hooked = capabilities
    .filter(
      (capability) =>
        typeof capability.onUserInput === "function" &&
        isPluginEnabled(capability, pluginSettingsStore),
    )
    .sort((a, b) => priority(a) - priority(b));

  let text = String(input.text || "");
  const system = [];
  const user = [];
  const result = (reply = "") => ({
    text,
    systemPatch: system.join("\n\n"),
    userPatch: user.join("\n\n"),
    reply,
  });

  for (const capability of hooked) {
    const key = capability.key || "plugin";
    let timer;
    try {
      const output = await Promise.race([
        Promise.resolve().then(() => capability.onUserInput({ ...input, text }, context)),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${INPUT_HOOK_TIMEOUT_MS}ms`)),
            INPUT_HOOK_TIMEOUT_MS,
          );
        }),
      ]);
      if (!output || typeof output !== "object") continue;
      const rewritten = nonEmptyString(output.text);
      if (rewritten && rewritten !== text) {
        console.log(
          `[plugin input] ${key} rewrote ${JSON.stringify(text)} -> ${JSON.stringify(rewritten)}`,
        );
        text = rewritten;
      }
      if (nonEmptyString(output.promptPatch?.system)) system.push(output.promptPatch.system);
      if (nonEmptyString(output.promptPatch?.user)) user.push(output.promptPatch.user);
      const reply = nonEmptyString(output.reply);
      if (reply) {
        console.log(`[plugin input] ${key} answered ${JSON.stringify(text)} without the model`);
        return result(reply);
      }
    } catch (error) {
      console.warn(`Plugin ${key} input hook skipped:`, error?.message || error);
    } finally {
      clearTimeout(timer);
    }
  }
  return result();
}

module.exports = {
  buildCapabilityHealth,
  contributePluginPromptContext,
  runPluginInputHooks,
  registerCapabilities,
  isPluginEnabled,
};
