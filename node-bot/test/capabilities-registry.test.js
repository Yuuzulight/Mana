const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCapabilityHealth,
  contributePluginPromptContext,
  registerCapabilities,
} = require("../capabilities/registry");

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
