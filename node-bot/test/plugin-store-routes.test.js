const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");

function fakePluginStore(overrides = {}) {
  return {
    list: () => [],
    get: () => null,
    installFromGitHub: async () => ({ success: true, name: "installed-plugin" }),
    installFromLocal: async () => ({ success: true, name: "installed-plugin" }),
    ...overrides,
  };
}

function fakePluginSettingsStore(overrides = {}) {
  const enabled = new Map();
  const consent = new Map();
  return {
    isEnabled: (key, defaultEnabled = true) =>
      enabled.has(key) ? enabled.get(key) : defaultEnabled,
    setEnabled: (key, value) => {
      enabled.set(key, Boolean(value));
      return enabled.get(key);
    },
    getConsent: (key) => consent.get(key) === true,
    setConsent: (key, value) => {
      consent.set(key, Boolean(value));
      return consent.get(key);
    },
    ...overrides,
  };
}

// #492/#500 review: these 5 routes used to live in startServer(), bolted
// onto `app` after createApp() already returned -- unreachable by any test
// using this codebase's actual pattern (createApp(deps) + withServer()).
// Moved into registerRoutes() so they're injectable/testable like every
// other route here; these tests exercise the real bugs that were found and
// fixed in the process.

test("GET /plugins/store combines installed and available plugins, with enabled state from pluginSettingsStore", async () => {
  const pluginStore = fakePluginStore({
    list: () => [{ name: "my-plugin", version: "1.0.0", description: "does a thing" }],
  });
  const pluginSettingsStore = fakePluginSettingsStore();
  pluginSettingsStore.setEnabled("my-plugin", false);

  const app = createApp({
    pluginStore,
    pluginSettingsStore,
    fetchAvailablePlugins: async () => [{ name: "official-plugin/" }],
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/plugins/store`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.installed.length, 1);
    assert.equal(body.installed[0].name, "my-plugin");
    assert.equal(body.available.length, 1);
    assert.equal(body.available[0].name, "official-plugin");

    const installedEntry = body.all.find((p) => p.name === "my-plugin");
    assert.equal(installedEntry.enabled, false);
    assert.ok(body.plugins.some((p) => p.name === "my-plugin"));
  });
});

test("GET /plugins/store surfaces a 500 instead of crashing when fetchAvailablePlugins fails", async () => {
  const app = createApp({
    pluginStore: fakePluginStore(),
    pluginSettingsStore: fakePluginSettingsStore(),
    fetchAvailablePlugins: async () => {
      throw new Error("network unreachable");
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/plugins/store`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.error, /network unreachable/);
  });
});

test("GET /addons/consent/:name reports consent status and whether it's required -- regression for the shadowed pluginSettingsStore bug", async () => {
  const pluginSettingsStore = fakePluginSettingsStore();
  pluginSettingsStore.setConsent("addon_consent_@mana/inference-gateway", true);
  const app = createApp({ pluginSettingsStore });

  await withServer(app, async (baseUrl) => {
    const consented = await (
      await fetch(`${baseUrl}/addons/consent/${encodeURIComponent("@mana/inference-gateway")}`)
    ).json();
    assert.equal(consented.consented, true);
    assert.equal(consented.required, true);

    const notConsented = await (await fetch(`${baseUrl}/addons/consent/regular-plugin`)).json();
    assert.equal(notConsented.consented, false);
    assert.equal(notConsented.required, false);
  });
});

test("POST /addons/consent/:name records consent -- regression for the shadowed pluginSettingsStore bug", async () => {
  const pluginSettingsStore = fakePluginSettingsStore();
  const app = createApp({ pluginSettingsStore });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/addons/consent/${encodeURIComponent("@mana/inference-gateway")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consented: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(pluginSettingsStore.getConsent("addon_consent_@mana/inference-gateway"), true);
  });
});

test("POST /addons/consent/:name rejects a missing/non-boolean consented field", async () => {
  const app = createApp({ pluginSettingsStore: fakePluginSettingsStore() });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/addons/consent/${encodeURIComponent("@mana/inference-gateway")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
  });
});

test("POST /plugins/store/install routes github/local source types to the matching pluginStore method", async () => {
  const calls = [];
  const pluginStore = fakePluginStore({
    installFromGitHub: async (url) => {
      calls.push({ method: "github", url });
      return { success: true, name: "from-github" };
    },
    installFromLocal: async (p) => {
      calls.push({ method: "local", path: p });
      return { success: true, name: "from-local" };
    },
  });
  const app = createApp({ pluginStore, pluginSettingsStore: fakePluginSettingsStore() });

  await withServer(app, async (baseUrl) => {
    const githubResult = await (
      await fetch(`${baseUrl}/plugins/store/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceType: "github", urlOrPath: "https://github.com/a/b" }),
      })
    ).json();
    assert.equal(githubResult.name, "from-github");

    const localResult = await (
      await fetch(`${baseUrl}/plugins/store/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceType: "local", urlOrPath: "/tmp/some-plugin" }),
      })
    ).json();
    assert.equal(localResult.name, "from-local");

    assert.deepEqual(calls, [
      { method: "github", url: "https://github.com/a/b" },
      { method: "local", path: "/tmp/some-plugin" },
    ]);
  });
});

test("POST /plugins/store/install rejects a missing sourceType/urlOrPath or an unknown sourceType", async () => {
  const app = createApp({ pluginStore: fakePluginStore(), pluginSettingsStore: fakePluginSettingsStore() });

  await withServer(app, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/plugins/store/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    const unknown = await fetch(`${baseUrl}/plugins/store/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceType: "ftp", urlOrPath: "x" }),
    });
    assert.equal(unknown.status, 400);
  });
});

test("POST /plugins/store/toggle persists the enabled state via pluginSettingsStore.setEnabled -- regression for the nonexistent togglePlugin() call", async () => {
  const pluginStore = fakePluginStore({ get: (name) => (name === "my-plugin" ? { name } : null) });
  const pluginSettingsStore = fakePluginSettingsStore();
  const app = createApp({ pluginStore, pluginSettingsStore });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/plugins/store/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "my-plugin", enabled: false }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(pluginSettingsStore.isEnabled("my-plugin"), false);
  });
});

test("POST /plugins/store/toggle 404s for a plugin that isn't actually installed", async () => {
  const pluginStore = fakePluginStore({ get: () => null });
  const app = createApp({ pluginStore, pluginSettingsStore: fakePluginSettingsStore() });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/plugins/store/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "never-installed", enabled: true }),
    });
    assert.equal(response.status, 404);
  });
});

test("POST /plugins/store/toggle rejects a missing name or non-boolean enabled", async () => {
  const app = createApp({ pluginStore: fakePluginStore(), pluginSettingsStore: fakePluginSettingsStore() });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/plugins/store/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "my-plugin" }),
    });
    assert.equal(response.status, 400);
  });
});
