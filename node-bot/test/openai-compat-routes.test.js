// Isolates the auth data directory before requiring server.js, same pattern
// as admin-accounts-routes.test.js -- authStore is a module-level singleton
// created at require time.
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tempAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-openai-routes-test-"));
process.env.MANA_AUTH_DIR = tempAuthDir;

const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../server");
const { createAuthStore } = require("../auth-store");
const { withServer } = require("./helpers");

const authStore = createAuthStore({ dataDir: tempAuthDir });

test.after(() => {
  fs.rmSync(tempAuthDir, { recursive: true, force: true });
  delete process.env.MANA_AUTH_DIR;
});

// llama-server mode never starts under NODE_ENV=test (see
// llama-server-runtime.js's isEnabled(), which refuses to spawn a process
// that a killed test run couldn't clean up), so /v1/chat/completions always
// takes the 503 branch here -- these tests cover auth + the disabled-service
// guard, not a real model reply. The proxy logic itself (forwarding the raw
// body untouched) has its own unit test in llama-server-runtime.test.js.
test("POST /v1/chat/completions rejects requests with no Authorization header", async () => {
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 401);
  });
});

test("POST /v1/chat/completions returns 503 with a valid key when llama-server mode is disabled", async () => {
  const { apiKey } = authStore.createAccount({ email: "chat@example.com", role: "user" });
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 503);
    const payload = await res.json();
    assert.match(payload.error.message, /llama-server mode is disabled/);
  });
});

// Same story as chat completions: USE_EMBEDDINGS/local embedder aren't wired
// up under NODE_ENV=test, so computeEmbeddings() returns nulls and the route
// takes its 503 branch. Confirms auth + the null-embedding guard.
test("POST /v1/embeddings rejects requests with no Authorization header", async () => {
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });
    assert.equal(res.status, 401);
  });
});

test("POST /v1/embeddings rejects a missing/empty input with 400", async () => {
  const { apiKey } = authStore.createAccount({ email: "embed-bad@example.com", role: "user" });
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: "" }),
    });
    assert.equal(res.status, 400);
  });
});

test("POST /v1/embeddings returns 503 with a valid key when the local embedder is unavailable", async () => {
  const { apiKey } = authStore.createAccount({ email: "embed@example.com", role: "user" });
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: "hello" }),
    });
    assert.equal(res.status, 503);
    const payload = await res.json();
    assert.match(payload.error.message, /Local embedder unavailable/);
  });
});

test("GET /v1/models rejects requests with no Authorization header", async () => {
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/models`);
    assert.equal(res.status, 401);
  });
});

test("GET /v1/models lists at least the embedding model for a valid key", async () => {
  const { apiKey } = authStore.createAccount({ email: "models@example.com", role: "user" });
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.object, "list");
    assert.ok(Array.isArray(payload.data) && payload.data.length >= 1);
    for (const model of payload.data) {
      assert.equal(model.object, "model");
      assert.equal(typeof model.id, "string");
    }
  });
});
