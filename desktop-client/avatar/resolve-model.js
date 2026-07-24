// Main-process-only: resolves which Live2D model (if any) is configured and
// reads everything the renderer needs about it. Exists so the renderer
// itself never needs direct fs/path access -- see issue #122. This is the
// same model-discovery/config-loading logic live2d-avatar.js used to do
// with fs directly in the renderer; it just moved here, unchanged, since
// the main process always has full Node access regardless of the
// renderer's context-isolation settings.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { findModelJson, normalizeAvatarConfig } = require("./live2d-logic");

const MODEL_DIR = path.join(__dirname, "model");
// Dev convenience only: if desktop-client has no model of its own, fall
// back to windows-launcher's copy when present. A packaged installer build
// only bundles desktop-client itself, so this path won't exist there --
// that's fine, it just means no fallback is found.
const FALLBACK_MODEL_DIR = path.join(
  __dirname,
  "..",
  "..",
  "windows-launcher",
  "avatar",
  "model",
);

function findConfiguredModelJson(env) {
  const explicit = env.MANA_LIVE2D_MODEL || "";
  if (explicit) {
    return fs.existsSync(explicit) ? explicit : null;
  }
  return findModelJson(MODEL_DIR, fs) || findModelJson(FALLBACK_MODEL_DIR, fs);
}

function loadAvatarConfig(modelJson) {
  const candidates = [
    path.join(path.dirname(modelJson), "mana-avatar.json"),
    path.join(MODEL_DIR, "mana-avatar.json"),
    path.join(FALLBACK_MODEL_DIR, "mana-avatar.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const config = normalizeAvatarConfig(
          JSON.parse(fs.readFileSync(candidate, "utf8")),
        );
        console.log(`Loaded avatar config: ${candidate}`);
        return config;
      }
    } catch (error) {
      console.warn(`Ignoring invalid avatar config ${candidate}:`, error);
    }
  }
  return normalizeAvatarConfig(null);
}

// Returns { modelJson: null } when no model is configured/found (caller
// falls back to sprites), otherwise the full payload the renderer needs to
// build a Live2D model without touching fs itself: parsed model3.json
// (`rawSettings`), the motion/expression filenames in that model's
// directory, a `file://` URL for the model (for PIXI's own asset loading),
// the normalized mana-avatar.json config, and a snapshot of the
// MANA_LIVE2D_*/MANA_AVATAR_FPS tuning env vars (the renderer can no
// longer read process.env directly either).
function resolveAvatarModel(env = process.env) {
  const modelJson = findConfiguredModelJson(env);
  if (!modelJson) {
    console.log(
      `No Live2D model found (looked in ${MODEL_DIR}, ${FALLBACK_MODEL_DIR}, and MANA_LIVE2D_MODEL)`,
    );
    return { modelJson: null };
  }

  const config = loadAvatarConfig(modelJson);
  const modelDir = path.dirname(modelJson);
  const rawSettings = JSON.parse(fs.readFileSync(modelJson, "utf8"));
  const dirFiles = fs.readdirSync(modelDir);
  const motionFileNames = dirFiles.filter((name) =>
    name.toLowerCase().endsWith(".motion3.json"),
  );
  const expressionFileNames = dirFiles.filter((name) =>
    name.toLowerCase().endsWith(".exp3.json"),
  );
  const settingsUrl = pathToFileURL(modelJson).href;

  const tuningEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("MANA_LIVE2D_") || key === "MANA_AVATAR_FPS") {
      tuningEnv[key] = value;
    }
  }

  return {
    modelJson,
    rawSettings,
    motionFileNames,
    expressionFileNames,
    settingsUrl,
    config,
    env: tuningEnv,
  };
}

module.exports = { resolveAvatarModel, MODEL_DIR, FALLBACK_MODEL_DIR };
