// Isolates the auth data directory from the real node-bot/data/auth/ before
// requiring server.js, since its authStore is a module-level singleton
// created at require time (see auth-store.js's dataDir resolution). Without
// this, running these tests would read/write the real accounts.json.
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tempAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-admin-routes-test-"));
process.env.MANA_AUTH_DIR = tempAuthDir;

const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../server");
const { createAuthStore } = require("../auth-store");
const { withServer } = require("./helpers");

// Same dataDir the module-level authStore in server.js resolved to via
// MANA_AUTH_DIR above, so accounts created here are visible to the app.
const authStore = createAuthStore({ dataDir: tempAuthDir });

test.after(() => {
  fs.rmSync(tempAuthDir, { recursive: true, force: true });
  delete process.env.MANA_AUTH_DIR;
});

test("GET /api/memory rejects requests with no Authorization header", async () => {
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/memory`);
    assert.equal(res.status, 401);
  });
});

test("GET /api/memory rejects an invalid API key", async () => {
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/memory`, {
      headers: { Authorization: "Bearer not-a-real-key" },
    });
    assert.equal(res.status, 401);
  });
});

test("GET /api/memory returns markdown for a valid key (admin or user role)", async () => {
  const { apiKey } = authStore.createAccount({
    email: "member@example.com",
    role: "user",
  });
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/memory`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/markdown/);
    const body = await res.text();
    assert.match(body, /# Mana Memory/);
  });
});

test("POST /admin/accounts rejects a user-role key with 403", async () => {
  const { apiKey } = authStore.createAccount({
    email: "not-admin@example.com",
    role: "user",
  });
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/admin/accounts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "new@example.com" }),
    });
    assert.equal(res.status, 403);
  });
});

test("POST /admin/accounts succeeds for an admin-role key from a local request", async () => {
  const { apiKey } = authStore.createAccount({
    email: "admin-local@example.com",
    role: "admin",
  });
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/admin/accounts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "created-locally@example.com" }),
    });
    assert.equal(res.status, 201);
    const payload = await res.json();
    assert.ok(payload.apiKey);
  });
});

test("POST /admin/accounts rejects an admin-role key from a non-local origin with no ADMIN_TOKEN configured", async () => {
  const prior = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  const { apiKey } = authStore.createAccount({
    email: "admin-remote@example.com",
    role: "admin",
  });
  const app = createApp();
  try {
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/accounts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.5",
        },
        body: JSON.stringify({ email: "should-not-be-created@example.com" }),
      });
      assert.equal(res.status, 403);
    });
  } finally {
    if (prior === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prior;
  }
});

test("POST /admin/accounts succeeds from a non-local origin when a matching x-admin-token is presented", async () => {
  const prior = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "test-admin-token-for-remote-account-mgmt";
  const { apiKey } = authStore.createAccount({
    email: "admin-remote-with-token@example.com",
    role: "admin",
  });
  const app = createApp();
  try {
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/accounts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.5",
          "x-admin-token": "test-admin-token-for-remote-account-mgmt",
        },
        body: JSON.stringify({ email: "created-remotely@example.com" }),
      });
      assert.equal(res.status, 201);
    });
  } finally {
    if (prior === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prior;
  }
});
