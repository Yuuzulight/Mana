const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");
const {
  DEFAULT_LLAMA_MODEL,
  LLAMA_MODEL_PROFILES,
  collectFilesRecursively,
  getKnownLlamaModelProfiles,
  isKnownLlamaModelProfile,
  normalizeLlamaModelProfile,
  pickPreferredLlamaModel,
  shouldUseRemoteAi,
} = require("./ai/local-ai");
const { createModelSettingsStore } = require("./model-settings-store");

// "Use Remote AI" provider presets for Settings' brain-provider dropdown --
// each is an OpenAI-compatible endpoint (Mana's runOpenAIReply in
// server.js always POSTs the standard {model, messages, max_tokens}
// shape to {baseUrl}/v1/chat/completions), so this only lists servers
// that actually speak that shape. "custom" leaves baseUrl for the user to
// fill in -- any other OpenAI-compatible server (a different local
// runtime, a proxy, another host on the LAN) works the same way.
const BRAIN_PROVIDER_PRESETS = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", needsKey: true },
  ollama: { label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false },
  lmstudio: { label: "LM Studio (local)", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false },
  custom: { label: "Custom", baseUrl: "", needsKey: false },
};

// Directory names skipped during a full-storage scan for .gguf files: OS
// internals and huge dev-tool caches that are never where a downloaded model
// lives, but would otherwise blow the time/dir budget below. Best-effort
// heuristic, not exhaustive -- browsing to the exact file (the other half of
// this feature) is the reliable fallback when a model sits somewhere odd.
const SCAN_SKIP_DIR_NAMES = new Set([
  "$recycle.bin",
  "system volume information",
  "node_modules",
  ".git",
  "windows",
  "programdata",
  "appdata",
]);

// Walks the given roots looking for .gguf files. Unlike collectFilesRecursively
// (used for the fixed tools/llama/ search dir), this must survive scanning
// an entire drive: permission-denied directories are common outside a user's
// own folders and must not abort the whole scan, and the walk needs hard
// caps so a giant or slow drive can't hang the request indefinitely.
function scanForGgufFiles({
  roots,
  maxDepth = 6,
  maxDirsVisited = 25000,
  timeBudgetMs = 20000,
} = {}) {
  const startedAt = Date.now();
  const found = [];
  const seen = new Set();
  let dirsVisited = 0;
  let truncated = false;

  for (const root of roots) {
    if (truncated) break;
    const pending = [{ dir: root, depth: 0 }];
    while (pending.length) {
      if (dirsVisited >= maxDirsVisited || Date.now() - startedAt > timeBudgetMs) {
        truncated = true;
        break;
      }
      const { dir, depth } = pending.pop();
      dirsVisited += 1;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const lower = entry.name.toLowerCase();
          if (depth >= maxDepth || SCAN_SKIP_DIR_NAMES.has(lower) || lower.startsWith("$")) {
            continue;
          }
          pending.push({ dir: fullPath, depth: depth + 1 });
          continue;
        }
        if (!entry.name.toLowerCase().endsWith(".gguf") || seen.has(fullPath)) {
          continue;
        }
        seen.add(fullPath);
        let sizeBytes = null;
        try {
          sizeBytes = fs.statSync(fullPath).size;
        } catch (e) {}
        found.push({ path: fullPath, name: entry.name, sizeBytes });
      }
    }
  }

  return { found, truncated, dirsVisited };
}

function defaultScanRoots() {
  const roots = [os.homedir()].filter(Boolean);
  if (process.platform === "win32") {
    for (let code = 67; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (fs.existsSync(drive)) {
        roots.push(drive);
      }
    }
  } else {
    roots.push("/");
  }
  return [...new Set(roots)];
}

// Best-effort GPU VRAM detection: only NVIDIA GPUs via nvidia-smi (already a
// hard assumption throughout Mana's docs/tooling for local CUDA inference).
// Returns null -- never throws -- if nvidia-smi is missing, times out, or
// the output can't be parsed, so callers always have a graceful fallback.
function detectGpuVramMb(spawnSync = defaultSpawnSync) {
  try {
    const result = spawnSync(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      // Issue #388: windowsHide so the probe does not flash a console.
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    );
    if (result.error || result.status !== 0 || !result.stdout) {
      return null;
    }
    const firstLine = result.stdout.trim().split("\n")[0];
    const vramMb = parseInt(firstLine, 10);
    return Number.isFinite(vramMb) && vramMb > 0 ? vramMb : null;
  } catch (e) {
    return null;
  }
}

// Issue #320: live usage, unlike detectGpuVramMb's capacity check -- usage
// genuinely changes over time (what's currently resident), so this is never
// cached at this layer. Callers that poll frequently (e.g. /models/status)
// own their own short-TTL cache instead of re-spawning nvidia-smi per call.
function detectGpuVramUsageMb(spawnSync = defaultSpawnSync) {
  try {
    const result = spawnSync(
      "nvidia-smi",
      ["--query-gpu=memory.used,memory.free", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    );
    if (result.error || result.status !== 0 || !result.stdout) {
      return null;
    }
    const firstLine = result.stdout.trim().split("\n")[0];
    const [usedRaw, freeRaw] = firstLine.split(",").map((part) => part.trim());
    const usedMb = parseInt(usedRaw, 10);
    const freeMb = parseInt(freeRaw, 10);
    if (!Number.isFinite(usedMb) || !Number.isFinite(freeMb)) {
      return null;
    }
    return { usedMb, freeMb };
  } catch (e) {
    return null;
  }
}

function detectSystemMemoryMb(totalmem = os.totalmem) {
  const bytes = totalmem();
  return Number.isFinite(bytes) && bytes > 0
    ? Math.round(bytes / (1024 * 1024))
    : null;
}

// Thresholds are deliberately simple: this is a starting-point suggestion,
// not a hardware benchmark. "fast" keeps headroom for TTS/whisper alongside
// the LLM on tighter cards; "quality" assumes enough room to prefer the 8B
// tier by default.
function recommendModelProfile({ vramMb, ramMb }) {
  if (vramMb != null) {
    const vramGb = (vramMb / 1024).toFixed(1);
    if (vramMb < 8192) {
      return {
        profile: "fast",
        reason: `Detected ~${vramGb}GB GPU VRAM (via nvidia-smi). Under 8GB, the fast/1.5B-class profile leaves headroom for TTS and Whisper running alongside the LLM.`,
      };
    }
    // nvidia-smi reports usable VRAM, which comes in a bit under a card's
    // nominal size (driver/OS reservations) -- a real 16GB card often
    // reports ~16000-16300MB, not >=16384. Cut at 15360 (15GB) so it still
    // lands in "quality" instead of being silently under-recommended.
    if (vramMb < 15360) {
      return {
        profile: "default",
        reason: `Detected ~${vramGb}GB GPU VRAM (via nvidia-smi). 8-15GB comfortably fits the default 4B-class profile.`,
      };
    }
    return {
      profile: "quality",
      reason: `Detected ~${vramGb}GB GPU VRAM (via nvidia-smi). 15GB+ comfortably fits the quality 8-14B-class profile.`,
    };
  }

  // No NVIDIA GPU detected (or nvidia-smi unavailable): fall back to system
  // RAM as a much rougher proxy, and say so explicitly.
  if (ramMb != null) {
    const ramGb = (ramMb / 1024).toFixed(1);
    const caveat =
      "GPU VRAM could not be detected (nvidia-smi unavailable), so this falls back to system RAM as a rough proxy -- a dedicated GPU with less VRAM than your system RAM will run slower than this suggests.";
    if (ramMb < 16384) {
      return { profile: "fast", reason: `~${ramGb}GB system RAM detected. ${caveat}` };
    }
    if (ramMb < 32768) {
      return { profile: "default", reason: `~${ramGb}GB system RAM detected. ${caveat}` };
    }
    return { profile: "quality", reason: `~${ramGb}GB system RAM detected. ${caveat}` };
  }

  return {
    profile: "fast",
    reason:
      "Could not detect GPU VRAM or system RAM. Defaulting to the fast/1.5B-class profile, the safest choice on unknown hardware.",
  };
}

function createModelManagement(options = {}) {
  const env = options.env || process.env;
  const searchDir =
    options.searchDir || path.join(__dirname, "..", "tools", "llama");
  const collectLocalGgufs =
    options.collectLocalGgufs ||
    (() =>
      options.localGgufs ||
      collectFilesRecursively(searchDir, (fullPath) =>
        fullPath.toLowerCase().endsWith(".gguf"),
      ));
  const spawnSync = options.spawnSync || defaultSpawnSync;
  const totalmem = options.totalmem || os.totalmem;
  const modelSettingsStore =
    options.modelSettingsStore || createModelSettingsStore();
  let activeProfile = normalizeLlamaModelProfile(
    options.activeProfile || "default",
  );

  function getActiveProfile() {
    return activeProfile;
  }

  function explicitModelPath() {
    return modelSettingsStore.getModelPath() || env.LLAMA_MODEL || "";
  }

  function buildProfileStatus(profile, localGgufs) {
    const definition = LLAMA_MODEL_PROFILES[profile];
    const selectedModel = pickPreferredLlamaModel({
      explicitModel: explicitModelPath(),
      localGgufs,
      profile,
      defaultModel: DEFAULT_LLAMA_MODEL,
    });
    const candidates = definition.names.map((name) => {
      const match = localGgufs.find(
        (fullPath) =>
          path.basename(fullPath).toLowerCase() === name.toLowerCase(),
      );
      return {
        name,
        path: match || null,
        exists: Boolean(match),
      };
    });

    return {
      key: profile,
      label: definition.label,
      selectedModel,
      available: candidates.some((candidate) => candidate.exists),
      candidates,
      missing: candidates
        .filter((candidate) => !candidate.exists)
        .map((candidate) => candidate.name),
    };
  }

  // Hardware doesn't change mid-process; detect and cache once rather than
  // re-shelling out to nvidia-smi on every /models/status poll.
  let cachedRecommendation = null;

  // Issue #320: unlike total capacity, live usage genuinely changes --
  // caching it forever like cachedRecommendation would make it useless.
  // But /models/status is polled frequently (per its own route comment in
  // server.js), so a fresh nvidia-smi spawn on every single poll isn't free
  // either. A short TTL splits the difference: still "live" to a human
  // watching a status readout, without a spawn per poll tick.
  const VRAM_USAGE_CACHE_MS = 2000;
  const now = options.now || (() => Date.now());
  let cachedVramUsage; // { usage, at } | undefined
  function getLiveVramUsage() {
    const nowMs = now();
    if (cachedVramUsage && nowMs - cachedVramUsage.at < VRAM_USAGE_CACHE_MS) {
      return cachedVramUsage.usage;
    }
    const usage = detectGpuVramUsageMb(spawnSync);
    cachedVramUsage = { usage, at: nowMs };
    return usage;
  }

  function getRecommendedModelProfile() {
    if (!cachedRecommendation) {
      const vramMb = detectGpuVramMb(spawnSync);
      const ramMb = detectSystemMemoryMb(totalmem);
      const { profile, reason } = recommendModelProfile({ vramMb, ramMb });
      cachedRecommendation = {
        profile,
        label: LLAMA_MODEL_PROFILES[profile].label,
        reason,
        detected: { vramMb, ramMb },
      };
    }
    return cachedRecommendation;
  }

  // The Settings-configured brain override, if the user has switched to
  // "openai_compatible" -- falls back to the matching env var per field
  // when that field wasn't explicitly set in Settings, same override
  // convention as explicitModelPath() above.
  function effectiveOpenAiConfig() {
    const brain = modelSettingsStore.getBrainSettings();
    const usingOverride = brain.type === "openai_compatible";
    return {
      apiKey: (usingOverride && brain.apiKey) || env.OPENAI_API_KEY || null,
      baseUrl:
        (usingOverride && brain.baseUrl) ||
        env.OPENAI_BASE_URL ||
        "https://api.openai.com",
    };
  }

  function getModelStatus() {
    const localGgufs = collectLocalGgufs();
    const profiles = {};
    for (const profile of getKnownLlamaModelProfiles()) {
      profiles[profile] = buildProfileStatus(profile, localGgufs);
    }

    const { apiKey, baseUrl } = effectiveOpenAiConfig();
    const remoteAiEnabled = shouldUseRemoteAi({
      apiKey,
      allowRemoteAi: env.MANA_ALLOW_REMOTE_AI || "",
      baseUrl,
    });

    const liveVramUsage = getLiveVramUsage();
    return {
      activeProfile,
      remoteAiEnabled,
      remoteAiWarning: remoteAiEnabled
        ? "Remote AI is enabled. Mana may use paid or proxy chat replies."
        : null,
      profiles,
      recommendation: getRecommendedModelProfile(),
      // Issue #320: live usage (changes constantly), separate from
      // recommendation.detected.vramMb (total capacity, detected once).
      // null when nvidia-smi is unavailable -- same graceful-fallback
      // convention as every other GPU-detection field here.
      vramUsedMb: liveVramUsage?.usedMb ?? null,
      vramFreeMb: liveVramUsage?.freeMb ?? null,
      selectedModelPath: modelSettingsStore.getModelPath(),
      // apiKey is never echoed back -- /models/status has no auth check,
      // same reasoning as auth-store.js never returning a stored keyHash.
      brain: (() => {
        const { apiKey, ...rest } = modelSettingsStore.getBrainSettings();
        return { ...rest, hasApiKey: Boolean(apiKey) };
      })(),
      vision: modelSettingsStore.getVisionSettings(),
    };
  }

  function setActiveProfile(profile) {
    if (!isKnownLlamaModelProfile(profile)) {
      throw new Error(
        `profile must be one of: ${getKnownLlamaModelProfiles().join(", ")}`,
      );
    }
    activeProfile = normalizeLlamaModelProfile(profile);
    return getModelStatus();
  }

  // User-picked override (from a scan result or a manual browse), persisted
  // GGUF files open with the 4-byte magic "GGUF" (see ggml's gguf spec).
  // Since setModelPath/setVisionSettings accept any path the user browses
  // to or types in, this catches a truncated download or a mislabeled
  // non-GGUF file before it's ever handed to llama-server, rather than
  // trusting the ".gguf" extension alone.
  function isValidGgufFile(filePath) {
    let fd;
    try {
      fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      return buf.toString("ascii") === "GGUF";
    } catch (e) {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // via model-settings-store.js. Only takes effect for the "default" profile
  // -- same rule pickPreferredLlamaModel already applies to LLAMA_MODEL, so
  // switching to "coding"/"quality"/"fast" still auto-discovers by filename.
  function setModelPath(modelPath) {
    const resolved = String(modelPath || "").trim();
    if (resolved) {
      if (!resolved.toLowerCase().endsWith(".gguf")) {
        throw new Error("Model path must point to a .gguf file");
      }
      if (!fs.existsSync(resolved)) {
        throw new Error(`Model file not found: ${resolved}`);
      }
      if (!isValidGgufFile(resolved)) {
        throw new Error(`File does not look like a valid GGUF model: ${resolved}`);
      }
    }
    modelSettingsStore.setModelPath(resolved || null);
    return getModelStatus();
  }

  function scanForModels(roots) {
    const searchRoots = Array.isArray(roots) && roots.length ? roots : defaultScanRoots();
    return scanForGgufFiles({ roots: searchRoots });
  }

  // Switches Mana's "brain" between the local llama-server path (default)
  // and any OpenAI-compatible endpoint -- a self-hosted server (Ollama, LM
  // Studio, vLLM, text-generation-webui, llama-server's own OpenAI-shaped
  // API, ...) or a real third-party API. See shouldUseRemoteAi in
  // ai/local-ai.js for how baseUrl's host decides whether that counts as
  // "remote" for consent purposes.
  function setBrainSettings(partial = {}) {
    if (
      partial.type !== undefined &&
      !["local", "openai_compatible"].includes(partial.type)
    ) {
      throw new Error('type must be "local" or "openai_compatible"');
    }
    if (partial.baseUrl) {
      let parsed;
      try {
        parsed = new URL(partial.baseUrl);
      } catch (e) {
        throw new Error(`baseUrl is not a valid URL: ${partial.baseUrl}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`baseUrl must be http:// or https://: ${partial.baseUrl}`);
      }
    }
    modelSettingsStore.setBrainSettings(partial);
    return getModelStatus();
  }

  // Vision GGUF + mmproj override (see findVisionModel/findVisionMmproj in
  // ai/llama-server-runtime.js) -- empty string clears back to
  // auto-detection under tools/llama/gguf-models.
  function setVisionSettings(partial = {}) {
    for (const key of ["modelPath", "mmprojPath"]) {
      const value = partial[key];
      if (value === undefined || value === "") continue;
      if (!String(value).toLowerCase().endsWith(".gguf")) {
        throw new Error(`${key} must point to a .gguf file`);
      }
      if (!fs.existsSync(value)) {
        throw new Error(`File not found: ${value}`);
      }
      if (!isValidGgufFile(value)) {
        throw new Error(`${key} does not look like a valid GGUF model: ${value}`);
      }
    }
    modelSettingsStore.setVisionSettings(partial);
    return getModelStatus();
  }

  // Preset list for Settings' brain-provider dropdown -- baseUrl/needsKey
  // are pre-filled from BRAIN_PROVIDER_PRESETS, apiKey is never included.
  function getKnownBrainProviders() {
    return Object.entries(BRAIN_PROVIDER_PRESETS).map(([id, preset]) => ({
      id,
      ...preset,
    }));
  }

  // "Connect" button backend: hits the standard OpenAI-compatible
  // GET {baseUrl}/models endpoint (supported by OpenAI, OpenRouter, Groq,
  // Ollama, and LM Studio alike) to confirm the server is reachable and,
  // if a key was given, that it's accepted.
  async function testBrainConnection({ baseUrl, apiKey } = {}) {
    if (!baseUrl) {
      return { ok: false, error: "baseUrl is required" };
    }
    // Trim trailing slashes without a regex -- a user-controlled string fed
    // into a repetition-quantifier regex is a ReDoS shape CodeQL flags even
    // when (as here) the pattern itself can't actually backtrack.
    let trimmedBaseUrl = String(baseUrl);
    while (trimmedBaseUrl.endsWith("/")) {
      trimmedBaseUrl = trimmedBaseUrl.slice(0, -1);
    }
    let url;
    try {
      url = new URL(trimmedBaseUrl + "/models");
    } catch (e) {
      return { ok: false, error: `baseUrl is not a valid URL: ${baseUrl}` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: `baseUrl must be http:// or https://: ${baseUrl}` };
    }
    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      const status = resp.status;
      if (!resp.ok) {
        return { ok: false, status, error: `Server responded ${status}` };
      }
      const data = await resp.json().catch(() => null);
      const modelCount = Array.isArray(data?.data) ? data.data.length : null;
      return { ok: true, status, modelCount };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  return {
    getActiveProfile,
    getKnownBrainProviders,
    getModelStatus,
    getRecommendedModelProfile,
    isValidGgufFile,
    scanForModels,
    setActiveProfile,
    setBrainSettings,
    setModelPath,
    setVisionSettings,
    testBrainConnection,
  };
}

module.exports = {
  createModelManagement,
  detectGpuVramMb,
  detectGpuVramUsageMb,
  detectSystemMemoryMb,
  recommendModelProfile,
};
