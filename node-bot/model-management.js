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
    if (vramMb < 16384) {
      return {
        profile: "default",
        reason: `Detected ~${vramGb}GB GPU VRAM (via nvidia-smi). 8-16GB comfortably fits the default 4B-class profile.`,
      };
    }
    return {
      profile: "quality",
      reason: `Detected ~${vramGb}GB GPU VRAM (via nvidia-smi). 16GB+ comfortably fits the quality 8B-class profile.`,
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
  let activeProfile = normalizeLlamaModelProfile(
    options.activeProfile || "default",
  );

  function getActiveProfile() {
    return activeProfile;
  }

  function buildProfileStatus(profile, localGgufs) {
    const definition = LLAMA_MODEL_PROFILES[profile];
    const selectedModel = pickPreferredLlamaModel({
      explicitModel: env.LLAMA_MODEL || "",
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

  return {
    getActiveProfile,
    getModelStatus,
    getRecommendedModelProfile,
    setActiveProfile,
  };
}

module.exports = {
  createModelManagement,
  detectGpuVramMb,
  detectSystemMemoryMb,
  recommendModelProfile,
};
