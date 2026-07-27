const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_PROMPT_CHARS,
  assertValidBackendUrl,
  createImageGenerationStore,
  createAutomatic1111Backend,
  createOpenAiImagesBackend,
} = require("../image-generation");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-image-gen-"));
}

// A 1x1 red PNG, base64-encoded -- small real image bytes for round-trip
// testing rather than arbitrary garbage.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("assertValidBackendUrl accepts http/https and rejects other schemes", () => {
  assert.ok(assertValidBackendUrl("http://127.0.0.1:7860"));
  assert.ok(assertValidBackendUrl("https://example.com"));
  assert.throws(() => assertValidBackendUrl("file:///etc/passwd"), /http or https/);
  assert.throws(() => assertValidBackendUrl("not a url"), /invalid backend URL/);
});

test("generateImage rejects an empty prompt", async () => {
  const store = createImageGenerationStore({ imagesDir: createTempDir() });
  await assert.rejects(
    () => store.generateImage("   ", { backend: async () => ({ imagesBase64: [TINY_PNG_BASE64] }) }),
    /prompt is required/,
  );
});

test("generateImage rejects when no backend is configured", async () => {
  const store = createImageGenerationStore({ imagesDir: createTempDir() });
  await assert.rejects(() => store.generateImage("a cat"), /no image-generation backend/);
});

test("generateImage truncates an overly long prompt", async () => {
  const store = createImageGenerationStore({ imagesDir: createTempDir() });
  const seenPrompts = [];
  await store.generateImage("x".repeat(MAX_PROMPT_CHARS + 500), {
    backend: async ({ prompt }) => {
      seenPrompts.push(prompt);
      return { imagesBase64: [TINY_PNG_BASE64] };
    },
  });
  assert.equal(seenPrompts[0].length, MAX_PROMPT_CHARS);
});

test("generateImage saves the returned image(s) and lists them back", async () => {
  const dataDir = createTempDir();
  const store = createImageGenerationStore({ imagesDir: dataDir });

  const result = await store.generateImage("a cozy cabin in the woods", {
    backend: async () => ({ imagesBase64: [TINY_PNG_BASE64] }),
  });

  assert.equal(result.prompt, "a cozy cabin in the woods");
  assert.equal(result.images.length, 1);
  assert.ok(fs.existsSync(result.images[0].path));

  const listed = store.listImages();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, result.images[0].id);
});

test("generateImage rejects when the backend returns no images", async () => {
  const store = createImageGenerationStore({ imagesDir: createTempDir() });
  await assert.rejects(
    () => store.generateImage("a cat", { backend: async () => ({ imagesBase64: [] }) }),
    /returned no images/,
  );
});

test("createAutomatic1111Backend posts to txt2img by default and img2img when editing", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ images: [TINY_PNG_BASE64] }) };
  };

  const backend = createAutomatic1111Backend({ baseUrl: "http://127.0.0.1:7860", fetchImpl });

  await backend({ prompt: "a dragon", editImageBase64: null });
  assert.match(requests[0].url, /\/sdapi\/v1\/txt2img$/);
  assert.equal(requests[0].body.prompt, "a dragon");

  await backend({ prompt: "make it blue", editImageBase64: "base64data" });
  assert.match(requests[1].url, /\/sdapi\/v1\/img2img$/);
  assert.deepEqual(requests[1].body.init_images, ["base64data"]);
});

test("createAutomatic1111Backend surfaces a non-ok response as an error", async () => {
  const backend = createAutomatic1111Backend({
    baseUrl: "http://127.0.0.1:7860",
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(() => backend({ prompt: "x" }), /request failed: 500/);
});

test("createOpenAiImagesBackend requires an API key and sends bearer auth", async () => {
  assert.throws(() => createOpenAiImagesBackend({}), /API key is required/);

  let seenAuth = null;
  const backend = createOpenAiImagesBackend({
    apiKey: "sk-test",
    fetchImpl: async (url, options) => {
      seenAuth = options.headers.Authorization;
      return { ok: true, json: async () => ({ data: [{ b64_json: TINY_PNG_BASE64 }] }) };
    },
  });
  const result = await backend({ prompt: "a sunset" });
  assert.equal(seenAuth, "Bearer sk-test");
  assert.deepEqual(result.imagesBase64, [TINY_PNG_BASE64]);
});
