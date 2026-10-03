const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createEditorIntegrations } = require("./zed-integration");
const { assertLocalAiPolicy } = require("./mana-acp-agent");
const { isMcpServerEnabled } = require("./mcp-server");
const { createModelManagement, getGpu } = require("./model-management");
const {
  findWhisperBin,
  findWhisperModel,
  isEnglishOnlyWhisperModel,
} = require("./whisper-discovery");

const DEFAULT_NODE_MAJOR = 18;
const DEFAULT_BACKEND_PORT = 5005;
const DEFAULT_BACKEND_URL = "http://127.0.0.1:5005";

function checkPathExists(filePath) {
  return typeof filePath === "string" && filePath.trim() && fs.existsSync(filePath);
}

function hasRemoteAiEnabled(env) {
  return String(env.MANA_ALLOW_REMOTE_AI || "").trim() === "1";
}

function normalizeStatus(status) {
  return ["pass", "warn", "fail"].includes(status) ? status : "warn";
}

function makeCheck(id, label, status, message, details = {}) {
  return {
    id,
    label,
    status: normalizeStatus(status),
    message,
    details,
  };
}

function summarizeChecks(checks) {
  return checks.reduce(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
}

function getNodeMajor(version) {
  const match = String(version || "").match(/^v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

function checkNodeRuntime(version) {
  const major = getNodeMajor(version);
  if (major >= DEFAULT_NODE_MAJOR) {
    return makeCheck(
      "node-runtime",
      "Node runtime",
      "pass",
      `Node ${version} is available.`,
      { version },
    );
  }

  return makeCheck(
    "node-runtime",
    "Node runtime",
    "fail",
    `Node ${version || "unknown"} is too old. Use Node ${DEFAULT_NODE_MAJOR} or newer.`,
    { version },
  );
}

function checkLocalAiPolicy(env) {
  if (!hasRemoteAiEnabled(env)) {
    return makeCheck(
      "local-ai-policy",
      "Local AI policy",
      "pass",
      "Remote AI is disabled.",
    );
  }

  return makeCheck(
    "local-ai-policy",
    "Local AI policy",
    "warn",
    "Remote AI is enabled. Set MANA_ALLOW_REMOTE_AI=0 for strictly local replies.",
  );
}

function checkMcpServer(env) {
  if (!isMcpServerEnabled(env)) {
    return makeCheck(
      "mcp-server",
      "MCP server",
      "pass",
      "MCP server is disabled (opt-in). Set MANA_MCP_SERVER_ENABLED=1 and run `npm run mcp` to expose Mana's tools over MCP.",
    );
  }

  return makeCheck(
    "mcp-server",
    "MCP server",
    "pass",
    "MCP server is enabled. Run `npm run mcp` to start it over stdio for MCP clients like Claude Desktop or Claude Code.",
  );
}

// #1065: Mana's GPU paths (llama.cpp, Whisper, Fish Speech) are CUDA-only,
// so anything but a working NVIDIA GPU means CPU. Supported, but slower --
// a warn, not a fail.
function checkGpu(gpu) {
  if (gpu?.cuda) {
    const vramGb = (gpu.vramMb / 1024).toFixed(1);
    return makeCheck("gpu", "GPU", "pass", `${gpu.name} (${vramGb} GB VRAM): CUDA available for chat and voice.`, { gpu });
  }
  let message = "No NVIDIA GPU: voice and chat run on CPU.";
  if (gpu?.vendor === "nvidia") {
    message = `${gpu.name} found, but nvidia-smi isn't answering (check the NVIDIA driver): voice and chat run on CPU.`;
  } else if (gpu) {
    const memory = gpu.sharedMemory
      ? "integrated, shared memory"
      : gpu.vramMb ? `${(gpu.vramMb / 1024).toFixed(1)} GB VRAM` : "VRAM unknown";
    message = `No NVIDIA GPU (found ${gpu.name}, ${memory}; Mana's GPU acceleration is CUDA-only): voice and chat run on CPU.`;
  }
  return makeCheck("gpu", "GPU", "warn", message, { gpu: gpu || null });
}

function checkRecommendedModelProfile(modelManagement) {
  const recommendation = modelManagement.getRecommendedModelProfile();
  return makeCheck(
    "recommended-model-profile",
    "Recommended model profile",
    "pass",
    `Suggested starting profile: ${recommendation.label} (${recommendation.profile}). ${recommendation.reason} This is only a suggestion -- manual profile selection (LLAMA_MODEL, or TTS_PROVIDER-style overrides) is unaffected.`,
    { recommendation },
  );
}

// Issue #1343: VRAM budget check for Tri-Mode architecture:
// - Everyday resident 9B + LoRAs + Qwen3TTS (~12.0 GB, ~4.3 GB free headroom)
// - Engineering session on-demand 14B Coder (~13.9 GB, ~2.4 GB free headroom, requires ~9.0 GB VRAM)
// - Gaming guard (locks out 14B coder while gaming is active)
function checkVramBudgets({ gpu, vramUsage, gamingWatch } = {}) {
  if (!gpu || !gpu.cuda) {
    return makeCheck(
      "vram-budgets",
      "VRAM telemetry",
      "pass",
      "No CUDA GPU detected; VRAM budget checks not applicable.",
      { gpu: gpu || null },
    );
  }

  const totalMb = gpu.vramMb || 0;
  const usedMb = vramUsage?.usedMb ?? null;
  const freeMb = vramUsage?.freeMb ?? (usedMb !== null && totalMb ? totalMb - usedMb : null);

  const isGaming = typeof gamingWatch?.isGaming === "function" && gamingWatch.isGaming();
  if (isGaming) {
    const freeGbStr = freeMb !== null ? `${(freeMb / 1024).toFixed(1)} GB free` : "gaming active";
    return makeCheck(
      "vram-budgets",
      "VRAM telemetry",
      "warn",
      `Gaming mode active: 14B Coder engine is locked out to protect gaming VRAM (${freeGbStr}).`,
      { totalMb, usedMb, freeMb, gaming: true, codingEngineLocked: true },
    );
  }

  if (freeMb !== null) {
    const freeGb = freeMb / 1024;
    if (freeMb >= 9000) {
      return makeCheck(
        "vram-budgets",
        "VRAM telemetry",
        "pass",
        `VRAM headroom (${freeGb.toFixed(1)} GB free): ready for instant on-demand 14B Coder engine (~9.0 GB required).`,
        { totalMb, usedMb, freeMb, codingEngineReady: true },
      );
    }
    if (freeMb >= 4000) {
      return makeCheck(
        "vram-budgets",
        "VRAM telemetry",
        "pass",
        `VRAM headroom (${freeGb.toFixed(1)} GB free): everyday resident model active. On-demand 14B coder session will park resident model in host RAM.`,
        { totalMb, usedMb, freeMb, codingEngineReady: true, requiresHostRamParking: true },
      );
    }
    return makeCheck(
      "vram-budgets",
      "VRAM telemetry",
      "warn",
      `VRAM constrained (${freeGb.toFixed(1)} GB free): tight VRAM headroom; heavy tasks may cause paging.`,
      { totalMb, usedMb, freeMb, codingEngineReady: false },
    );
  }

  return makeCheck(
    "vram-budgets",
    "VRAM telemetry",
    "pass",
    `${gpu.name} (${(totalMb / 1024).toFixed(1)} GB total VRAM).`,
    { totalMb, gpu },
  );
}

// Issue #1343: sticky coding session status in Doctor output
function checkCodingSession(stickyCodingSession) {
  if (!stickyCodingSession) {
    return makeCheck(
      "coding-session",
      "Coding session",
      "pass",
      "Everyday mode active (default 9B multi-LoRA resident brain).",
      { active: false },
    );
  }

  const active = typeof stickyCodingSession.isCodingSessionActive === "function"
    ? stickyCodingSession.isCodingSessionActive()
    : Boolean(stickyCodingSession.active);

  if (active) {
    const remainingMs = typeof stickyCodingSession.remainingMs === "function"
      ? stickyCodingSession.remainingMs()
      : null;
    const remainingStr = remainingMs ? ` (${Math.round(remainingMs / 60000)}m remaining until idle timeout)` : "";
    return makeCheck(
      "coding-session",
      "Coding session",
      "pass",
      `Coding mode active: sticky session locked to Qwen2.5-Coder-14B${remainingStr}.`,
      { active: true, remainingMs },
    );
  }

  return makeCheck(
    "coding-session",
    "Coding session",
    "pass",
    "Everyday mode active (default 9B multi-LoRA resident brain).",
    { active: false },
  );
}

function checkRequiredFile(id, label, filePath, missingConfigMessage) {
  if (!filePath) {
    return makeCheck(id, label, "warn", missingConfigMessage);
  }

  if (checkPathExists(filePath)) {
    return makeCheck(id, label, "pass", `${label} found.`, {
      path: filePath,
    });
  }

  return makeCheck(id, label, "fail", `${label} not found at configured path.`, {
    path: filePath,
  });
}

// With LLAMA_SERVER_BIN unset, asks the runtime's own lookup (active build,
// next to LLAMA_BIN, bundled), so an auto-detected server passes instead of
// warning on every start.
function checkLlamaServerBinary(env, findLlamaServerBin) {
  const id = "llama-server-binary";
  const label = "Llama server binary";
  if (env.LLAMA_SERVER_BIN || !findLlamaServerBin) {
    return checkRequiredFile(
      id,
      label,
      env.LLAMA_SERVER_BIN || "",
      "LLAMA_SERVER_BIN is not configured. Mana auto-detects the bundled llama-server.exe and falls back to one-shot llama-cli replies.",
    );
  }
  try {
    return makeCheck(id, label, "pass", `${label} found (auto-detected).`, { path: findLlamaServerBin() });
  } catch (e) {
    return makeCheck(
      id,
      label,
      "warn",
      "No llama-server.exe found (LLAMA_SERVER_BIN is unset and auto-detection found none). Replies fall back to one-shot llama-cli.",
    );
  }
}

// Reflects the same auto-detection server.js's actual whisper-cli
// invocation uses (see whisper-discovery.js), not just whether the env
// vars happen to be set -- a model dropped into tools/whisper/ by hand (or
// via a setup wizard) counts as configured even with no env var at all.
// `toolsDir` is injectable so tests can point it at an empty directory
// instead of this machine's real tools/whisper/.
// language: the spoken language whisper runs with ("en", "auto", ...).
function checkWhisperConfig(env, toolsDir, language = env.WHISPER_LANGUAGE || "en") {
  const bin = findWhisperBin({ env, toolsDir });
  const model = findWhisperModel({ env, toolsDir, language });

  if (!bin && !model) {
    return makeCheck(
      "whisper-config",
      "Whisper config",
      "warn",
      "Whisper is not configured. Voice transcription will be unavailable.",
    );
  }

  if (bin && model && language !== "en" && isEnglishOnlyWhisperModel(model)) {
    return makeCheck(
      "whisper-config",
      "Whisper config",
      "warn",
      `Speech language is "${language}", but ${path.basename(model)} is English-only, so everything is transcribed as English. Use a multilingual model (e.g. ggml-large-v3-turbo) via WHISPER_MODEL.`,
      { bin, model, language },
    );
  }

  if (bin && model) {
    return makeCheck(
      "whisper-config",
      "Whisper config",
      "pass",
      "Whisper binary and model are configured.",
      { bin, model },
    );
  }

  return makeCheck(
    "whisper-config",
    "Whisper config",
    "fail",
    "Whisper binary or model path is missing.",
    { bin, model },
  );
}

function checkTtsServices(services = []) {
  if (!services.length) {
    return makeCheck(
      "tts-services",
      "TTS services",
      "warn",
      "No TTS service checks were configured.",
    );
  }

  const available = services.filter((service) => service.ok);
  if (available.length > 0) {
    return makeCheck(
      "tts-services",
      "TTS services",
      "pass",
      `${available.length} TTS service check passed.`,
      { services },
    );
  }

  return makeCheck("tts-services", "TTS services", "warn", "No TTS service responded.", {
    services,
  });
}

// Issue #215: surfaces node-bot's own eager warmupFishTts() status (issue
// #213 enabled torch.compile, which makes the first real generate() call
// after each restart take ~4 minutes) as a Doctor check instead of a
// startup-loading-screen row -- both apps' loading screens use a fixed
// row list that all must reach a terminal state before the overlay hides,
// so an open-ended multi-minute wait doesn't fit there without blocking
// startup. The Doctor popup's existing pass/warn/fail display has no such
// constraint. Returns null (filtered out below) when there's nothing
// warmup-related worth surfacing -- "idle" (never fired) and "skipped"
// (Fish Speech isn't the configured provider) are both non-issues.
function checkFishTtsWarmup(status) {
  if (!status || status === "idle" || status === "skipped") {
    return null;
  }
  if (status === "warming") {
    return makeCheck(
      "fish-tts-warmup",
      "Voice warmup",
      "warn",
      "Fish Speech is compiling its model for faster replies (about 4 minutes on a cold start) -- the first real reply this session may be slow or briefly use the fallback voice instead.",
    );
  }
  if (status === "failed") {
    return makeCheck(
      "fish-tts-warmup",
      "Voice warmup",
      "warn",
      "Fish Speech's warmup request failed -- the first real reply may be slow or use the fallback voice instead.",
    );
  }
  return makeCheck(
    "fish-tts-warmup",
    "Voice warmup",
    "pass",
    "Fish Speech is warmed up and ready for fast replies.",
  );
}

// Issue #321: session-search-index.js's createSessionSearchIndex() already
// exposes vectorEnabled() so callers can tell whether sqlite-vec's native
// extension actually loaded, but nothing outside a startup console.warn
// ever read it -- this surfaces that in the Doctor panel instead. Not
// gated on USE_EMBEDDINGS: createSessionSearchIndex() attempts to load
// sqlite-vec unconditionally, so vectorEnabled === false is always a
// genuine load failure, never an intentional "embeddings off" state.
// Same "return null when there's nothing to report" shape as
// checkFishTtsWarmup -- undefined means the caller didn't pass a
// sessionSearchIndex at all (e.g. an older test setup), not a failure.
function checkSessionSearchVectorIndex(vectorEnabled) {
  if (vectorEnabled === undefined) {
    return null;
  }
  if (vectorEnabled) {
    return makeCheck(
      "session-search-vector-index",
      "Session search (semantic)",
      "pass",
      "The sqlite-vec vector index loaded; session search uses hybrid keyword + semantic matching.",
    );
  }
  return makeCheck(
    "session-search-vector-index",
    "Session search (semantic)",
    "warn",
    "The sqlite-vec vector index failed to load; session search is keyword-only. Check that the platform-specific sqlite-vec-<platform>-<arch> package actually installed under node_modules -- this can silently fail to install even when correctly pinned in package-lock.json.",
  );
}

// Issue #400: surfaces whether the most recently assembled prompt (across
// every session -- Doctor has no one session in mind) dropped anything, so
// silent truncation is visible from the same panel as every other check
// instead of only discoverable by reading the code.
function checkPromptComposition(composition) {
  if (!composition) {
    return null;
  }
  const droppedBlocks = composition.blocks.filter((block) => {
    const dropped = block.dropped;
    if (!dropped) return false;
    return Boolean(
      dropped.truncated || dropped.skillsOmitted || dropped.turnsDroppedByAge,
    );
  });
  if (!droppedBlocks.length) {
    return makeCheck(
      "prompt-composition",
      "Prompt composition",
      "pass",
      `The last assembled prompt (${composition.totalChars} chars, ~${composition.totalEstTokens} tokens) dropped nothing.`,
      { composition },
    );
  }
  return makeCheck(
    "prompt-composition",
    "Prompt composition",
    "warn",
    `The last assembled prompt (${composition.totalChars} chars, ~${composition.totalEstTokens} tokens) dropped content in: ${droppedBlocks.map((b) => b.name).join(", ")}.`,
    { composition },
  );
}

function checkMobileAuth(env) {
  const hash = env.MOBILE_PASSCODE_HASH || env.MANA_MOBILE_PASSCODE_HASH || "";
  const secret = env.MOBILE_SESSION_SECRET || "";

  if (hash && secret) {
    return makeCheck(
      "mobile-auth",
      "Mobile auth",
      "pass",
      "Mobile passcode hash and session secret are configured.",
    );
  }

  return makeCheck(
    "mobile-auth",
    "Mobile auth",
    "warn",
    "Mobile passcode hash or session secret is missing.",
  );
}

// Issue #48: purely informational, always "pass" -- 2FA is opt-in, so not
// having enabled it is a valid, unremarkable state, not a misconfiguration
// the way a missing passcode hash/session secret is for checkMobileAuth.
function checkMobile2fa(env) {
  const totpSecret = env.MOBILE_TOTP_SECRET || "";
  if (totpSecret) {
    return makeCheck(
      "mobile-2fa",
      "Mobile pairing 2FA",
      "pass",
      "TOTP second factor is enabled for device pairing.",
    );
  }

  return makeCheck(
    "mobile-2fa",
    "Mobile pairing 2FA",
    "pass",
    "TOTP second factor is not enabled (optional).",
  );
}

function hasEnvValue(env, names) {
  return names.some((name) => typeof env[name] === "string" && env[name].trim());
}

// Issue #670: the backend listens on loopback only unless MANA_BIND_HOST
// says otherwise (server.js's startServer), so other devices on the network
// can't drive /reply or its tools. Brackets are stripped so "[::1]" works
// the same as "::1" (server.listen wants the bare form).
const DEFAULT_BIND_HOST = "127.0.0.1";

function getBindHost(env = process.env) {
  const host = String(env.MANA_BIND_HOST || "").trim().replace(/^\[(.*)\]$/, "$1");
  return host || DEFAULT_BIND_HOST;
}

function isLoopbackBindHost(host) {
  const normalized = String(host || "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(normalized)
  );
}

// Cloudflare Tunnel (or an equivalent MANA_TUNNEL_URL) makes the backend
// reachable from the internet, not just localhost -- this is a genuine
// security-relevant heads-up, not just a "is it configured" status. A
// non-loopback MANA_BIND_HOST (#670) is the LAN equivalent.
function checkRemoteExposure(env) {
  const bindHost = getBindHost(env);
  const lanWarning = isLoopbackBindHost(bindHost)
    ? ""
    : `MANA_BIND_HOST=${bindHost} makes the backend reachable from other devices on your network. Unset it to keep Mana on this PC only.`;
  const tunnelConfigured = hasEnvValue(env, [
    "CLOUDFLARE_TUNNEL_TOKEN",
    "CLOUDFLARE_TUNNEL_ID",
    "CLOUDFLARE_TUNNEL_URL",
    "MANA_TUNNEL_URL",
  ]);

  if (!tunnelConfigured) {
    return lanWarning
      ? makeCheck("remote-exposure", "Remote exposure", "warn", lanWarning)
      : makeCheck(
          "remote-exposure",
          "Remote exposure",
          "pass",
          "No remote tunnel is configured. Mana is only reachable on localhost.",
        );
  }

  const mobileAuthConfigured =
    hasEnvValue(env, ["MOBILE_PASSCODE_HASH", "MANA_MOBILE_PASSCODE_HASH"]) &&
    hasEnvValue(env, ["MOBILE_SESSION_SECRET", "MANA_MOBILE_SESSION_SECRET"]);

  if (!mobileAuthConfigured) {
    return makeCheck(
      "remote-exposure",
      "Remote exposure",
      "fail",
      `A remote tunnel is configured but mobile passcode auth is NOT. Anyone who reaches the tunnel hostname can hit unauthenticated routes. Set MOBILE_PASSCODE_HASH and MOBILE_SESSION_SECRET, or remove the tunnel config. ${lanWarning}`.trim(),
    );
  }

  return makeCheck(
    "remote-exposure",
    "Remote exposure",
    "warn",
    `A remote tunnel is configured -- Mana's backend may be reachable from the internet through it. Mobile passcode auth is configured, but double-check docs/mobile_pwa_cloudflare.md's hardening steps. ${lanWarning}`.trim(),
  );
}

function checkStorage(paths = {}) {
  const dataDir = paths.dataDir || path.join(__dirname, "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    return makeCheck("storage", "Storage", "pass", "Local storage is writable.", {
      dataDir,
    });
  } catch (error) {
    return makeCheck("storage", "Storage", "fail", "Local storage is not writable.", {
      dataDir,
      error: error.message,
    });
  }
}

// Q18 (#645): secrets still in plain text in node-bot/.env, by name only.
// Shown here rather than as a warning on every start.
function checkPlainTextSecrets(keys) {
  if (!Array.isArray(keys)) return null;
  if (!keys.length) {
    return makeCheck("plain-text-secrets", "Secrets in .env", "pass", "No secrets are stored in plain text in node-bot/.env.");
  }
  return makeCheck(
    "plain-text-secrets",
    "Secrets in .env",
    "warn",
    `${keys.length} secret(s) in plain text in node-bot/.env: ${keys.join(", ")}. Move them to Windows Credential Manager (keyring:) or 1Password (op://), see node-bot/.env.sample.`,
    { keys },
  );
}

// Q28 (#620): the memory graph keeps every closed edge window (no cap), so
// its size is shown here rather than silently growing.
function checkMemoryGraphHistory(size) {
  if (!size) return null;
  const history = size.closed + size.archived;
  return makeCheck(
    "memory-graph-history",
    "Memory graph history",
    "pass",
    `${size.live} live associations; ${history} closed association window${history === 1 ? "" : "s"} kept as history.`,
    size,
  );
}

// #935: the Obsidian vault sync (memory-vault.js getStatus()); {} when
// MANA_VAULT_DIR isn't set.
function checkMemoryVault(vault) {
  if (!vault) return null;
  const label = "Memory vault";
  if (!vault.vaultDir) {
    return makeCheck("memory-vault", label, "pass", "Off. Set MANA_VAULT_DIR to sync memory with an Obsidian vault.");
  }
  if (vault.error) {
    return makeCheck("memory-vault", label, "warn", `${vault.vaultDir}: ${vault.error}`, vault);
  }
  if (vault.skipped?.length) {
    const files = vault.skipped.map((s) => `${s.file} (${s.reason})`).join("; ");
    return makeCheck("memory-vault", label, "warn", `${vault.vaultDir}: ${vault.notes} notes synced; skipped ${files}.`, vault);
  }
  // "polling": the file watcher is down and the 60 s sync covers for it.
  const polling = vault.mode === "polling" ? " The file watcher is down, so it checks every 60 s." : "";
  return makeCheck("memory-vault", label, "pass", `${vault.vaultDir}: writable, ${vault.notes} notes synced.${polling}`, vault);
}

// #889: which chat model llama-server is running, "(gaming model)" while
// a watched game has it swapped to MANA_GAMING_LLAMA_MODEL.
function checkChatModel(label) {
  if (!label) return null;
  return makeCheck("chat-model", "Chat model", "pass", `${label} is loaded.`);
}

function checkEditorIntegrations(options = {}) {
  const status = createEditorIntegrations({
    env: options.env || process.env,
    commandResolver: options.commandResolver,
  }).getStatus();

  return Object.entries(status.editors).map(([id, editor]) =>
    makeCheck(
      `${id}-editor`,
      id === "vscode" ? "VS Code editor" : "Zed editor",
      editor.available ? "pass" : "warn",
      editor.message,
      {
        command: editor.command,
        source: editor.source,
        defaultEditor: status.defaultEditor === id,
      },
    ),
  );
}

function checkZedExternalAgent(options = {}) {
  const env = options.env || process.env;
  const entryPoint = options.entryPoint || path.join(__dirname, "mana-acp-agent.js");

  if (!checkPathExists(entryPoint)) {
    return makeCheck(
      "zed-external-agent",
      "Zed external agent",
      "fail",
      "Mana external agent entry point is missing.",
      {
        entryPoint,
        command: `node ${entryPoint} --acp`,
      },
    );
  }

  try {
    const localAi = assertLocalAiPolicy(env, {
      allowRemoteOverride: options.allowRemoteOverride === true,
    });
    return makeCheck(
      "zed-external-agent",
      "Zed external agent",
      "pass",
      "Mana external agent entry point is available.",
      {
        entryPoint,
        command: `node ${entryPoint} --acp`,
        remoteAllowed: localAi.remoteAllowed,
        mode: localAi.mode,
      },
    );
  } catch (error) {
    return makeCheck(
      "zed-external-agent",
      "Zed external agent",
      "warn",
      error.message,
      {
        entryPoint,
        command: `node ${entryPoint} --acp`,
        remoteAllowed: true,
      },
    );
  }
}

function getZedExternalAgentBackendHealthTarget(env) {
  return withHealthPath(env.MANA_BACKEND_URL || DEFAULT_BACKEND_URL);
}

function withHealthPath(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/health";
    }
    return url.toString();
  } catch (error) {
    return "";
  }
}

function getConfiguredTtsHealthTargets(env) {
  const provider = String(env.TTS_PROVIDER || "").trim().toLowerCase();
  const targets = [];

  if ((!provider || provider === "kokoro") && env.KOKORO_TTS_URL) {
    targets.push({
      id: "kokoro",
      url: withHealthPath(env.KOKORO_TTS_URL),
    });
  }

  if ((!provider || provider === "fish") && env.FISH_TTS_URL) {
    targets.push({
      id: "fish",
      url: withHealthPath(env.FISH_TTS_URL),
    });
  }

  // The native launcher starts Qwen3-TTS whenever it's selected, so its
  // default URL is worth checking too, not only an explicit QWEN3_TTS_URL.
  if (provider === "qwen3tts") {
    targets.push({
      id: "qwen3tts",
      url: withHealthPath(env.QWEN3_TTS_URL || "http://127.0.0.1:5012"),
    });
  }

  return targets.filter((target) => target.url);
}

async function probeHttpHealth({ id, url, timeoutMs = 750 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    return {
      id,
      url,
      ok: response.ok,
      statusCode: response.status,
    };
  } catch (error) {
    return {
      id,
      url,
      ok: false,
      error: error.name === "AbortError" ? "timeout" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeTtsServices(env, services) {
  if (Array.isArray(services)) {
    return services;
  }

  const targets = getConfiguredTtsHealthTargets(env);
  return Promise.all(targets.map((target) => probeHttpHealth(target)));
}

async function probeZedExternalAgentBackend(env, probe = probeHttpHealth) {
  const url = getZedExternalAgentBackendHealthTarget(env);
  if (!url) {
    return makeCheck(
      "zed-external-agent-backend",
      "Zed external agent backend",
      "warn",
      "MANA_BACKEND_URL is not a valid URL.",
      { url: env.MANA_BACKEND_URL || "" },
    );
  }

  const result = await probe({
    id: "zed-external-agent-backend",
    url,
  });
  return makeCheck(
    "zed-external-agent-backend",
    "Zed external agent backend",
    result.ok ? "pass" : "warn",
    result.ok
      ? "Zed external agent local backend is reachable."
      : "Zed external agent local backend is not reachable. Start node-bot before using Zed External Agent.",
    result,
  );
}

async function probeSearxngHealth(env, probe = probeHttpHealth) {
  if (env.MANA_WEB_ACCESS_ENABLED === "0") {
    return makeCheck(
      "searxng",
      "Web search (SearXNG)",
      "warn",
      "Web access is disabled (MANA_WEB_ACCESS_ENABLED=0).",
      {},
    );
  }

  const url = (env.SEARXNG_URL || "http://127.0.0.1:8890").replace(/\/+$/, "") + "/";
  const result = await probe({ id: "searxng", url });
  return makeCheck(
    "searxng",
    "Web search (SearXNG)",
    result.ok ? "pass" : "warn",
    result.ok
      ? "Local SearXNG is reachable; web search is available."
      : "Local SearXNG is not reachable. Web search will fail; wiki lookups and pointed-at page reads still work. See docs/web_access_setup.md.",
    result,
  );
}

// GPT-SoVITS's api_v2.py has no /health route, so this only checks whether
// the port answers at all (see the matching launcher-side isGptSovitsRunning);
// only relevant when it's the selected trial voice provider.
async function probeGptSovitsHealth(env, probe = probeHttpHealth) {
  const url = (env.GPT_SOVITS_TTS_URL || "http://127.0.0.1:9880") + "/";
  const result = await probe({ id: "gpt-sovits", url });
  const reachable = result.ok || Number.isInteger(result.statusCode);
  return makeCheck(
    "gpt-sovits",
    "GPT-SoVITS (trial voice)",
    reachable ? "pass" : "warn",
    reachable
      ? "GPT-SoVITS is reachable."
      : "TTS_PROVIDER is gpt_sovits, but GPT-SoVITS is not reachable. See docs/gpt_sovits_setup.md.",
    { ...result, ok: reachable },
  );
}

function normalizePortNumber(value, fallback) {
  const port = Number(value || fallback);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

// No default port checks: a "is this port free" probe against node-bot's
// own configured port only makes sense *before* node-bot has started (a
// pre-flight check for something about to bind it). The only real caller
// of runDoctorChecksAsync is this same server's own /doctor route -- by
// the time anything can query it, that port is trivially always "in use"
// by the very process answering the request, so this always reported a
// false "port unavailable" warning with no actionable fix. Callers that
// genuinely need a pre-start port check can still pass one via
// options.ports.
function getDefaultPortChecks(env) {
  return [];
}

function probePortAvailability({ id = "port", host = "127.0.0.1", port, timeoutMs = 500 }) {
  return new Promise((resolve) => {
    if (!port) {
      resolve({ id, host, port, ok: false, error: "missing port" });
      return;
    }

    const socket = net.createConnection({ host, port });
    const finish = (ok, error = "") => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ id, host, port, ok, error });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(false, "port is already in use"));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") {
        finish(true);
        return;
      }
      finish(false, error.code || error.message);
    });
  });
}

async function probePorts(ports = []) {
  return Promise.all(ports.map((port) => probePortAvailability(port)));
}

function buildDoctorResult(checks, now = () => new Date()) {
  const summary = summarizeChecks(checks);
  return {
    ok: summary.fail === 0,
    generatedAt: now().toISOString(),
    summary,
    checks,
  };
}

function runDoctorChecks(options = {}) {
  const env = options.env || process.env;
  const versions = options.versions || { node: process.version };
  const paths = options.paths || {
    dataDir: env.MOBILE_MEMORY_DIR || path.join(__dirname, "data"),
  };
  const modelManagement =
    options.modelManagement || createModelManagement({ env });

  const checks = [
    checkNodeRuntime(versions.node),
    checkLocalAiPolicy(env),
    checkRequiredFile(
      "llama-binary",
      "Llama binary",
      env.LLAMA_BIN || "",
      "LLAMA_BIN is not configured. Local replies will use a placeholder.",
    ),
    checkRequiredFile(
      "llama-model",
      "Llama model",
      env.LLAMA_MODEL || "",
      "LLAMA_MODEL is not configured. Local replies will use a placeholder.",
    ),
    checkLlamaServerBinary(env, options.findLlamaServerBin),
    checkRequiredFile(
      "llama-vision-model",
      "Llama vision model",
      env.LLAMA_VISION_MODEL || "",
      "LLAMA_VISION_MODEL is not configured. Mana auto-detects vision GGUF models under tools/llama; image replies stay unavailable until one is installed. See docs/vision_setup.md.",
    ),
    checkWhisperConfig(env, options.whisperToolsDir, options.whisperLanguage),
    checkTtsServices(options.services || []),
    checkFishTtsWarmup(options.fishTtsWarmup),
    checkSessionSearchVectorIndex(options.sessionSearchVectorEnabled),
    checkPromptComposition(options.promptComposition),
    checkMcpServer(env),
    checkGpu(options.gpu !== undefined ? options.gpu : getGpu()),
    checkRecommendedModelProfile(modelManagement),
    checkVramBudgets({
      gpu: options.gpu !== undefined ? options.gpu : getGpu(),
      vramUsage: options.vramUsage !== undefined ? options.vramUsage : modelManagement.getVramUsage?.(),
      gamingWatch: options.gamingWatch,
    }),
    checkCodingSession(options.stickyCodingSession),
    checkMobileAuth(env),
    checkMobile2fa(env),
    checkRemoteExposure(env),
    checkStorage(paths),
    checkPlainTextSecrets(options.plainTextSecrets),
    checkMemoryGraphHistory(options.memoryGraphHistory),
    checkMemoryVault(options.memoryVault),
    checkChatModel(options.chatModel),
    ...checkEditorIntegrations({
      env,
      commandResolver: options.zedCommandResolver,
    }),
    checkZedExternalAgent({
      env,
      entryPoint: options.zedExternalAgentEntryPoint,
      allowRemoteOverride: options.allowRemoteOverride,
    }),
  ].filter(Boolean);

  return buildDoctorResult(checks, options.now);
}

async function runDoctorChecksAsync(options = {}) {
  const env = options.env || process.env;
  const services = await probeTtsServices(env, options.services);
  const zedExternalAgentBackend = await probeZedExternalAgentBackend(
    env,
    options.zedExternalAgentBackendProbe,
  );
  const searxngHealth = await probeSearxngHealth(env, options.searxngProbe);
  const gptSovitsHealth =
    String(env.TTS_PROVIDER || "").trim().toLowerCase() === "gpt_sovits"
      ? await probeGptSovitsHealth(env, options.gptSovitsProbe)
      : null;
  const portChecks = [...getDefaultPortChecks(env), ...(options.ports || [])];
  const portResults = await probePorts(portChecks);
  const checks = runDoctorChecks({
    ...options,
    env,
    services,
  }).checks;

  checks.push(zedExternalAgentBackend);
  checks.push(searxngHealth);
  if (gptSovitsHealth) {
    checks.push(gptSovitsHealth);
  }

  if (portResults.length) {
    const unavailable = portResults.filter((port) => !port.ok);
    checks.push(
      makeCheck(
        "ports",
        "Ports",
        unavailable.length ? "warn" : "pass",
        unavailable.length
          ? `${unavailable.length} configured port is unavailable.`
          : "Configured ports are available.",
        { ports: portResults },
      ),
    );
  }

  return buildDoctorResult(checks, options.now);
}

if (require.main === module) {
  runDoctorChecksAsync({ plainTextSecrets: require("./load-env").plainTextSecretKeys() })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}${os.EOL}`);
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`Mana doctor failed: ${error.message}${os.EOL}`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_BIND_HOST,
  buildDoctorResult,
  checkCodingSession,
  checkVramBudgets,
  getBindHost,
  isLoopbackBindHost,
  runDoctorChecks,
  runDoctorChecksAsync,
};
