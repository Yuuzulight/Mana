const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const { withServer } = require("./helpers");
const telegramBridgePlugin = require("../index");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-telegram-cap-"));
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
  telegramBridgePlugin._resetForTests();
  const app = express();
  app.use(express.json());
  telegramBridgePlugin.registerRoutes(app, { dataDir: createTempDir(), ...deps });
  return app;
}

test("GET /telegram/pending and /telegram/approved start empty", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const pending = await (await fetch(`${baseUrl}/telegram/pending`)).json();
    const approved = await (await fetch(`${baseUrl}/telegram/approved`)).json();
    assert.deepEqual(pending, { pending: [] });
    assert.deepEqual(approved, { approved: [] });
  });
});

test("POST /telegram/approve with an unknown code returns 404", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/telegram/approve`, { code: "NOPE12" });
    assert.equal(response.status, 404);
    assert.match(payload.error, /no pending pairing/);
  });
});

test("a full pending -> approve -> approved flow through the routes", async () => {
  const dataDir = createTempDir();
  const app = buildApp({ dataDir });

  await withServer(app, async (baseUrl) => {
    // Drive a message directly through the bridge the routes share, since
    // there's no HTTP route for "incoming Telegram message" (that only
    // happens via the poll loop) -- reach the same bridge instance the
    // routes use via getBridge()'s module-level singleton.
    const { createTelegramBridge } = require("../telegram-bridge");
    const directBridge = createTelegramBridge({ dataDir });
    const reply = await directBridge.handleIncomingMessage({ chatId: 999, text: "hi" });
    const code = reply.match(/: (\w{6})$/)[1];

    const pendingBefore = await (await fetch(`${baseUrl}/telegram/pending`)).json();
    assert.equal(pendingBefore.pending.length, 1);

    const { response, payload } = await postJson(`${baseUrl}/telegram/approve`, { code });
    assert.equal(response.status, 200);
    assert.equal(payload.chatId, "999");

    const approvedAfter = await (await fetch(`${baseUrl}/telegram/approved`)).json();
    assert.equal(approvedAfter.approved.length, 1);
    const pendingAfter = await (await fetch(`${baseUrl}/telegram/pending`)).json();
    assert.equal(pendingAfter.pending.length, 0);
  });
});

test("plugin metadata matches the shape other Mana plugins use", () => {
  assert.equal(telegramBridgePlugin.key, "telegramBridge");
  assert.equal(telegramBridgePlugin.category, "Messaging");
  assert.equal(telegramBridgePlugin.defaultEnabled, false);
});

test("getHealth reports unavailable without a bot token and configured with one", () => {
  const withoutToken = telegramBridgePlugin.getHealth({ env: {} });
  assert.equal(withoutToken.status, "unavailable");
  assert.equal(withoutToken.configured, false);

  const withToken = telegramBridgePlugin.getHealth({ env: { MANA_TELEGRAM_BOT_TOKEN: "abc" } });
  assert.equal(withToken.status, "configured");
  assert.equal(withToken.configured, true);
});
