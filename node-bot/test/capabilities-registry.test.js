const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCapabilityHealth,
  contributePluginPromptContext,
  registerCapabilities,
} = require("../capabilities/registry");

function fakePluginSettingsStore(overrides = {}) {
  return {
    isEnabled: (key, defaultEnabled) =>
      Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : defaultEnabled,
  };
}

function fakeExpressApp() {
  const routes = [];
  const app = {};
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    app[method] = (routePath, handler) => routes.push({ method, routePath, handler });
  }
  app.routes = routes;
  return app;
}

test("registerCapabilities calls route registration for each routed capability", () => {
  const calls = [];
  const app = { name: "app" };
  const context = { value: 42 };
  const capabilities = [
    {
      key: "alpha",
      registerRoutes: (receivedApp, receivedContext) => {
        calls.push({ key: "alpha", receivedApp, receivedContext });
      },
    },
    {
      key: "statusOnly",
      getHealth: () => ({ status: "configured" }),
    },
    {
      key: "beta",
      registerRoutes: (receivedApp, receivedContext) => {
        calls.push({ key: "beta", receivedApp, receivedContext });
      },
    },
  ];

  registerCapabilities(app, capabilities, context);

  assert.deepEqual(
    calls.map((call) => call.key),
    ["alpha", "beta"],
  );
  assert.equal(calls[0].receivedApp, app);
  assert.equal(calls[0].receivedContext, context);
});

test("buildCapabilityHealth collects health by capability key", () => {
  const context = { ready: true };
  const health = buildCapabilityHealth(
    [
      {
        key: "alpha",
        getHealth: (receivedContext) => ({
          status: receivedContext.ready ? "available" : "unavailable",
          configured: true,
          message: "Alpha is available.",
        }),
      },
      {
        key: "routesOnly",
        registerRoutes: () => {},
      },
    ],
    context,
  );

  assert.deepEqual(health, {
    alpha: {
      status: "available",
      configured: true,
      message: "Alpha is available.",
    },
  });
});

test("registry rejects capabilities without stable keys", () => {
  assert.throws(
    () => registerCapabilities({}, [{ registerRoutes: () => {} }], {}),
    /capability key is required/,
  );
  assert.throws(
    () => buildCapabilityHealth([{ key: "   ", getHealth: () => ({}) }], {}),
    /capability key is required/,
  );
});

test("contributePluginPromptContext returns the first non-empty result in array order", async () => {
  const calls = [];
  const capabilities = [
    {
      key: "alpha",
      contributePromptContext: async (text) => {
        calls.push("alpha");
        return "";
      },
    },
    {
      key: "beta",
      contributePromptContext: async (text, context) => {
        calls.push("beta");
        return `beta says ${text} to ${context.who}`;
      },
    },
    {
      key: "gamma",
      contributePromptContext: async () => {
        calls.push("gamma");
        return "should not run";
      },
    },
  ];

  const result = await contributePluginPromptContext(capabilities, "hi", {
    who: "world",
  });

  assert.equal(result, "beta says hi to world");
  assert.deepEqual(calls, ["alpha", "beta"]);
});

test("contributePluginPromptContext skips capabilities without the hook and swallows errors", async () => {
  const result = await contributePluginPromptContext(
    [
      { key: "noHook" },
      {
        key: "broken",
        contributePromptContext: async () => {
          throw new Error("boom");
        },
      },
      {
        key: "fallback",
        contributePromptContext: async () => "fallback context",
      },
    ],
    "hi",
  );

  assert.equal(result, "fallback context");
});

test("contributePluginPromptContext returns empty string when nothing contributes", async () => {
  const result = await contributePluginPromptContext(
    [{ key: "alpha", contributePromptContext: async () => "" }],
    "hi",
  );

  assert.equal(result, "");
});

// Plugin gating (Settings > Plugins enable/disable): only capabilities with
// a `category` are gated at all -- core capabilities (sessions, presets,
// etc.) have no category and must stay unaffected by the store either way.

test("registerCapabilities lets a disabled plugin's route registration through but 403s each request", () => {
  const app = fakeExpressApp();
  const pluginSettingsStore = fakePluginSettingsStore({ ffxivMarket: false });
  let handlerRan = false;
  const capabilities = [
    {
      key: "ffxivMarket",
      category: "Game Integrations",
      registerRoutes: (routedApp) => {
        routedApp.get("/market/price", (req, res) => {
          handlerRan = true;
          res.status(200).json({ ok: true });
        });
      },
    },
  ];

  registerCapabilities(app, capabilities, { pluginSettingsStore });

  assert.equal(app.routes.length, 1, "route still registers at startup");
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  app.routes[0].handler({}, res);
  assert.equal(handlerRan, false, "the actual handler must not run for a disabled plugin");
  assert.equal(res.code, 403);
  assert.match(res.body.error, /disabled/i);
});

test("registerCapabilities does not gate a capability without a category, even when disabled by key in the store", () => {
  const app = fakeExpressApp();
  const pluginSettingsStore = fakePluginSettingsStore({ sessions: false });
  let handlerRan = false;
  registerCapabilities(
    app,
    [
      {
        key: "sessions",
        registerRoutes: (routedApp) => {
          routedApp.get("/sessions", (req, res) => {
            handlerRan = true;
          });
        },
      },
    ],
    { pluginSettingsStore },
  );

  app.routes[0].handler({}, {});
  assert.equal(handlerRan, true, "core capabilities have no category and are never gated");
});

test("registerCapabilities respects a plugin's defaultEnabled:false with no stored override", () => {
  const app = fakeExpressApp();
  const pluginSettingsStore = fakePluginSettingsStore();
  registerCapabilities(
    app,
    [
      {
        key: "ffxivMarket",
        category: "Game Integrations",
        defaultEnabled: false,
        registerRoutes: (routedApp) => {
          routedApp.get("/market/price", (req, res) => res.status(200).json({ ok: true }));
        },
      },
    ],
    { pluginSettingsStore },
  );

  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  app.routes[0].handler({}, res);
  assert.equal(res.code, 403);
});

test("buildCapabilityHealth reports a disabled component for a gated plugin instead of calling getHealth", () => {
  let getHealthCalled = false;
  const health = buildCapabilityHealth(
    [
      {
        key: "ffxivMarket",
        category: "Game Integrations",
        getHealth: () => {
          getHealthCalled = true;
          return { status: "configured" };
        },
      },
    ],
    { pluginSettingsStore: fakePluginSettingsStore({ ffxivMarket: false }) },
  );

  assert.equal(getHealthCalled, false);
  assert.equal(health.ffxivMarket.status, "disabled");
  assert.equal(health.ffxivMarket.configured, false);
});

test("contributePluginPromptContext skips a disabled plugin's contributePromptContext", async () => {
  let called = false;
  const result = await contributePluginPromptContext(
    [
      {
        key: "ffxivMarket",
        category: "Game Integrations",
        contributePromptContext: async () => {
          called = true;
          return "should not run";
        },
      },
    ],
    "hi",
    { pluginSettingsStore: fakePluginSettingsStore({ ffxivMarket: false }) },
  );

  assert.equal(called, false);
  assert.equal(result, "");
});

test("an enabled plugin behaves exactly as if ungated", () => {
  const app = fakeExpressApp();
  let handlerRan = false;
  registerCapabilities(
    app,
    [
      {
        key: "ffxivMarket",
        category: "Game Integrations",
        registerRoutes: (routedApp) => {
          routedApp.get("/market/price", (req, res) => {
            handlerRan = true;
          });
        },
      },
    ],
    { pluginSettingsStore: fakePluginSettingsStore({ ffxivMarket: true }) },
  );

  app.routes[0].handler({}, {});
  assert.equal(handlerRan, true);
});
