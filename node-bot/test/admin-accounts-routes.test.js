// Isolates the auth data directory from the real node-bot/data/auth/ before
// requiring server.js, since its authStore is a module-level singleton
// created at require time (see auth-store.js's dataDir resolution). Without
// this, running these tests would read/write the real accounts.json.
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tempAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-admin-routes-test-"));
process.env.MANA_AUTH_DIR = tempAuthDir;
// #670: admin-key.js reads the native launcher's per-run key once, at
// require time, and removes it from process.env.
const LAUNCHER_KEY = "test-launcher-key-0123456789abcdef";
process.env.MANA_LAUNCHER_KEY = LAUNCHER_KEY;

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

test("the launcher key is removed from process.env once read (#670)", () => {
  assert.equal(process.env.MANA_LAUNCHER_KEY, undefined);
});

async function postAccountAsAdmin(email, extraHeaders) {
  const { apiKey } = authStore.createAccount({ email: `admin-${email}`, role: "admin" });
  const app = createApp();
  let res;
  await withServer(app, async (baseUrl) => {
    res = await fetch(`${baseUrl}/admin/accounts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify({ email }),
    });
  });
  return res;
}

test("POST /admin/accounts rejects an admin-role key from a local request with no admin key (#670)", async () => {
  const res = await postAccountAsAdmin("local-no-key@example.com", {});
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /ADMIN_TOKEN/);
});

test("POST /admin/accounts succeeds locally with the launcher's per-run key", async () => {
  const res = await postAccountAsAdmin("local-launcher@example.com", { "x-admin-token": LAUNCHER_KEY });
  assert.equal(res.status, 201);
  assert.ok((await res.json()).apiKey);
});

test("POST /admin/accounts: the launcher key doesn't count from another device, or when wrong", async () => {
  const forwarded = await postAccountAsAdmin("remote-launcher@example.com", {
    "x-admin-token": LAUNCHER_KEY,
    "X-Forwarded-For": "203.0.113.5",
  });
  assert.equal(forwarded.status, 403);
  const wrong = await postAccountAsAdmin("local-wrong@example.com", { "x-admin-token": `${LAUNCHER_KEY}x` });
  assert.equal(wrong.status, 403);
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
