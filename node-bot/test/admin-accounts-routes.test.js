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

// With the admin key, so the request gets past the default-deny gate
// (admin-key.js) to requireAdmin's role check.
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
        "x-admin-token": LAUNCHER_KEY,
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

// Without an admin key the default-deny gate answers first: 401.
test("POST /admin/accounts rejects an admin-role key from a local request with no admin key (#670)", async () => {
  const res = await postAccountAsAdmin("local-no-key@example.com", {});
  assert.equal(res.status, 401);
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
  assert.equal(forwarded.status, 401);
  const wrong = await postAccountAsAdmin("local-wrong@example.com", { "x-admin-token": `${LAUNCHER_KEY}x` });
  assert.equal(wrong.status, 401);
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
      assert.equal(res.status, 401);
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

// #842: routes behind the MANA_ADMIN_SECRET gate are no longer open when no
// secret is set -- they take the launcher key (from this PC) or ADMIN_TOKEN.
test("MANA_ADMIN_SECRET-gated routes need an admin key when no secret is set (#842)", async () => {
  const prior = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "gate-test-admin-token";
  try {
    await withServer(createApp(), async (baseUrl) => {
      const get = (route, headers = {}) => fetch(`${baseUrl}${route}`, { headers });
      for (const route of ["/admin/pending-writes", "/admin/retriever/status"]) {
        const open = await get(route);
        assert.equal(open.status, 401, route);
        assert.match((await open.json()).error, /ADMIN_TOKEN/);
        assert.equal((await get(route, { "x-admin-token": "gate-test-admin-token" })).status, 200, route);
        assert.equal((await get(route, { "x-admin-token": LAUNCHER_KEY })).status, 200, route);
        assert.equal((await get(route, { "x-admin-token": LAUNCHER_KEY, "X-Forwarded-For": "203.0.113.5" })).status, 401, route);
      }
    });
    // With a secret set, its Bearer token stays the requirement.
    await withServer(createApp({ env: { MANA_ADMIN_SECRET: "topsecret" } }), async (baseUrl) => {
      const get = (headers) => fetch(`${baseUrl}/admin/pending-writes`, { headers });
      assert.equal((await get({ Authorization: "Bearer topsecret" })).status, 200);
      assert.equal((await get({ "x-admin-token": "gate-test-admin-token" })).status, 401);
    });
  } finally {
    if (prior === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prior;
  }
});
