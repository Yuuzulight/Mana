// Which local GGUF file the user explicitly picked (via scan or browse),
// overriding the filename-guessing in ai/local-ai.js. Same persistence
// pattern as plugin-settings-store.js. A null/missing modelPath means "no
// override -- keep auto-discovering by filename as before."
const fs = require("node:fs");
const path = require("node:path");

function createModelSettingsStore(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.MANA_MODEL_SETTINGS_DIR ||
    path.join(__dirname, "data");
  const filePath = path.join(dataDir, "model-settings.json");

  function ensureDir() {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  function readAll() {
    ensureDir();
    if (!fs.existsSync(filePath)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeAll(settings) {
    ensureDir();
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  }

  function getModelPath() {
    const settings = readAll();
    return typeof settings.modelPath === "string" && settings.modelPath ? settings.modelPath : null;
  }

  function setModelPath(modelPath) {
    const settings = readAll();
    settings.modelPath = modelPath || null;
    writeAll(settings);
    return settings.modelPath;
  }

  return { dataDir, getModelPath, setModelPath };
}

module.exports = { createModelSettingsStore };
