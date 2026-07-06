const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_LLAMA_MODEL = "Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M";
const LLAMA_MODEL_PROFILES = {
  default: {
    label: "Default chat",
    names: [
      "Qwen3-4B-Q4_K_M.gguf",
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "Qwen3-8B-Q4_K_M.gguf",
    ],
  },
  fast: {
    label: "Fast fallback",
    names: [
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "Qwen3-4B-Q4_K_M.gguf",
      "Qwen3-8B-Q4_K_M.gguf",
    ],
  },
  quality: {
    label: "Quality fallback",
    names: [
      "Qwen3-8B-Q4_K_M.gguf",
      "Qwen3-4B-Q4_K_M.gguf",
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    ],
  },
  coding: {
    label: "Coding",
    names: [
      "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
      "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
      "Qwen3-4B-Q4_K_M.gguf",
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "Qwen3-8B-Q4_K_M.gguf",
    ],
  },
};

function shouldUseRemoteAi({
  apiKey = process.env.OPENAI_API_KEY || null,
  allowRemoteAi = process.env.MANA_ALLOW_REMOTE_AI || "",
} = {}) {
  return Boolean(apiKey && allowRemoteAi === "1");
}

function getKnownLlamaModelProfiles() {
  return Object.keys(LLAMA_MODEL_PROFILES);
}

function isKnownLlamaModelProfile(profile) {
  if (typeof profile !== "string") {
    return false;
  }
  return Boolean(LLAMA_MODEL_PROFILES[profile.trim().toLowerCase()]);
}

function normalizeLlamaModelProfile(profile) {
  const normalized = String(profile || "default")
    .trim()
    .toLowerCase();
  return LLAMA_MODEL_PROFILES[normalized] ? normalized : "default";
}

function hasExplicitLlamaModelProfile(profile) {
  if (typeof profile !== "string") {
    return false;
  }
  const normalized = profile.trim().toLowerCase();
  return Boolean(normalized && LLAMA_MODEL_PROFILES[normalized]);
}

function pickPreferredLlamaModel({
  explicitModel = "",
  localGgufs = [],
  defaultModel = DEFAULT_LLAMA_MODEL,
  profile = "default",
} = {}) {
  const normalizedProfile = normalizeLlamaModelProfile(profile);
  if (explicitModel && normalizedProfile === "default") {
    return explicitModel;
  }

  const modelProfile = LLAMA_MODEL_PROFILES[normalizedProfile];
  for (const preferredName of modelProfile.names) {
    const match = localGgufs.find(
      (fullPath) =>
        path.basename(fullPath).toLowerCase() === preferredName.toLowerCase(),
    );
    if (match) {
      return match;
    }
  }

  return modelProfile.defaultModel || localGgufs[0] || defaultModel;
}

function collectFilesRecursively(rootDir, predicate) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  const matches = [];
  const pending = [rootDir];
  while (pending.length) {
    const currentDir = pending.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (predicate(fullPath)) {
        matches.push(fullPath);
      }
    }
  }

  return matches;
}

function findPreferredLlamaModel({
  explicitModel = process.env.LLAMA_MODEL || "",
  searchDir = path.join(__dirname, "..", "..", "tools", "llama"),
  profile = "default",
  localGgufs,
} = {}) {
  // DEBUG: log localGgufs for failing unit test investigation
  // console.log("DEBUG findPreferredLlamaModel localGgufs:", localGgufs);
  const modelFiles =
    Array.isArray(localGgufs) && localGgufs.length > 0
      ? localGgufs
      : collectFilesRecursively(searchDir, (fullPath) =>
          fullPath.toLowerCase().endsWith(".gguf"),
        );
  const explicitForPick =
    Array.isArray(localGgufs) && localGgufs.length > 0 ? "" : explicitModel;
  return pickPreferredLlamaModel({
    explicitModel: explicitForPick,
    localGgufs: modelFiles,
    profile,
  });
}

function selectLlamaModelProfileForPrompt(prompt, explicitProfile = "") {
  if (hasExplicitLlamaModelProfile(explicitProfile)) {
    return normalizeLlamaModelProfile(explicitProfile);
  }

  const text = String(prompt || "").toLowerCase();
  if (
    /\b(coding|code|programming|debug|debugging|refactor|javascript|typescript|python|powershell|node\.?js|react|next\.?js|css|html|git|stack trace|unit test|npm test)\b/.test(
      text,
    )
  ) {
    return "coding";
  }

  if (
    /\b(quality mode|better answer|deeper answer|use 8b|8b mode)\b/.test(text)
  ) {
    return "quality";
  }

  return "default";
}

module.exports = {
  DEFAULT_LLAMA_MODEL,
  LLAMA_MODEL_PROFILES,
  collectFilesRecursively,
  findPreferredLlamaModel,
  getKnownLlamaModelProfiles,
  isKnownLlamaModelProfile,
  normalizeLlamaModelProfile,
  pickPreferredLlamaModel,
  selectLlamaModelProfileForPrompt,
  shouldUseRemoteAi,
};
