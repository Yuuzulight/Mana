const assert = require("node:assert/strict");
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const contextPushPlugin = require("../index");

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

function buildApp(deps) {
  contextPushPlugin.store.clear();
  const app = express();
  app.use(express.json());
  contextPushPlugin.registerRoutes(app, deps);
  return app;
}

test("POST /context/push rejects non-local requests", async () => {
  const app = buildApp({ isLocalRestartRequest: () => false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/context/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert.equal(response.status, 403);
  });
});

test("POST /context/push accepts a local request and stores the entry", async () => {
  const app = buildApp({ isLocalRestartRequest: () => true });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/context/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", title: "Example", text: "hi" }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);

    const status = await (await fetch(`${baseUrl}/context/status`)).json();
    assert.equal(status.active, true);
    assert.equal(status.url, "https://example.com");
  });
});

test("POST /context/push without a url returns 400", async () => {
  const app = buildApp({ isLocalRestartRequest: () => true });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/context/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "no url" }),
    });
    assert.equal(response.status, 400);
  });
});

test("GET /context/status rejects non-local requests too", async () => {
  const app = buildApp({ isLocalRestartRequest: () => false });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/context/status`);
    assert.equal(response.status, 403);
  });
});

test("GET /context/status reports inactive when nothing has been pushed", async () => {
  const app = buildApp({ isLocalRestartRequest: () => true });
  await withServer(app, async (baseUrl) => {
    const status = await (await fetch(`${baseUrl}/context/status`)).json();
    assert.equal(status.active, false);
  });
});

test("plugin metadata: off by default, key/category set", () => {
  assert.equal(contextPushPlugin.key, "contextPush");
  assert.equal(contextPushPlugin.defaultEnabled, false);
  assert.equal(contextPushPlugin.category, "Knowledge");
});

test("getHealth reflects current tracking state", () => {
  contextPushPlugin.store.clear();
  assert.match(contextPushPlugin.getHealth().message, /No active browser context/);
  contextPushPlugin.store.push({ url: "https://example.com", title: "Example" });
  assert.match(contextPushPlugin.getHealth().message, /Example/);
  contextPushPlugin.store.clear();
});
