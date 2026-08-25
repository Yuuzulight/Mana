const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const { withServer } = require("./helpers");
const matrixBridgePlugin = require("../index");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-matrix-cap-"));
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
  matrixBridgePlugin._resetForTests();
  const app = express();
  app.use(express.json());
  matrixBridgePlugin.registerRoutes(app, { dataDir: createTempDir(), ...deps });
  return app;
}

test("GET /matrix/pending and /matrix/approved start empty", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const pending = await (await fetch(`${baseUrl}/matrix/pending`)).json();
    const approved = await (await fetch(`${baseUrl}/matrix/approved`)).json();
    assert.deepEqual(pending, { pending: [] });
    assert.deepEqual(approved, { approved: [] });
  });
});

test("POST /matrix/approve with an unknown code returns 404", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/matrix/approve`, { code: "NOPE12" });
    assert.equal(response.status, 404);
    assert.match(payload.error, /no pending pairing/);
  });
});

test("a full pending -> approve -> approved flow through the routes", async () => {
  const dataDir = createTempDir();
  const app = buildApp({ dataDir });

  await withServer(app, async (baseUrl) => {
    // Drive a message directly through the bridge the routes share, since
    // there's no HTTP route for "incoming Matrix message" (that only
    // happens via the sync loop) -- reach the same bridge instance the
    // routes use via getBridge()'s module-level singleton.
    const { createMatrixBridge } = require("../matrix-bridge");
    const directBridge = createMatrixBridge({ dataDir });
    const reply = await directBridge.handleIncomingMessage({ roomId: "!room:example.org", text: "hi" });
    const code = reply.match(/: (\w{6})$/)[1];

    const pendingBefore = await (await fetch(`${baseUrl}/matrix/pending`)).json();
    assert.equal(pendingBefore.pending.length, 1);

    const { response, payload } = await postJson(`${baseUrl}/matrix/approve`, { code });
    assert.equal(response.status, 200);
    assert.equal(payload.roomId, "!room:example.org");

    const approvedAfter = await (await fetch(`${baseUrl}/matrix/approved`)).json();
    assert.equal(approvedAfter.approved.length, 1);
    const pendingAfter = await (await fetch(`${baseUrl}/matrix/pending`)).json();
    assert.equal(pendingAfter.pending.length, 0);
  });
});

test("plugin metadata matches the shape other Mana plugins use", () => {
  assert.equal(matrixBridgePlugin.key, "matrixBridge");
  assert.equal(matrixBridgePlugin.category, "Messaging");
  assert.equal(matrixBridgePlugin.defaultEnabled, false);
});

test("#435 review: _nextDelayAfterErrorForTests backs off to a 429's retryAfterMs, never below the normal interval", () => {
  const nextDelay = matrixBridgePlugin._nextDelayAfterErrorForTests;

  assert.equal(nextDelay(Object.assign(new Error("sync failed: 429"), { retryAfterMs: 5000 }), 1000), 5000);
  // A retryAfterMs shorter than the normal interval never shortens the wait.
  assert.equal(nextDelay(Object.assign(new Error("sync failed: 429"), { retryAfterMs: 200 }), 1000), 1000);
  // A non-429 failure (no retryAfterMs at all) keeps the normal interval.
  assert.equal(nextDelay(new Error("sync failed: 500"), 1000), 1000);
  assert.equal(nextDelay(null, 1000), 1000);
});

test("getHealth reports unavailable when unconfigured and configured once all three env vars are set", () => {
  const unset = matrixBridgePlugin.getHealth({ env: {} });
  assert.equal(unset.status, "unavailable");
  assert.equal(unset.configured, false);

  const partial = matrixBridgePlugin.getHealth({
    env: { MANA_MATRIX_HOMESERVER_URL: "https://example.org", MANA_MATRIX_ACCESS_TOKEN: "tok" },
  });
  assert.equal(partial.configured, false);

  const full = matrixBridgePlugin.getHealth({
    env: {
      MANA_MATRIX_HOMESERVER_URL: "https://example.org",
      MANA_MATRIX_ACCESS_TOKEN: "tok",
      MANA_MATRIX_USER_ID: "@mana:example.org",
    },
  });
  assert.equal(full.status, "configured");
  assert.equal(full.configured, true);
});
