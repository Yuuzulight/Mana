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
      { encoding: "utf8", timeout: 5000 },
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

  function getModelStatus() {
    const localGgufs = collectLocalGgufs();
    const profiles = {};
    for (const profile of getKnownLlamaModelProfiles()) {
      profiles[profile] = buildProfileStatus(profile, localGgufs);
    }

    const remoteAiEnabled = shouldUseRemoteAi({
      apiKey: env.OPENAI_API_KEY || null,
      allowRemoteAi: env.MANA_ALLOW_REMOTE_AI || "",
    });

    return {
      activeProfile,
      remoteAiEnabled,
      remoteAiWarning: remoteAiEnabled
        ? "Remote AI is enabled. Mana may use paid or proxy chat replies."
        : null,
      profiles,
      recommendation: getRecommendedModelProfile(),
      selectedModelPath: modelSettingsStore.getModelPath(),
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
    }
    modelSettingsStore.setModelPath(resolved || null);
    return getModelStatus();
  }

  function scanForModels(roots) {
    const searchRoots = Array.isArray(roots) && roots.length ? roots : defaultScanRoots();
    return scanForGgufFiles({ roots: searchRoots });
  }

  return {
    getActiveProfile,
    getModelStatus,
    getRecommendedModelProfile,
    scanForModels,
    setActiveProfile,
    setModelPath,
  };
}

module.exports = {
  createModelManagement,
  detectGpuVramMb,
  detectSystemMemoryMb,
  recommendModelProfile,
};
