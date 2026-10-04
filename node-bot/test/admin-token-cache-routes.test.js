const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const express = require("express");

const { cachePath, registerAdminTokenCacheRoutes } = require("../admin-token-cache-routes");

function makeApp({ authed = true, dataDir, fetchImpl, env } = {}) {
  const app = express();
  app.use(express.json());
  registerAdminTokenCacheRoutes(app, {
    dataDir,
    env,
    fetchImpl,
    checkAdminAuth: (req, res) => authed || (res.status(401).json({ ok: false, error: "no" }), false),
  });
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function withServer(app, fn) {
  const { server, baseUrl } = await listen(app);
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("admin token-cache routes list and evict cache keys", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-token-cache-"));
  const one = path.resolve("node-bot/server.js");
  const two = path.resolve("node-bot/other.js");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(cachePath(dataDir), JSON.stringify({ [one]: 123, [two]: 456 }), "utf8");

  await withServer(makeApp({ dataDir }), async (baseUrl) => {
    const listed = await (await fetch(`${baseUrl}/admin/token-cache`)).json();
    assert.deepEqual(listed, { ok: true, keys: [one, two], count: 2 });

    const evicted = await (await fetch(`${baseUrl}/admin/token-cache/evict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: one }),
    })).json();
    assert.deepEqual(evicted, { ok: true, evicted: one });

    const after = JSON.parse(fs.readFileSync(cachePath(dataDir), "utf8"));
    assert.deepEqual(after, { [two]: 456 });
  });
});

test("admin token-cache routes keep the admin gate and validate evict input", async () => {
  await withServer(makeApp({ authed: false, dataDir: os.tmpdir() }), async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/admin/token-cache`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/admin/token-cache/evict`, { method: "POST" })).status, 401);
  });

  await withServer(makeApp({ dataDir: os.tmpdir() }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/admin/token-cache/evict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: "path required" });
  });
});

test("admin token-cache metrics proxy parses JSON and reports bad upstream bodies", async () => {
  const calls = [];
  await withServer(makeApp({
    env: { PY_TOKEN_SERVER_PORT: "9191", PY_TOKEN_SERVER_SECRET: "secret" },
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { text: async () => JSON.stringify({ metrics: { hits: 2 } }) };
    },
  }), async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/admin/token-cache-metrics`)).json();
    assert.deepEqual(body, { ok: true, metrics: { hits: 2 } });
    assert.equal(calls[0].url, "http://127.0.0.1:9191/metrics");
    assert.deepEqual(calls[0].opts, { headers: { Authorization: "Bearer secret" }, method: "GET" });
  });

  await withServer(makeApp({
    fetchImpl: async () => ({ text: async () => "not json" }),
  }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/admin/token-cache-metrics`);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { ok: false, error: "invalid_metrics_response" });
  });
});
