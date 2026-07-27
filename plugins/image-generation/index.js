const fs = require("fs");
const path = require("path");
const {
  createImageGenerationStore,
  createAutomatic1111Backend,
  createOpenAiImagesBackend,
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

// Local backend (Automatic1111-compatible) wins if configured; the
// external API is only used as an explicit opt-in fallback -- matches the
// issue's "local-first, external API behind explicit opt-in" requirement.
function resolveBackend(env) {
  if (env.MANA_IMAGE_BACKEND_URL) {
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
    "Generate or edit an image from a text description. Local-first (Automatic1111-compatible HTTP API via MANA_IMAGE_BACKEND_URL); an external API is available as an explicit opt-in fallback (MANA_IMAGE_API_KEY), never a default.",
  registerRoutes: registerImageGenerationRoutes,
  getHealth: (deps = {}) => {
    const env = deps.env || process.env;
    const configured = Boolean(resolveBackend(env));
    return {
      status: configured ? "configured" : "unavailable",
      configured,
      message: configured
        ? env.MANA_IMAGE_BACKEND_URL
          ? "Local image backend configured"
          : "External image API configured (opt-in)"
        : "No image backend configured -- set MANA_IMAGE_BACKEND_URL or MANA_IMAGE_API_KEY",
    };
  },
  // Test-only escape hatch to reset the module-level singleton between
  // test files/runs -- production code never calls this.
  _resetForTests: () => {
    store = null;
  },
};
