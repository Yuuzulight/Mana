const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_PROMPT_CHARS,
  COMFYUI_CHECKPOINT_NODE_ID,
  COMFYUI_POSITIVE_PROMPT_NODE_ID,
  COMFYUI_UNET_LOADER_NODE_ID,
  COMFYUI_CLIP_LOADER_NODE_ID,
  COMFYUI_VAE_LOADER_NODE_ID,
  assertValidBackendUrl,
  createImageGenerationStore,
  createAutomatic1111Backend,
  createOpenAiImagesBackend,
  createComfyUiBackend,
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

test("createComfyUiBackend requires a checkpoint name", () => {
  assert.throws(
    () => createComfyUiBackend({ baseUrl: "http://127.0.0.1:8188" }),
    /checkpoint name is required/,
  );
});

// Issue #271: the split-loader workflow shape has no single checkpoint to
// fall back to -- all four of unet/clip/clip-type/vae are required.
test("createComfyUiBackend (split shape) requires unet/clip/clip-type/vae, not a checkpoint", () => {
  assert.throws(
    () => createComfyUiBackend({ baseUrl: "http://127.0.0.1:8188", workflowShape: "split" }),
    /unet\/clip\/clip-type\/vae/,
  );
  assert.throws(
    () =>
      createComfyUiBackend({
        baseUrl: "http://127.0.0.1:8188",
        workflowShape: "split",
        unetName: "flux1-dev.safetensors",
        clipName: "qwen3vl_4b_bf16.safetensors",
        // clipType deliberately omitted
        vaeName: "ae.safetensors",
      }),
    /unet\/clip\/clip-type\/vae/,
  );
});

test("createComfyUiBackend rejects image editing (txt2img only for now)", async () => {
  const backend = createComfyUiBackend({
    baseUrl: "http://127.0.0.1:8188",
    checkpointName: "sd_xl_base_1.0.safetensors",
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });
  await assert.rejects(
    () => backend({ prompt: "a cat", editImageBase64: "base64data" }),
    /does not support image editing yet/,
  );
});

// Mocks the three-call ComfyUI shape: POST /prompt (queue) -> GET
// /history/{id} (poll) -> GET /view (fetch bytes) -- mirrors how a real
// ComfyUI server behaves, not a live instance (same documented
// verification gap as the Automatic1111/OpenAI backends above).
function createMockComfyUiFetch({ promptId = "abc123", historyResponses = null } = {}) {
  const requests = [];
  let historyCallCount = 0;
  const responses = historyResponses || [
    { [promptId]: { outputs: { 9: { images: [{ filename: "mana_00001_.png", subfolder: "", type: "output" }] } } } },
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith("/prompt")) {
      return { ok: true, json: async () => ({ prompt_id: promptId }) };
    }
    if (String(url).includes("/history/")) {
      const response = responses[Math.min(historyCallCount, responses.length - 1)];
      historyCallCount += 1;
      return { ok: true, json: async () => response };
    }
    if (String(url).includes("/view")) {
      return { ok: true, arrayBuffer: async () => Buffer.from(TINY_PNG_BASE64, "base64") };
    }
    throw new Error(`unexpected mock fetch call: ${url}`);
  };
  return { fetchImpl, requests };
}

test("createComfyUiBackend queues a workflow, polls history, and fetches image bytes", async () => {
  const { fetchImpl, requests } = createMockComfyUiFetch();
  const backend = createComfyUiBackend({
    baseUrl: "http://127.0.0.1:8188",
    checkpointName: "sd_xl_base_1.0.safetensors",
    fetchImpl,
    pollIntervalMs: 1,
  });

  const result = await backend({ prompt: "a dragon", editImageBase64: null });

  assert.deepEqual(result.imagesBase64, [TINY_PNG_BASE64]);

  const queueRequest = requests.find((r) => r.url.endsWith("/prompt"));
  assert.equal(
    queueRequest.body.prompt[COMFYUI_CHECKPOINT_NODE_ID].inputs.ckpt_name,
    "sd_xl_base_1.0.safetensors",
  );
  assert.equal(queueRequest.body.prompt[COMFYUI_POSITIVE_PROMPT_NODE_ID].inputs.text, "a dragon");
  assert.ok(queueRequest.body.client_id);

  const viewRequest = requests.find((r) => r.url.includes("/view"));
  assert.match(viewRequest.url, /filename=mana_00001_\.png/);
});

test("createComfyUiBackend (split shape) queues the split-loader workflow with unet/clip/clip-type/vae set", async () => {
  const { fetchImpl, requests } = createMockComfyUiFetch();
  const backend = createComfyUiBackend({
    baseUrl: "http://127.0.0.1:8188",
    workflowShape: "split",
    unetName: "Mage-Flow-4B.safetensors",
    clipName: "qwen3vl_4b_bf16.safetensors",
    clipType: "qwen_image",
    vaeName: "ae.safetensors",
    fetchImpl,
    pollIntervalMs: 1,
  });

  const result = await backend({ prompt: "a dragon", editImageBase64: null });
  assert.deepEqual(result.imagesBase64, [TINY_PNG_BASE64]);

  const queueRequest = requests.find((r) => r.url.endsWith("/prompt"));
  const graph = queueRequest.body.prompt;
  assert.equal(graph[COMFYUI_UNET_LOADER_NODE_ID].inputs.unet_name, "Mage-Flow-4B.safetensors");
  assert.equal(graph[COMFYUI_CLIP_LOADER_NODE_ID].inputs.clip_name, "qwen3vl_4b_bf16.safetensors");
  assert.equal(graph[COMFYUI_CLIP_LOADER_NODE_ID].inputs.type, "qwen_image");
  assert.equal(graph[COMFYUI_VAE_LOADER_NODE_ID].inputs.vae_name, "ae.safetensors");
  assert.equal(graph[COMFYUI_POSITIVE_PROMPT_NODE_ID].inputs.text, "a dragon");
  // The split shape never touches the checkpoint node -- it doesn't exist
  // in this workflow graph at all.
  assert.equal(graph[COMFYUI_CHECKPOINT_NODE_ID], undefined);
});

test("createComfyUiBackend polls until history reports outputs", async () => {
  const { fetchImpl, requests } = createMockComfyUiFetch({
    historyResponses: [
      { abc123: {} },
      { abc123: {} },
      { abc123: { outputs: { 9: { images: [{ filename: "mana_00002_.png", type: "output" }] } } } },
    ],
  });
  const backend = createComfyUiBackend({
    baseUrl: "http://127.0.0.1:8188",
    checkpointName: "sd_xl_base_1.0.safetensors",
    fetchImpl,
    pollIntervalMs: 1,
  });

  const result = await backend({ prompt: "a castle" });
  assert.deepEqual(result.imagesBase64, [TINY_PNG_BASE64]);
  assert.equal(requests.filter((r) => r.url.includes("/history/")).length, 3);
});

test("createComfyUiBackend surfaces a non-ok /prompt response as an error", async () => {
  const backend = createComfyUiBackend({
    baseUrl: "http://127.0.0.1:8188",
    checkpointName: "sd_xl_base_1.0.safetensors",
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(() => backend({ prompt: "x" }), /queue request failed: 500/);
});

test("createComfyUiBackend times out if history never reports outputs", async () => {
  const backend = createComfyUiBackend({
    baseUrl: "http://127.0.0.1:8188",
    checkpointName: "sd_xl_base_1.0.safetensors",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/prompt")) {
        return { ok: true, json: async () => ({ prompt_id: "abc123" }) };
      }
      return { ok: true, json: async () => ({ abc123: {} }) };
    },
    pollIntervalMs: 1,
    timeoutMs: 5,
  });
  await assert.rejects(() => backend({ prompt: "x" }), /timed out/);
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
