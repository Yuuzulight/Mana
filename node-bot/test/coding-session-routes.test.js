const test = require("node:test");
const assert = require("node:assert");
const { createApp } = require("../server");

function makeTestApp(options = {}) {
  const adminToken = "test-admin";
  return {
    app: createApp({
      env: {
        NODE_ENV: "test",
        ADMIN_TOKEN: adminToken,
        ...options.env,
      },
      ...options,
    }),
    adminToken,
  };
}

test("Coding Session Endpoints Suite (#1343 Phase 3)", async (t) => {
  await t.test("GET /coding-session/status returns inactive by default", async () => {
    const { app, adminToken } = makeTestApp();
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/coding-session/status`, {
        headers: { "x-admin-token": adminToken },
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.active, false);
      assert.strictEqual(typeof json.isGaming, "boolean");
    } finally {
      server.close();
    }
  });

  await t.test("POST /coding-session/start activates session with audio masking phrase", async () => {
    const { app, adminToken } = makeTestApp();
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const startRes = await fetch(`http://127.0.0.1:${port}/coding-session/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": adminToken,
        },
        body: JSON.stringify({ sessionId: "test-session-123" }),
      });
      assert.strictEqual(startRes.status, 200);
      const startJson = await startRes.json();
      assert.strictEqual(startJson.ok, true);
      assert.strictEqual(startJson.maskingPhrase, "Opening the dev workspace...");

      // Status reflects active
      const statusRes = await fetch(`http://127.0.0.1:${port}/coding-session/status?sessionId=test-session-123`, {
        headers: { "x-admin-token": adminToken },
      });
      const statusJson = await statusRes.json();
      assert.strictEqual(statusJson.active, true);

      // Stop session
      const stopRes = await fetch(`http://127.0.0.1:${port}/coding-session/stop`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": adminToken,
        },
        body: JSON.stringify({ sessionId: "test-session-123" }),
      });
      assert.strictEqual(stopRes.status, 200);
      const stopJson = await stopRes.json();
      assert.strictEqual(stopJson.ok, true);

      // Status reflects inactive
      const finalStatusRes = await fetch(`http://127.0.0.1:${port}/coding-session/status?sessionId=test-session-123`, {
        headers: { "x-admin-token": adminToken },
      });
      const finalStatusJson = await finalStatusRes.json();
      assert.strictEqual(finalStatusJson.active, false);
    } finally {
      server.close();
    }
  });
});
