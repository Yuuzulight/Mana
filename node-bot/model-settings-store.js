// Which local GGUF file the user explicitly picked (via scan or browse),
// overriding the filename-guessing in ai/local-ai.js. Same persistence
// pattern as plugin-settings-store.js. A null/missing modelPath means "no
// override -- keep auto-discovering by filename as before."
const fs = require("node:fs");
const path = require("node:path");
const dpapi = require("./dpapi");
const { PROVIDER_PRESETS, presetForBaseUrl, trimSlashes } = require("./provider-presets");

// #1426: why a provider couldn't be added or changed (a 400, in words).
class ProviderError extends Error {}

// #1426: what each use is called when a provider can't be removed.
const USE_NAMES = { brain: "Main model", fallback: "Cloud fallback", escalation: "Self-work escalation" };

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
  // so each blob's plain value is kept in memory -- several are in use at
  // once (#1426's providers).
  const keyCache = new Map();
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
      keyCache.set(blob, value);
      return { apiKeyProtected: blob };
    } catch (e) {
      console.warn(`[Mana] Couldn't encrypt the Settings API key (${e.message}); it's saved in plain text.`);
      return { apiKey: value };
    }
  }

  function readApiKey(brain) {
    if (typeof brain.apiKeyProtected === "string" && brain.apiKeyProtected) {
      if (!keyCache.has(brain.apiKeyProtected)) {
        let value = "";
        try {
          value = secrets.unprotect(brain.apiKeyProtected);
        } catch (e) {
          console.warn(
            "[Mana] The Settings API key couldn't be decrypted (another Windows account, a copied profile, or damage). Enter it again in Settings.",
          );
        }
        keyCache.set(brain.apiKeyProtected, value);
      }
      return keyCache.get(brain.apiKeyProtected);
    }
    return typeof brain.apiKey === "string" ? brain.apiKey : "";
  }

  // #1426: providers -- each API account added once (a preset, its address,
  // its protected key), picked by the uses below by id.
  const providerList = (settings) => (Array.isArray(settings.providers) ? settings.providers.filter((p) => p && typeof p.id === "string") : null);
  const uniqueId = (providers, preset) => {
    let id = preset;
    for (let n = 2; providers.some((p) => p.id === id); n += 1) id = `${preset}-${n}`;
    return id;
  };
  // A plain key from before #645 is encrypted on its way into the provider.
  const keyFieldsOf = (entry) =>
    entry.apiKeyProtected ? { apiKeyProtected: entry.apiKeyProtected } : entry.apiKey ? apiKeyFields(entry.apiKey) : {};

  // A file from before providers: each use's address and key become a
  // provider (one per address and key), and the use points at it. The use
  // keeps its own fields too, for an older Mana reading the same file.
  function migrateProviders(settings) {
    if (providerList(settings)) return false;
    const providers = [];
    for (const use of ["escalation", "brain", "fallback"]) {
      const entry = settings[use];
      if (!entry || typeof entry !== "object") continue;
      if (use === "brain" && entry.type !== "openai_compatible") continue;
      const baseUrl = trimSlashes(entry.baseUrl || (use === "escalation" ? PROVIDER_PRESETS.deepseek.baseUrl : ""));
      const key = readApiKey(entry);
      if (!baseUrl || (use === "escalation" && !key)) continue;
      let provider = providers.find((p) => p.baseUrl.toLowerCase() === baseUrl.toLowerCase() && readApiKey(p) === key);
      if (!provider) {
        const preset = presetForBaseUrl(baseUrl);
        provider = { id: uniqueId(providers, preset), preset, baseUrl, ...keyFieldsOf(entry) };
        providers.push(provider);
      }
      entry.providerId = provider.id;
    }
    settings.providers = providers;
    return true;
  }

  function readSettings() {
    const settings = readAll();
    if (migrateProviders(settings)) writeAll(settings);
    return settings;
  }

  // A use's address and key: its provider's when it has one.
  function connectionOf(settings, entry, defaultBaseUrl = "") {
    const provider = entry.providerId ? providerList(settings).find((p) => p.id === entry.providerId) : null;
    if (provider) return { providerId: provider.id, preset: provider.preset, baseUrl: provider.baseUrl, apiKey: readApiKey(provider) };
    return {
      providerId: null,
      preset: null,
      baseUrl: typeof entry.baseUrl === "string" && entry.baseUrl ? entry.baseUrl : defaultBaseUrl,
      apiKey: readApiKey(entry),
    };
  }

  function usesOf(settings, id) {
    return Object.entries(USE_NAMES)
      .filter(([use]) => settings[use]?.providerId === id && (use !== "brain" || settings.brain.type === "openai_compatible"))
      .map(([, name]) => name);
  }

  // What Settings may see of a provider: never the key, only its end.
  function publicProvider(settings, p) {
    const key = readApiKey(p);
    const preset = PROVIDER_PRESETS[p.preset] || PROVIDER_PRESETS.custom;
    return {
      id: p.id,
      preset: p.preset,
      label: p.label || preset.label,
      baseUrl: p.baseUrl,
      hasKey: Boolean(key),
      keyHint: key ? `…${key.slice(-4)}` : null,
      lastCheck: p.lastCheck || null,
      usedBy: usesOf(settings, p.id),
    };
  }

  function listProviders() {
    const settings = readSettings();
    return providerList(settings).map((p) => publicProvider(settings, p));
  }

  // The address and key to reach one, for a connection check. Null if unknown.
  function getProvider(id) {
    const provider = providerList(readSettings()).find((p) => p.id === id);
    return provider ? { id: provider.id, preset: provider.preset, baseUrl: provider.baseUrl, apiKey: readApiKey(provider) } : null;
  }

  function checkedUrl(value) {
    const url = trimSlashes(value);
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      throw new ProviderError("That address isn't a web address");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ProviderError("The address must start with http:// or https://");
    return url;
  }

  // One per preset (Custom as often as wanted). Throws ProviderError.
  function addProvider({ preset, baseUrl, apiKey, label } = {}) {
    const known = PROVIDER_PRESETS[preset];
    if (!known) throw new ProviderError("Pick a provider from the list");
    const settings = readSettings();
    const providers = providerList(settings);
    if (preset !== "custom" && providers.some((p) => p.preset === preset)) throw new ProviderError(`${known.label} is already added; change its key there`);
    const url = checkedUrl(baseUrl || known.baseUrl);
    const key = String(apiKey || "").trim();
    if (known.needsKey && !key) throw new ProviderError(`${known.label} needs its API key`);
    const provider = { id: uniqueId(providers, preset), preset, baseUrl: url, ...(label ? { label: String(label).trim().slice(0, 60) } : {}), ...apiKeyFields(key) };
    providers.push(provider);
    settings.providers = providers;
    writeAll(settings);
    return publicProvider(settings, provider);
  }

  // partial: baseUrl, apiKey (blank keeps it), label, lastCheck. Null if unknown.
  function updateProvider(id, partial = {}) {
    const settings = readSettings();
    const provider = providerList(settings).find((p) => p.id === id);
    if (!provider) return null;
    if (partial.baseUrl !== undefined) provider.baseUrl = checkedUrl(partial.baseUrl);
    if (typeof partial.apiKey === "string" && partial.apiKey.trim()) {
      delete provider.apiKey;
      delete provider.apiKeyProtected;
      Object.assign(provider, apiKeyFields(partial.apiKey.trim()));
    }
    if (partial.label !== undefined) provider.label = String(partial.label || "").trim().slice(0, 60) || undefined;
    if (partial.lastCheck !== undefined) provider.lastCheck = partial.lastCheck;
    writeAll(settings);
    return publicProvider(settings, provider);
  }

  // Not while a use picks it: {removed: false, usedBy}.
  function removeProvider(id) {
    const settings = readSettings();
    const providers = providerList(settings);
    const at = providers.findIndex((p) => p.id === id);
    if (at < 0) return null;
    const usedBy = usesOf(settings, id);
    if (usedBy.length) return { removed: false, usedBy };
    providers.splice(at, 1);
    settings.providers = providers;
    writeAll(settings);
    return { removed: true };
  }

  // partial.providerId: a provider's id for a use, or null for none.
  function setProviderOf(next, partial, settings) {
    if (partial.providerId === undefined) return;
    if (partial.providerId === null || partial.providerId === "") {
      delete next.providerId;
      return;
    }
    if (!providerList(settings).some((p) => p.id === partial.providerId)) throw new ProviderError("That provider isn't added");
    next.providerId = partial.providerId;
  }

  function getBrainSettings() {
    const settings = readSettings();
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
    const { providerId, baseUrl, apiKey } = connectionOf(settings, brain);
    return {
      type: brain.type === "openai_compatible" ? "openai_compatible" : "local",
      providerId,
      baseUrl,
      apiKey,
      model: typeof brain.model === "string" ? brain.model : "",
    };
  }

  function setBrainSettings(partial = {}) {
    const settings = readSettings();
    const next = settings.brain && typeof settings.brain === "object" ? { ...settings.brain } : {};
    setProviderOf(next, partial, settings);
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

  // Optional local-first escalation: Mana keeps the local GGUF as the main
  // brain, and only uses this OpenAI-compatible endpoint when a local reply
  // path returns no usable answer. Kept separate from brain so enabling it
  // does not silently turn normal chat into remote-first mode.
  function getFallbackSettings() {
    const settings = readSettings();
    const fallback = settings.fallback && typeof settings.fallback === "object" ? settings.fallback : {};
    const { providerId, baseUrl, apiKey } = connectionOf(settings, fallback);
    return {
      enabled: fallback.enabled === true,
      timeoutSeconds: [10, 30, 60].includes(fallback.timeoutSeconds) ? fallback.timeoutSeconds : 0,
      providerId,
      baseUrl,
      apiKey,
      model: typeof fallback.model === "string" ? fallback.model : "",
    };
  }

  function setFallbackSettings(partial = {}) {
    const settings = readSettings();
    const next = settings.fallback && typeof settings.fallback === "object" ? { ...settings.fallback } : {};
    setProviderOf(next, partial, settings);
    if (partial.enabled !== undefined) next.enabled = partial.enabled === true;
    if (partial.timeoutSeconds !== undefined) next.timeoutSeconds = partial.timeoutSeconds;
    if (partial.baseUrl !== undefined) next.baseUrl = String(partial.baseUrl || "").trim();
    if (partial.apiKey !== undefined) {
      delete next.apiKey;
      delete next.apiKeyProtected;
      Object.assign(next, apiKeyFields(String(partial.apiKey || "").trim()));
    }
    if (partial.model !== undefined) next.model = String(partial.model || "").trim();
    settings.fallback = next;
    writeAll(settings);
    return getFallbackSettings();
  }

  // #1406: self-work's DeepSeek escalation. Off until I switch it on with
  // a key in Settings; the key is protected like the others, and routes
  // only ever say whether there is one.
  function getEscalationSettings() {
    const settings = readSettings();
    const e = settings.escalation && typeof settings.escalation === "object" ? settings.escalation : {};
    const { providerId, preset, baseUrl, apiKey } = connectionOf(settings, e, PROVIDER_PRESETS.deepseek.baseUrl);
    return { enabled: e.enabled === true, providerId, preset, baseUrl, apiKey };
  }

  function setEscalationSettings(partial = {}) {
    const settings = readSettings();
    const next = settings.escalation && typeof settings.escalation === "object" ? { ...settings.escalation } : {};
    setProviderOf(next, partial, settings);
    if (partial.enabled !== undefined) next.enabled = partial.enabled === true;
    if (partial.baseUrl !== undefined) next.baseUrl = String(partial.baseUrl || "").trim();
    if (partial.apiKey !== undefined) {
      delete next.apiKey;
      delete next.apiKeyProtected;
      Object.assign(next, apiKeyFields(String(partial.apiKey || "").trim()));
    }
    settings.escalation = next;
    writeAll(settings);
    return getEscalationSettings();
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
    getFallbackSettings,
    setFallbackSettings,
    getEscalationSettings,
    setEscalationSettings,
    listProviders,
    getProvider,
    addProvider,
    updateProvider,
    removeProvider,
    getVisionSettings,
    setVisionSettings,
  };
}

module.exports = { ProviderError, createModelSettingsStore };
