const assert = require("node:assert/strict");
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const browserAutomationPlugin = require("../index");
const { snapshotInPage, extractTextInPage } = require("../browser-automation");

async function withServer(app, fn) {
  const http = require("node:http");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json();
  return { response, payload };
}

function buildApp(deps) {
  browserAutomationPlugin._resetForTests();
  const app = express();
  app.use(express.json());
  browserAutomationPlugin.registerRoutes(app, deps);
  return app;
}

test("resolveExecutablePath prefers MANA_BROWSER_EXECUTABLE_PATH over the Edge default", () => {
  const path = browserAutomationPlugin.resolveExecutablePath(
    { MANA_BROWSER_EXECUTABLE_PATH: "C:\\custom\\chrome.exe" },
    { existsSync: () => true },
  );
  assert.equal(path, "C:\\custom\\chrome.exe");
});

test("resolveExecutablePath falls back to a detected Edge install, or null if none exists", () => {
  const found = browserAutomationPlugin.resolveExecutablePath({}, { existsSync: () => true });
  assert.match(found, /msedge\.exe$/);

  const notFound = browserAutomationPlugin.resolveExecutablePath({}, { existsSync: () => false });
  assert.equal(notFound, null);
});

test("every route rejects a non-loopback forwarded request without touching the browser", async () => {
  let sessionCalls = 0;
  const app = buildApp({
    isLocalRestartRequest: () => false,
    chromium: { launch: async () => { sessionCalls += 1; return {}; } },
  });

  await withServer(app, async (baseUrl) => {
    for (const route of ["navigate", "snapshot", "click", "type", "close"]) {
      const { response, payload } = await postJson(`${baseUrl}/browser/${route}`, {
        url: "https://example.com",
      });
      assert.equal(response.status, 403, `${route} should reject`);
      assert.deepEqual(payload, { error: "this endpoint is only available from this PC" });
    }
  });
  assert.equal(sessionCalls, 0);
});

test("POST /browser/navigate surfaces a clear error when no browser executable is configured", async () => {
  const app = buildApp({
    isLocalRestartRequest: () => true,
    env: { MANA_BROWSER_EXECUTABLE_PATH: "" },
  });
  // Force "not found" by pointing at a path that can't exist.
  const originalExists = require("fs").existsSync;
  require("fs").existsSync = () => false;
  try {
    await withServer(app, async (baseUrl) => {
      const { response, payload } = await postJson(`${baseUrl}/browser/navigate`, {
        url: "https://example.com",
      });
      assert.equal(response.status, 400);
      assert.match(payload.error, /no browser executable found/);
    });
  } finally {
    require("fs").existsSync = originalExists;
  }
});

test("POST /browser/navigate drives an injected fake chromium/page end to end", async () => {
  const fakePage = {
    async goto(url) { this._url = url; },
    async evaluate(fn) {
      if (fn === snapshotInPage) return [{ ref: "1", tag: "button", role: null, label: "Go" }];
      if (fn === extractTextInPage) return "page text";
      throw new Error("unexpected evaluate() call in test");
    },
    async title() { return "Example"; },
    async url() { return this._url; },
  };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {} };
  const fakeChromium = { launch: async () => fakeBrowser };

  const app = buildApp({
    isLocalRestartRequest: () => true,
    env: { MANA_BROWSER_EXECUTABLE_PATH: "C:\\fake\\browser.exe" },
    chromium: fakeChromium,
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/browser/navigate`, {
      url: "https://example.com",
    });
    assert.equal(response.status, 200);
    assert.equal(payload.title, "Example");
    assert.equal(payload.text, "page text");
    assert.equal(payload.interactiveElements[0].ref, "1");
  });
});

test("plugin metadata matches the shape other Mana plugins use", () => {
  assert.equal(browserAutomationPlugin.key, "browserAutomation");
  assert.equal(browserAutomationPlugin.category, "Web");
  assert.equal(browserAutomationPlugin.defaultEnabled, false);
});
