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

  // Which "brain" Mana talks to: a local GGUF via llama-server (the
  // default), or any OpenAI-compatible endpoint -- a self-hosted server
  // (Ollama, LM Studio, vLLM, text-generation-webui, ...) or a real
  // third-party API. baseUrl/apiKey/model here override the
  // OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL env vars when set (see
  // server.js's openAiBaseUrl()/openAiApiKey()/openAiModel() getters);
  // whether that counts as "remote" for MANA_ALLOW_REMOTE_AI purposes is
  // decided by shouldUseRemoteAi() (see ai/local-ai.js) based on baseUrl's
  // host, not by this store.
  function getBrainSettings() {
    const settings = readAll();
    const brain = settings.brain && typeof settings.brain === "object" ? settings.brain : {};
    return {
      type: brain.type === "openai_compatible" ? "openai_compatible" : "local",
      baseUrl: typeof brain.baseUrl === "string" ? brain.baseUrl : "",
      apiKey: typeof brain.apiKey === "string" ? brain.apiKey : "",
      model: typeof brain.model === "string" ? brain.model : "",
    };
  }

  function setBrainSettings(partial = {}) {
    const settings = readAll();
    const next = settings.brain && typeof settings.brain === "object" ? { ...settings.brain } : {};
    if (partial.type !== undefined) {
      next.type = partial.type === "openai_compatible" ? "openai_compatible" : "local";
    }
    if (partial.baseUrl !== undefined) next.baseUrl = String(partial.baseUrl || "").trim();
    if (partial.apiKey !== undefined) next.apiKey = String(partial.apiKey || "").trim();
    if (partial.model !== undefined) next.model = String(partial.model || "").trim();
    settings.brain = next;
    writeAll(settings);
    return getBrainSettings();
  }

  // Which vision GGUF + mmproj pair Mana's "eyes" use. Empty strings mean
  // "keep auto-detecting under tools/llama/gguf-models" (see
  // findVisionModel/findVisionMmproj in ai/llama-server-runtime.js), same
  // null-means-auto-discover convention as getModelPath above.
  function getVisionSettings() {
    const settings = readAll();
    const vision = settings.vision && typeof settings.vision === "object" ? settings.vision : {};
    return {
      modelPath: typeof vision.modelPath === "string" ? vision.modelPath : "",
      mmprojPath: typeof vision.mmprojPath === "string" ? vision.mmprojPath : "",
    };
  }

  function setVisionSettings(partial = {}) {
    const settings = readAll();
    const next = settings.vision && typeof settings.vision === "object" ? { ...settings.vision } : {};
    if (partial.modelPath !== undefined) next.modelPath = String(partial.modelPath || "").trim();
    if (partial.mmprojPath !== undefined) next.mmprojPath = String(partial.mmprojPath || "").trim();
    settings.vision = next;
    writeAll(settings);
    return getVisionSettings();
  }

  return {
    dataDir,
    getModelPath,
    setModelPath,
    getBrainSettings,
    setBrainSettings,
    getVisionSettings,
    setVisionSettings,
  };
}

module.exports = { createModelSettingsStore };
