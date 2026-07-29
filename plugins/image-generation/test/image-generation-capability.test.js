const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const imageGenerationPlugin = require("../index");

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

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-image-gen-routes-"));
}

function buildApp(env) {
  imageGenerationPlugin._resetForTests();
  const app = express();
  app.use(express.json());
  imageGenerationPlugin.registerRoutes(app, { env, imagesDir: createTempDir() });
  return app;
}

test("POST /image/generate returns 503 with a clear message when nothing is configured", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/image/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.match(payload.error, /no image backend configured/);
  });
});

test("GET /images lists nothing for a fresh store", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/images`);
    const payload = await response.json();
    assert.deepEqual(payload.images, []);
  });
});

test("GET /images/:id reports 404 for an unknown image", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/images/does-not-exist`);
    assert.equal(response.status, 404);
  });
});

test("plugin metadata matches the shape other Mana plugins use", () => {
  assert.equal(imageGenerationPlugin.key, "imageGeneration");
  assert.equal(imageGenerationPlugin.category, "Creative");
  assert.equal(imageGenerationPlugin.defaultEnabled, false);
  assert.equal(typeof imageGenerationPlugin.registerRoutes, "function");
});

test("getHealth reports unavailable with no backend configured, configured once MANA_IMAGE_BACKEND_URL is set", () => {
  imageGenerationPlugin._resetForTests();
  const unconfigured = imageGenerationPlugin.getHealth({ env: {} });
  assert.equal(unconfigured.status, "unavailable");
  assert.equal(unconfigured.configured, false);

  const configured = imageGenerationPlugin.getHealth({
    env: { MANA_IMAGE_BACKEND_URL: "http://127.0.0.1:7860" },
  });
  assert.equal(configured.status, "configured");
  assert.match(configured.message, /Local image backend/);
});

test("getHealth reports the ComfyUI backend distinctly, and misconfiguration without crashing", () => {
  imageGenerationPlugin._resetForTests();
  const configured = imageGenerationPlugin.getHealth({
    env: {
      MANA_IMAGE_BACKEND_URL: "http://127.0.0.1:8188",
      MANA_IMAGE_BACKEND_TYPE: "comfyui",
      MANA_IMAGE_COMFYUI_CHECKPOINT: "sd_xl_base_1.0.safetensors",
    },
  });
  assert.equal(configured.status, "configured");
  assert.match(configured.message, /ComfyUI/);

  // comfyui selected but no checkpoint name -- createComfyUiBackend throws
  // during construction; getHealth must catch that, not crash GET /health.
  const misconfigured = imageGenerationPlugin.getHealth({
    env: { MANA_IMAGE_BACKEND_URL: "http://127.0.0.1:8188", MANA_IMAGE_BACKEND_TYPE: "comfyui" },
  });
  assert.equal(misconfigured.status, "unavailable");
  assert.match(misconfigured.message, /misconfigured/);
  assert.match(misconfigured.message, /checkpoint name is required/);
});
