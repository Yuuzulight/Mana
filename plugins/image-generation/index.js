const fs = require("fs");
const path = require("path");
const {
  createImageGenerationStore,
  createAutomatic1111Backend,
  createOpenAiImagesBackend,
  createComfyUiBackend,
} = require("./image-generation");

// Module-level singleton (mirrors cron-scheduler, document-reader) so
// every route/health check shares the same on-disk image list.
let store = null;
function getStore(deps = {}) {
  if (!store) {
    store = createImageGenerationStore({ imagesDir: deps.imagesDir });
  }
  return store;
}

// Local backend wins if configured; the external API is only used as an
// explicit opt-in fallback -- matches the issue's "local-first, external
// API behind explicit opt-in" requirement. MANA_IMAGE_BACKEND_TYPE
// disambiguates which API shape lives behind MANA_IMAGE_BACKEND_URL, since
// a bare URL alone doesn't say whether it's Automatic1111 or ComfyUI.
function resolveBackend(env) {
  if (env.MANA_IMAGE_BACKEND_URL) {
    if (env.MANA_IMAGE_BACKEND_TYPE === "comfyui") {
      return createComfyUiBackend({
        baseUrl: env.MANA_IMAGE_BACKEND_URL,
        checkpointName: env.MANA_IMAGE_COMFYUI_CHECKPOINT,
        timeoutMs: env.MANA_IMAGE_COMFYUI_TIMEOUT_MS ? Number(env.MANA_IMAGE_COMFYUI_TIMEOUT_MS) : undefined,
      });
    }
    return createAutomatic1111Backend({ baseUrl: env.MANA_IMAGE_BACKEND_URL });
  }
  if (env.MANA_IMAGE_API_KEY) {
    return createOpenAiImagesBackend({
      apiKey: env.MANA_IMAGE_API_KEY,
      baseUrl: env.MANA_IMAGE_API_BASE_URL || undefined,
    });
  }
  return null;
}

function registerImageGenerationRoutes(app, deps = {}) {
  const env = deps.env || process.env;
  const imageStore = getStore(deps);

  app.post("/image/generate", async (req, res) => {
    try {
      const backend = resolveBackend(env);
      if (!backend) {
        return res.status(503).json({
          error:
            "no image backend configured -- set MANA_IMAGE_BACKEND_URL (local) or MANA_IMAGE_API_KEY (external, opt-in)",
        });
      }
      const result = await imageStore.generateImage(req.body?.prompt, {
        backend,
        editImageBase64: req.body?.editImageBase64,
      });
      return res.json(result);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.get("/images", (req, res) => {
    return res.json({ images: imageStore.listImages() });
  });

  app.get("/images/:id", (req, res) => {
    const filePath = path.join(imageStore.imagesDir, `${req.params.id}.png`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "image not found" });
    }
    return res.sendFile(filePath);
  });
}

module.exports = {
  key: "imageGeneration",
  name: "Image Generation",
  category: "Creative",
  defaultEnabled: false,
  description:
    "Generate or edit an image from a text description. Local-first (Automatic1111 or ComfyUI HTTP API via MANA_IMAGE_BACKEND_URL, MANA_IMAGE_BACKEND_TYPE=comfyui to select ComfyUI); an external API is available as an explicit opt-in fallback (MANA_IMAGE_API_KEY), never a default.",
  registerRoutes: registerImageGenerationRoutes,
  getHealth: (deps = {}) => {
    const env = deps.env || process.env;
    // resolveBackend can throw on genuine misconfiguration (e.g.
    // MANA_IMAGE_BACKEND_TYPE=comfyui set without MANA_IMAGE_COMFYUI_CHECKPOINT)
    // -- caught here so a bad config reports as unavailable in /health
    // instead of crashing it.
    let backend = null;
    let configError = null;
    try {
      backend = resolveBackend(env);
    } catch (e) {
      configError = e.message;
    }
    const configured = Boolean(backend);
    const isComfyUi = env.MANA_IMAGE_BACKEND_URL && env.MANA_IMAGE_BACKEND_TYPE === "comfyui";
    return {
      status: configured ? "configured" : "unavailable",
      configured,
      message: configured
        ? env.MANA_IMAGE_BACKEND_URL
          ? isComfyUi
            ? "Local ComfyUI image backend configured"
            : "Local image backend configured"
          : "External image API configured (opt-in)"
        : configError
          ? `Image backend misconfigured: ${configError}`
          : "No image backend configured -- set MANA_IMAGE_BACKEND_URL or MANA_IMAGE_API_KEY",
    };
  },
  // Test-only escape hatch to reset the module-level singleton between
  // test files/runs -- production code never calls this.
  _resetForTests: () => {
    store = null;
  },
};
