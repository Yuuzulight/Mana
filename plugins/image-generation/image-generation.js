// Text-to-image and image-editing, local-first. "Local-first" here means
// the plugin is built against the Automatic1111 WebUI API contract (the
// most common self-hosted local Stable Diffusion/SDXL HTTP API,
// `POST {baseUrl}/sdapi/v1/txt2img` / `/sdapi/v1/img2img`) rather than
// bundling or downloading a model itself -- whoever runs Mana points this
// at their own already-running local instance via env var. An external
// API is available as an explicit opt-in fallback, never a default.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_IMAGES_DIR = path.join(__dirname, "..", "..", "node-bot", "data", "images");
const MAX_PROMPT_CHARS = 2000;

// Node ids inside workflows/comfyui-txt2img-checkpoint.json -- the bundled
// graph is the legacy single-checkpoint shape (CheckpointLoaderSimple ->
// CLIPTextEncode -> KSampler -> VAEDecode -> SaveImage). The split-loader
// shape FLUX/Qwen-Image/Mage-Flow-style models need (separate
// UNETLoader/CLIPLoader/VAELoader nodes) is a different graph, tracked
// separately in issue #271 -- not this one.
const COMFYUI_CHECKPOINT_NODE_ID = "4";
const COMFYUI_SAMPLER_NODE_ID = "3";
const COMFYUI_POSITIVE_PROMPT_NODE_ID = "6";
const COMFYUI_SAVE_IMAGE_NODE_ID = "9";
const DEFAULT_COMFYUI_WORKFLOW_PATH = path.join(__dirname, "workflows", "comfyui-txt2img-checkpoint.json");
const DEFAULT_COMFYUI_POLL_INTERVAL_MS = 1000;
const DEFAULT_COMFYUI_TIMEOUT_MS = 120000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only http/https -- same validation model-management.js's brain-provider
// settings use, since this is the same shape of concern (a user-configured
// local or LAN endpoint, not a fixed trusted host).
function assertValidBackendUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    throw new Error(`invalid backend URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("backend URL must use http or https");
  }
  return url;
}

// options.imagesDir: where generated images are saved -- injectable so
// tests don't write into node-bot's real data directory, same pattern as
// acp-memory-store.js's/cron-scheduler.js's dataDir option.
function createImageGenerationStore(options = {}) {
  const imagesDir = options.imagesDir || DEFAULT_IMAGES_DIR;

  function ensureImagesDir() {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  function saveImageBuffer(buffer) {
    ensureImagesDir();
    const id = crypto.randomUUID();
    const filePath = path.join(imagesDir, `${id}.png`);
    fs.writeFileSync(filePath, buffer);
    return { id, filePath };
  }

  function listImages() {
    ensureImagesDir();
    return fs
      .readdirSync(imagesDir)
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({ id: f.replace(/\.png$/, ""), filePath: path.join(imagesDir, f) }));
  }

  // options.backend: injected dependency, ({prompt, editImageBase64}) =>
  // Promise<{imagesBase64: string[]}>. Kept as a single injected function
  // (rather than one per provider) so the caller (index.js) decides at
  // wiring time which real implementation (local Automatic1111-compatible
  // HTTP, or an external API) actually runs -- this module has no direct
  // knowledge of either.
  async function generateImage(prompt, genOptions = {}) {
    const cleanPrompt = String(prompt || "").trim().slice(0, MAX_PROMPT_CHARS);
    if (!cleanPrompt) {
      throw new Error("prompt is required");
    }
    if (typeof genOptions.backend !== "function") {
      throw new Error("no image-generation backend is configured");
    }

    const result = await genOptions.backend({
      prompt: cleanPrompt,
      editImageBase64: genOptions.editImageBase64 || null,
    });
    if (!result || !Array.isArray(result.imagesBase64) || !result.imagesBase64.length) {
      throw new Error("image backend returned no images");
    }

    const saved = result.imagesBase64.map((b64) => saveImageBuffer(Buffer.from(b64, "base64")));
    return {
      prompt: cleanPrompt,
      images: saved.map((s) => ({ id: s.id, path: s.filePath })),
    };
  }

  return { imagesDir, generateImage, listImages };
}

// Real local backend: Automatic1111 WebUI's txt2img/img2img API. Not
// exercised against a live instance in this codebase -- verified via
// injected/mocked HTTP calls in tests instead (see the roadmap doc for
// why: no GPU/model weights available to actually run one here).
function createAutomatic1111Backend({ baseUrl, fetchImpl = fetch } = {}) {
  const validatedUrl = assertValidBackendUrl(baseUrl);
  return async function backend({ prompt, editImageBase64 }) {
    const endpoint = editImageBase64 ? "/sdapi/v1/img2img" : "/sdapi/v1/txt2img";
    const body = editImageBase64
      ? { prompt, init_images: [editImageBase64] }
      : { prompt };
    const response = await fetchImpl(`${validatedUrl.origin}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`image backend request failed: ${response.status}`);
    }
    const data = await response.json();
    return { imagesBase64: data.images || [] };
  };
}

// Opt-in external fallback (never a default -- only used if an API key is
// explicitly configured). Targets the OpenAI-compatible images endpoint,
// matching the existing brain-provider pattern of speaking an
// OpenAI-shaped API rather than a bespoke one per provider.
function createOpenAiImagesBackend({ apiKey, baseUrl = "https://api.openai.com/v1", fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error("an API key is required for the external image backend");
  }
  const validatedUrl = assertValidBackendUrl(baseUrl);
  return async function backend({ prompt }) {
    const response = await fetchImpl(`${validatedUrl.origin}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ prompt, response_format: "b64_json" }),
    });
    if (!response.ok) {
      throw new Error(`image backend request failed: ${response.status}`);
    }
    const data = await response.json();
    const imagesBase64 = (data.data || []).map((entry) => entry.b64_json).filter(Boolean);
    return { imagesBase64 };
  };
}

// ComfyUI backend -- fundamentally different shape from Automatic1111's
// flat-params API (see docs/roadmap/issue-225-comfyui-backend.md for why):
// 1. POST a whole workflow graph to /prompt (not {prompt: "..."}).
// 2. Results are async: poll /history/{prompt_id} until it reports outputs,
//    then fetch the actual PNG bytes from /view. No websocket in this pass
//    (out of scope for #225 -- polling is simpler and more testable).
// 3. The workflow's checkpoint filename must be given explicitly --
//    ComfyUI's graph always names an exact checkpoint file, unlike
//    Automatic1111 which just uses whatever's already loaded.
function createComfyUiBackend({
  baseUrl,
  checkpointName,
  workflowTemplate,
  fetchImpl = fetch,
  pollIntervalMs = DEFAULT_COMFYUI_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_COMFYUI_TIMEOUT_MS,
} = {}) {
  const validatedUrl = assertValidBackendUrl(baseUrl);
  if (!checkpointName) {
    throw new Error(
      "a checkpoint name is required (MANA_IMAGE_COMFYUI_CHECKPOINT) -- ComfyUI's workflow graph must name an exact checkpoint file, unlike Automatic1111 which uses whatever's already loaded",
    );
  }
  const template = workflowTemplate || JSON.parse(fs.readFileSync(DEFAULT_COMFYUI_WORKFLOW_PATH, "utf8"));

  async function pollHistory(promptId) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await fetchImpl(`${validatedUrl.origin}/history/${promptId}`);
      if (response.ok) {
        const history = await response.json();
        const entry = history[promptId];
        if (entry && entry.outputs) {
          return entry.outputs;
        }
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(`ComfyUI generation timed out after ${timeoutMs}ms`);
  }

  return async function backend({ prompt, editImageBase64 }) {
    if (editImageBase64) {
      throw new Error("ComfyUI backend does not support image editing yet (txt2img only -- see issue #225)");
    }

    // Deep clone -- the template is shared across every call, must not be mutated in place.
    const graph = JSON.parse(JSON.stringify(template));
    graph[COMFYUI_CHECKPOINT_NODE_ID].inputs.ckpt_name = checkpointName;
    graph[COMFYUI_POSITIVE_PROMPT_NODE_ID].inputs.text = prompt;
    graph[COMFYUI_SAMPLER_NODE_ID].inputs.seed = Math.floor(Math.random() * 1e15);

    const queueResponse = await fetchImpl(`${validatedUrl.origin}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: crypto.randomUUID() }),
    });
    if (!queueResponse.ok) {
      throw new Error(`ComfyUI queue request failed: ${queueResponse.status}`);
    }
    const { prompt_id: promptId } = await queueResponse.json();
    if (!promptId) {
      throw new Error("ComfyUI did not return a prompt_id");
    }

    const outputs = await pollHistory(promptId);
    const images = outputs[COMFYUI_SAVE_IMAGE_NODE_ID]?.images || [];
    if (!images.length) {
      throw new Error("ComfyUI reported no output images");
    }

    const imagesBase64 = [];
    for (const image of images) {
      const params = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder || "",
        type: image.type || "output",
      });
      const viewResponse = await fetchImpl(`${validatedUrl.origin}/view?${params}`);
      if (!viewResponse.ok) {
        throw new Error(`ComfyUI image fetch failed: ${viewResponse.status}`);
      }
      const buffer = Buffer.from(await viewResponse.arrayBuffer());
      imagesBase64.push(buffer.toString("base64"));
    }
    return { imagesBase64 };
  };
}

module.exports = {
  DEFAULT_IMAGES_DIR,
  MAX_PROMPT_CHARS,
  COMFYUI_CHECKPOINT_NODE_ID,
  COMFYUI_SAMPLER_NODE_ID,
  COMFYUI_POSITIVE_PROMPT_NODE_ID,
  COMFYUI_SAVE_IMAGE_NODE_ID,
  assertValidBackendUrl,
  createImageGenerationStore,
  createAutomatic1111Backend,
  createOpenAiImagesBackend,
  createComfyUiBackend,
};
