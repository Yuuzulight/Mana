// Which local GGUF file the user explicitly picked (via scan or browse),
// overriding the filename-guessing in ai/local-ai.js. Same persistence
// pattern as plugin-settings-store.js. A null/missing modelPath means "no
// override -- keep auto-discovering by filename as before."
const fs = require("node:fs");
const path = require("node:path");
const dpapi = require("./dpapi");

const API_KEY_ENTROPY = "Mana.BrainApiKey";

function createModelSettingsStore(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.MANA_MODEL_SETTINGS_DIR ||
    path.join(__dirname, "data");
  const filePath = path.join(dataDir, "model-settings.json");
  // #645 (Q19): brain.apiKey is saved DPAPI-encrypted as apiKeyProtected,
  // like the launcher's AdminToken (#804). Tests pass a fake.
  const secrets = options.secrets || {
    protect: (value) => dpapi.protect(value, API_KEY_ENTROPY),
    unprotect: (blob) => dpapi.unprotect(blob, API_KEY_ENTROPY),
  };
  // getBrainSettings runs on every reply and decrypting starts PowerShell,
  // so the last blob's plain value is kept in memory.
  let cachedKey = { blob: null, value: "" };
  let migrationTried = false;

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
  // The fields to save for an API key: encrypted, or -- when DPAPI isn't
  // there (not Windows) or fails -- the old plain field, said out loud.
  function apiKeyFields(value) {
    if (!value) return {};
    try {
      const blob = secrets.protect(value);
      cachedKey = { blob, value };
      return { apiKeyProtected: blob };
    } catch (e) {
      console.warn(`[Mana] Couldn't encrypt the Settings API key (${e.message}); it's saved in plain text.`);
      return { apiKey: value };
    }
  }

  function readApiKey(brain) {
    if (typeof brain.apiKeyProtected === "string" && brain.apiKeyProtected) {
      if (cachedKey.blob !== brain.apiKeyProtected) {
        let value = "";
        try {
          value = secrets.unprotect(brain.apiKeyProtected);
        } catch (e) {
          console.warn(
            "[Mana] The Settings API key couldn't be decrypted (another Windows account, a copied profile, or damage). Enter it again in Settings.",
          );
        }
        cachedKey = { blob: brain.apiKeyProtected, value };
      }
      return cachedKey.value;
    }
    return typeof brain.apiKey === "string" ? brain.apiKey : "";
  }

  function getBrainSettings() {
    const settings = readAll();
    const brain = settings.brain && typeof settings.brain === "object" ? settings.brain : {};
    // A file from before #645 has a plain apiKey: encrypt it once, now.
    if (!migrationTried && typeof brain.apiKey === "string" && brain.apiKey && !brain.apiKeyProtected) {
      migrationTried = true;
      const fields = apiKeyFields(brain.apiKey);
      if (fields.apiKeyProtected) {
        const { apiKey, ...rest } = brain;
        settings.brain = { ...rest, ...fields };
        writeAll(settings);
      }
    }
    return {
      type: brain.type === "openai_compatible" ? "openai_compatible" : "local",
      baseUrl: typeof brain.baseUrl === "string" ? brain.baseUrl : "",
      apiKey: readApiKey(brain),
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
    if (partial.apiKey !== undefined) {
      delete next.apiKey;
      delete next.apiKeyProtected;
      Object.assign(next, apiKeyFields(String(partial.apiKey || "").trim()));
    }
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

  // Load the chat model straight into VRAM instead of mmap'ing it (see
  // buildServerArgs in ai/llama-server-runtime.js). Precedence: a saved
  // choice here, else MANA_LLAMA_MMAP=1 turns mmap back on, else on.
  function isLoadIntoVram(env = process.env) {
    const saved = readAll().loadIntoVram;
    return typeof saved === "boolean" ? saved : env.MANA_LLAMA_MMAP !== "1";
  }

  function setLoadIntoVram(loadIntoVram) {
    const settings = readAll();
    settings.loadIntoVram = loadIntoVram === true;
    writeAll(settings);
    return settings.loadIntoVram;
  }

  return {
    dataDir,
    isLoadIntoVram,
    setLoadIntoVram,
    getModelPath,
    setModelPath,
    getBrainSettings,
    setBrainSettings,
    getVisionSettings,
    setVisionSettings,
  };
}

module.exports = { createModelSettingsStore };
