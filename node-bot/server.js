/*
Node backend server (server.js)
- POST /transcribe : accepts multipart 'file' audio, runs whisper.cpp to transcribe, then llama.cpp to generate a reply.
- POST /synthesize : accepts JSON { text } and returns WAV audio from the configured TTS tool.
- POST /screen/read : accepts a screenshot data URL and returns local OCR text.
- GET /health : basic health check

Environment variables (set before running):
- WHISPER_BIN : full path to whisper.cpp main executable (e.g. C:\whisper.cpp\main.exe)
- WHISPER_MODEL : full path to whisper model file (e.g. models/ggml-base.en.bin)
- LLAMA_BIN : full path to llama.cpp/main executable (e.g. C:\llama.cpp\main.exe)
- LLAMA_MODEL : full path to a GGUF model file, or an HF repo shorthand like user/model:Q4_K_M
- TTS_PROVIDER : "cli", "chatterbox", "kokoro", or "fish"
- TTS_BIN : full path to your TTS executable
- TTS_MODEL : model path or model id for your TTS executable
- TTS_ARGS_JSON : optional JSON array of CLI args with placeholders like {text}, {output}, {model}, {voice}, {speaker}
- TTS_VOICE : optional voice value used by your TTS args
- TTS_SPEAKER : optional speaker value used by your TTS args
- CHATTERBOX_TTS_URL : local Chatterbox TTS microservice URL
- KOKORO_TTS_URL : local Kokoro TTS microservice URL
- FISH_TTS_URL : local Fish Speech server URL
- FISH_TTS_API_KEY : optional Fish Speech bearer token
- FISH_TTS_REFERENCE_ID : optional saved Fish Speech reference voice id
- FISH_TTS_FALLBACK_PROVIDER : "kokoro", "chatterbox", or "none"
- MANA_ALLOW_REMOTE_AI : set to "1" to allow OpenAI/proxy chat replies
- GAMING_PROCESS_NAMES : optional comma-separated game process names for Gaming mode

This server aims to avoid Python. You must download and place the whisper.cpp and llama.cpp binaries and model files yourself.
*/

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { createWorker } = require("tesseract.js");
const { VTubeStudioClient } = require("./vtube-studio-client");
const { registerVTubeRoutes } = require("./vtube-routes");
const { createVTubeRuntime } = require("./vtube-runtime");
const { registerMobileRoutes } = require("./mobile-routes");
const { createMobileAuth } = require("./mobile-auth");
const { createMobileMemoryStore } = require("./mobile-memory-store");
const { registerCoreRoutes } = require("./server-routes");
const { runDoctorChecksAsync } = require("./doctor");
const {
  buildMarketContextForPrompt,
  createMarketDataClient,
} = require("./market-data");
const { createTtsRuntime } = require("./tts-runtime");
const {
  createEditorIntegrations,
  createZedIntegration,
} = require("./zed-integration");
const {
  normalizeLlamaModelProfile,
  pickPreferredLlamaModel,
  selectLlamaModelProfileForPrompt,
  shouldUseRemoteAi,
} = require("./ai/local-ai");
const { createLocalLlamaRuntime } = require("./ai/local-llama-runtime");
const {
  FFXIV_PROFIT_TOP_LIMIT,
  FFXIV_RECIPE_SOURCE,
  XIVAPI_RECIPE_PAGE_SIZE,
  XIVAPI_RECIPE_SCAN_LIMIT,
  UNIVERSALIS_DEFAULT_WORLD,
  buildCraftProfitContextForPrompt,
  buildUniversalisContextForPrompt,
  clampInteger,
  cleanItemNameCandidate,
  configureFfxivMarketTools,
  extractExplicitItemNameFromText,
  extractHoveredItemName,
  findProfitableCrafts,
  formatCraftRankingDetails,
  getCraftMarketabilityRequirement,
  getCraftRankingValue,
  getGarlandNodeGatheringJob,
  getGarlandNodeGatheringSources,
  getSalesHistoryAdjustedPrice,
  getUniversalisMarketSummary,
  isIgnoredGatheringMaterial,
  materialPassesGatheringFilters,
  normalizeCraftRankingMode,
  normalizeGatheringJobFilter,
  normalizeGatheringSourceFilter,
  resolveFfxivItemByName,
  resolveGatherableRecipeMaterials,
  summarizeSalesHistory,
} = require("./ffxiv-market");

function createApp(deps = {}) {
  const app = express();
  const appEnv = deps.env || process.env;
  app.use(cors());
  app.use(express.json({ limit: "15mb" }));
  const upload = multer({ dest: path.join(__dirname, "tmp") });
  registerRoutes(app, upload, { ...deps, env: appEnv });
  return app;
}

const WHISPER_BIN = process.env.WHISPER_BIN || null;
const WHISPER_MODEL = process.env.WHISPER_MODEL || null;
// Remote AI is disabled by default. Set MANA_ALLOW_REMOTE_AI=1 with
// OPENAI_API_KEY only when you intentionally want paid/proxy chat replies.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const MANA_ALLOW_REMOTE_AI = process.env.MANA_ALLOW_REMOTE_AI || "";
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://new.aicode.us.com";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "codex-gpt-5.5";
const TTS_BIN = process.env.TTS_BIN || null;
const CHATTERBOX_TTS_URL =
  process.env.CHATTERBOX_TTS_URL || "http://127.0.0.1:5010";
const KOKORO_TTS_URL = process.env.KOKORO_TTS_URL || "http://127.0.0.1:5011";
const MARKET_PROVIDER = process.env.MARKET_PROVIDER || "alphavantage";
const FISH_TTS_URL = process.env.FISH_TTS_URL || "http://127.0.0.1:8080";
const SCREEN_CONTEXT_ENABLED = process.env.SCREEN_CONTEXT_ENABLED !== "0";
const SCREEN_CONTEXT_MAX_CHARS = Number(
  process.env.SCREEN_CONTEXT_MAX_CHARS || 1200,
);
const SCREEN_OCR_CACHE_PATH =
  process.env.SCREEN_OCR_CACHE_PATH || path.join(__dirname, "tmp", "tesseract");
const WHISPER_THREADS = Number(process.env.WHISPER_THREADS || 2);
const LLAMA_THREADS = Number(process.env.LLAMA_THREADS || 4);
const LLAMA_MAX_TOKENS = Number(process.env.LLAMA_MAX_TOKENS || 180);
const VTUBE_STUDIO_URL = process.env.VTUBE_STUDIO_URL || "ws://127.0.0.1:8001";
const VTUBE_STUDIO_ENABLED = process.env.VTUBE_STUDIO_ENABLED !== "0";
const VTUBE_STUDIO_REACTIONS_JSON =
  process.env.VTUBE_STUDIO_REACTIONS_JSON || "{}";
const TTS_PROVIDER =
  process.env.TTS_PROVIDER || (TTS_BIN ? "cli" : "chatterbox");
const DEFAULT_GAMING_PROCESS_NAMES = [
  "ffxiv_dx11.exe",
  "ffxiv.exe",
  "ffxivboot.exe",
  "ffxivboot64.exe",
  "ffxivlauncher.exe",
  "ffxivlauncher64.exe",
];
const GAMING_PROCESS_NAMES = parseGamingProcessNames(
  process.env.GAMING_PROCESS_NAMES,
);
const vtubeStudio = VTUBE_STUDIO_ENABLED
  ? new VTubeStudioClient({ url: VTUBE_STUDIO_URL })
  : null;
const vtubeRuntime = createVTubeRuntime({
  env: process.env,
  vtubeStudio,
  vtubeStudioUrl: VTUBE_STUDIO_URL,
});
const marketDataClient = createMarketDataClient();

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

const perfMetrics = {
  startedAt: Date.now(),
  operations: {},
};

function logPerf(label, startedAt) {
  const durationMs = nowMs() - startedAt;
  const previous = perfMetrics.operations[label] || { count: 0 };
  perfMetrics.operations[label] = {
    count: previous.count + 1,
    lastMs: durationMs,
    avgMs: Math.round(
      ((previous.avgMs || 0) * previous.count + durationMs) /
        (previous.count + 1),
    ),
    maxMs: Math.max(previous.maxMs || 0, durationMs),
    updatedAt: new Date().toISOString(),
  };
  console.log(`Mana perf: ${label} ${durationMs}ms`);
}

configureFfxivMarketTools({ nowMs, logPerf });

const localLlamaRuntime = createLocalLlamaRuntime({
  env: process.env,
  threads: LLAMA_THREADS,
  nowMs,
  logPerf,
});

const ttsRuntime = createTtsRuntime({
  env: process.env,
  baseDir: __dirname,
  nowMs,
  logPerf,
});

function clampText(text, maxChars) {
  const cleanText = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleanText.length <= maxChars) {
    return cleanText;
  }

  return `${cleanText.slice(0, maxChars).trim()}...`;
}

function parseGamingProcessNames(value) {
  if (!value) {
    return DEFAULT_GAMING_PROCESS_NAMES;
  }

  const names = value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return names.length > 0 ? names : DEFAULT_GAMING_PROCESS_NAMES;
}

function parseTasklistCsvLine(line) {
  const values = [];
  const pattern = /"([^"]*(?:""[^"]*)*)"|([^,]+)/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    values.push((match[1] || match[2] || "").replace(/""/g, '"'));
  }
  return values;
}

function getRunningProcessNames() {
  if (process.platform !== "win32") {
    return [];
  }

  const result = spawnSync("tasklist", ["/fo", "csv", "/nh"], {
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || "tasklist failed");
  }

  return (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => parseTasklistCsvLine(line)[0])
    .filter(Boolean)
    .map((name) => name.toLowerCase());
}

function getGamingStatus() {
  // Quick rundown: if one watched game process is running, Mana uses the lighter idle loop.
  const runningProcesses = getRunningProcessNames();
  const watchedNames = new Set(GAMING_PROCESS_NAMES);
  const matchedProcesses = [
    ...new Set(runningProcesses.filter((name) => watchedNames.has(name))),
  ];

  return {
    gamingAppRunning: matchedProcesses.length > 0,
    matchedProcesses,
    watchedProcesses: GAMING_PROCESS_NAMES,
  };
}

function getManaProcessSnapshot() {
  if (process.platform !== "win32") {
    return {
      totalMemoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      processes: [],
    };
  }

  const command = [
    "$items = Get-CimInstance Win32_Process |",
    "Where-Object { $_.CommandLine -match 'C:\\\\ManaAI\\\\Mana' -and $_.CommandLine -notmatch 'Get-CimInstance Win32_Process' } |",
    "Select-Object ProcessId,Name,WorkingSetSize,CommandLine;",
    "$items | ConvertTo-Json -Compress -Depth 3",
  ].join(" ");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    },
  );

  if (result.status !== 0 || !result.stdout.trim()) {
    return {
      totalMemoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      processes: [],
    };
  }

  const parsed = JSON.parse(result.stdout);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes = rows.map((row) => ({
    pid: row.ProcessId,
    name: row.Name,
    memoryMb: Math.round((row.WorkingSetSize || 0) / 1024 / 1024),
    role: getManaProcessRole(row.CommandLine || row.Name || ""),
  }));

  return {
    totalMemoryMb: processes.reduce((sum, item) => sum + item.memoryMb, 0),
    processes,
  };
}

function getManaProcessRole(commandLine) {
  const text = commandLine.toLowerCase();
  if (text.includes("kokoro_service")) return "kokoro tts";
  if (text.includes("uvicorn service:app")) return "chatterbox tts";
  if (text.includes("node-bot\\server.js")) return "backend";
  if (text.includes("nodemon")) return "dev restart";
  if (text.includes("electron")) return "launcher";
  return "helper";
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

ensureDirectory(path.join(__dirname, "tmp"));

function registerRoutes(app, upload, deps = {}) {
let editorIntegrations = deps.editors || null;
const mobileMemoryStore = deps.mobileMemoryStore || createMobileMemoryStore();
function getEditorIntegrations() {
  if (!editorIntegrations) {
    editorIntegrations = createEditorIntegrations();
  }
  return editorIntegrations;
}

app.get("/doctor", async (req, res) => {
  try {
    const doctor = deps.doctor || runDoctorChecksAsync;
    const result = await doctor();
    return res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/zed/status", (req, res) => {
  const zed = deps.zed || createZedIntegration();
  return res.json(zed.getStatus());
});

app.post("/zed/open", async (req, res) => {
  try {
    const zed = deps.zed || createZedIntegration();
    const result = await zed.open({
      targetPath: req.body?.path,
      line: req.body?.line,
      column: req.body?.column,
    });
    return res.json(result);
  } catch (error) {
    return res.status(400).json({
      opened: false,
      error: error.message,
    });
  }
});

app.get("/editors/status", (req, res) => {
  const editors = getEditorIntegrations();
  return res.json(editors.getStatus());
});

app.post("/editors/open", async (req, res) => {
  try {
    const editors = getEditorIntegrations();
    const result = await editors.open({
      editor: req.body?.editor,
      targetPath: req.body?.path,
      line: req.body?.line,
      column: req.body?.column,
    });
    return res.json(result);
  } catch (error) {
    return res.status(400).json({
      opened: false,
      error: error.message,
    });
  }
});

app.get("/editors/workspace", (req, res) => {
  const editors = getEditorIntegrations();
  return res.json({ workspace: editors.getWorkspace() });
});

app.post("/editors/workspace", (req, res) => {
  try {
    const editors = getEditorIntegrations();
    const workspace = editors.setWorkspace(req.body?.path, {
      editor: req.body?.editor,
      reason: "manual",
    });
    return res.json({ workspace });
  } catch (error) {
    return res.status(400).json({
      workspace: null,
      error: error.message,
    });
  }
});

app.get("/editors/workspace/files", (req, res) => {
  try {
    const editors = getEditorIntegrations();
    return res.json(editors.listWorkspaceFiles());
  } catch (error) {
    return res.status(400).json({
      files: [],
      error: error.message,
    });
  }
});

app.get("/editors/workspace/file", (req, res) => {
  try {
    const editors = getEditorIntegrations();
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    return res.json(editors.readWorkspaceFile(filePath));
  } catch (error) {
    return res.status(400).json({
      content: "",
      error: error.message,
    });
  }
});

app.get("/editors/workspace/proposals", (req, res) => {
  const editors = getEditorIntegrations();
  return res.json({ proposals: editors.listEditProposals() });
});

app.post("/editors/workspace/proposals", (req, res) => {
  try {
    const editors = getEditorIntegrations();
    const proposal = editors.createEditProposal({
      path: req.body?.path,
      proposedContent: req.body?.proposedContent,
      summary: req.body?.summary,
    });
    return res.json({ proposal });
  } catch (error) {
    return res.status(400).json({
      proposal: null,
      error: error.message,
    });
  }
});

app.get("/editors/workspace/proposals/:id", (req, res) => {
  try {
    const editors = getEditorIntegrations();
    return res.json({ proposal: editors.getEditProposal(req.params.id) });
  } catch (error) {
    return res.status(404).json({
      proposal: null,
      error: error.message,
    });
  }
});

app.post("/editors/workspace/proposals/:id/approve", (req, res) => {
  try {
    const editors = getEditorIntegrations();
    return res.json({ proposal: editors.approveEditProposal(req.params.id) });
  } catch (error) {
    return res.status(400).json({
      proposal: null,
      error: error.message,
    });
  }
});

function makeHealthComponent(status, configured, message, details = {}) {
  return {
    status,
    configured: Boolean(configured),
    message,
    ...details,
  };
}

function hasEnvValue(env, names) {
  return names.some((name) => typeof env[name] === "string" && env[name].trim());
}

function buildHealthComponents({
  env,
  llamaStatus,
  mobileMemoryStore,
  ttsBin,
  ttsProvider,
  whisperBin,
  whisperModel,
}) {
  const mobileAuthConfigured =
    hasEnvValue(env, ["MOBILE_PASSCODE_HASH", "MANA_MOBILE_PASSCODE_HASH"]) &&
    hasEnvValue(env, ["MOBILE_SESSION_SECRET", "MANA_MOBILE_SESSION_SECRET"]);
  const cloudflareConfigured = hasEnvValue(env, [
    "CLOUDFLARE_TUNNEL_TOKEN",
    "CLOUDFLARE_TUNNEL_ID",
    "CLOUDFLARE_TUNNEL_URL",
    "MANA_TUNNEL_URL",
  ]);
  const vtubeEnabled = env.VTUBE_STUDIO_ENABLED !== "0";
  const whisperConfigured = Boolean(whisperBin && whisperModel);
  const ttsConfigured = ttsProvider !== "none";
  const ttsStatus = !ttsConfigured
    ? "unavailable"
    : ttsProvider === "cli" && !ttsBin
      ? "degraded"
      : "configured";

  return {
    backend: makeHealthComponent("available", true, "Backend is running."),
    localLlama: makeHealthComponent(
      llamaStatus.ok ? "available" : "unavailable",
      llamaStatus.ok,
      llamaStatus.message,
      {
        model: llamaStatus.model,
        bin: llamaStatus.bin,
      },
    ),
    whisper: makeHealthComponent(
      whisperConfigured ? "available" : "unavailable",
      whisperConfigured,
      whisperConfigured ? "Whisper is configured." : "Whisper binary or model is missing.",
      {
        binConfigured: Boolean(whisperBin),
        modelConfigured: Boolean(whisperModel),
      },
    ),
    tts: makeHealthComponent(
      ttsStatus,
      ttsConfigured,
      ttsConfigured ? `TTS provider is ${ttsProvider}.` : "TTS is disabled.",
      { provider: ttsProvider },
    ),
    mobileAuth: makeHealthComponent(
      mobileAuthConfigured ? "available" : "unavailable",
      mobileAuthConfigured,
      mobileAuthConfigured ? "Mobile auth is configured." : "Mobile auth secrets are missing.",
    ),
    localMemory: makeHealthComponent(
      mobileMemoryStore?.filePath ? "available" : "degraded",
      Boolean(mobileMemoryStore?.filePath),
      mobileMemoryStore?.filePath
        ? "Local mobile memory store is available."
        : "Local mobile memory store path is unavailable.",
      {
        filePath: mobileMemoryStore?.filePath || null,
      },
    ),
    cloudflareTunnel: makeHealthComponent(
      cloudflareConfigured ? "configured" : "unavailable",
      cloudflareConfigured,
      cloudflareConfigured ? "Cloudflare Tunnel is configured." : "Cloudflare Tunnel is not configured.",
    ),
    ffxivMarket: makeHealthComponent(
      "configured",
      true,
      "FFXIV market providers are configured from local defaults.",
      {
        universalisConfigured: true,
        xivapiConfigured: true,
      },
    ),
    vtubeStudio: makeHealthComponent(
      vtubeEnabled ? "configured" : "unavailable",
      vtubeEnabled,
      vtubeEnabled ? "VTube Studio integration is enabled." : "VTube Studio integration is disabled.",
    ),
  };
}

app.get("/health", (req, res) => {
  const env = deps.env || process.env;
  const llamaStatus = getLlamaStatus();
  const components = buildHealthComponents({
    env,
    llamaStatus,
    mobileMemoryStore,
    ttsBin: TTS_BIN,
    ttsProvider: TTS_PROVIDER,
    whisperBin: WHISPER_BIN,
    whisperModel: WHISPER_MODEL,
  });

  res.json({
    ok: true,
    ttsConfigured: TTS_PROVIDER !== "none",
    ttsProvider: TTS_PROVIDER,
    kokoroTtsUrl: KOKORO_TTS_URL,
    chatterboxTtsUrl: CHATTERBOX_TTS_URL,
    fishTtsUrl: FISH_TTS_URL,
    llamaConfigured: llamaStatus.ok,
    llamaModel: llamaStatus.model,
    llamaBin: llamaStatus.bin,
    llamaStatus: llamaStatus.message,
    remoteAiEnabled: shouldUseRemoteAi(),
    vtubeStudioConfigured: Boolean(vtubeStudio),
    vtubeStudioUrl: VTUBE_STUDIO_URL,
    marketProvider: MARKET_PROVIDER,
    marketConfigured: marketDataClient.isConfigured,
    marketWatchlist: marketDataClient.watchlist,
    components,
  });
});

app.get("/gaming/status", (req, res) => {
  try {
    return res.json({
      ok: true,
      ...getGamingStatus(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
      gamingAppRunning: false,
      matchedProcesses: [],
      watchedProcesses: GAMING_PROCESS_NAMES,
    });
  }
});

app.get("/perf/status", (req, res) => {
  try {
    const gaming = getGamingStatus();
    return res.json({
      ok: true,
      uptimeSeconds: Math.round((Date.now() - perfMetrics.startedAt) / 1000),
      config: {
        whisperThreads: WHISPER_THREADS,
        llamaThreads: LLAMA_THREADS,
        llamaMaxTokens: LLAMA_MAX_TOKENS,
        screenContextEnabled: SCREEN_CONTEXT_ENABLED,
        screenContextMaxChars: SCREEN_CONTEXT_MAX_CHARS,
        ttsProvider: TTS_PROVIDER,
      },
      gaming,
      process: getManaProcessSnapshot(),
      operations: perfMetrics.operations,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

async function synthesizeReply(text) {
  return await ttsRuntime.synthesizeReply(text);
}

function parseVTubeReactions() {
  return vtubeRuntime.parseVTubeReactions();
}

function pickVTubeReaction(text) {
  return vtubeRuntime.pickVTubeReaction(text);
}

async function triggerVTubeReactionForReply(reply) {
  return await vtubeRuntime.triggerVTubeReactionForReply(reply);
}

function queueVTubeReaction(reply) {
  return vtubeRuntime.queueVTubeReaction(reply);
}
function findWhisperBin() {
  const candidates = [];
  if (WHISPER_BIN) {
    candidates.push(WHISPER_BIN);
  }

  const localToolDir = path.join(__dirname, "..", "tools", "whisper");
  candidates.push(
    path.join(localToolDir, "Release", "whisper-cli.exe"),
    path.join(localToolDir, "whisper-cli.exe"),
    path.join(localToolDir, "main.exe"),
  );

  const validPath = candidates.find(
    (candidate) => candidate && fs.existsSync(candidate),
  );
  if (validPath) {
    return validPath;
  }

  const checked = candidates.filter(Boolean).join(", ");
  throw new Error(
    `Whisper executable not found. Checked: ${checked}. Set WHISPER_BIN to a valid whisper-cli.exe path.`,
  );
}

function findLlamaBin() {
  return localLlamaRuntime.findLlamaBin();
}

function findLlamaModel(profile = "default") {
  return localLlamaRuntime.findLlamaModel(profile);
}

function getLlamaStatus() {
  return localLlamaRuntime.getLlamaStatus();
}

function runWhisper(filePath) {
  if (!WHISPER_MODEL) {
    throw new Error("WHISPER_MODEL not configured");
  }
  const whisperBin = findWhisperBin();
  const startedAt = nowMs();
  // I ask whisper-cli for JSON output so transcription parsing does not depend on stdout formatting.
  const outBase = filePath + ".out";
  const outJson = outBase + ".json";
  const args = [
    "-m",
    WHISPER_MODEL,
    "-f",
    filePath,
    "-t",
    String(WHISPER_THREADS),
    "--output-json",
    "-of",
    outBase,
  ];
  console.log("Running whisper:", whisperBin, args.join(" "));
  const r = spawnSync(whisperBin, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  console.log(
    "whisper exit code",
    r.status,
    "stdout_len",
    r.stdout ? r.stdout.length : 0,
    "stderr_len",
    r.stderr ? r.stderr.length : 0,
  );
  if (r.status !== 0) {
    console.error("whisper stderr:", r.stderr);
    throw new Error("whisper failed: " + r.stderr);
  }
  logPerf("whisper", startedAt);
  // Wait briefly for the JSON file to appear
  let attempts = 0;
  while (!fs.existsSync(outJson) && attempts < 5) {
    attempts += 1;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (!fs.existsSync(outJson)) {
    // fallback: try to return stdout
    const textOut = r.stdout ? r.stdout.trim() : "";
    return textOut;
  }
  try {
    const j = JSON.parse(fs.readFileSync(outJson, "utf8"));
    if (j && j.transcription && j.transcription.length > 0) {
      const t = j.transcription
        .map((s) => s.text)
        .join(" ")
        .trim();
      // cleanup json
      try {
        fs.unlinkSync(outJson);
      } catch (e) {}
      try {
        fs.unlinkSync(outBase + ".txt");
      } catch (e) {}
      return t;
    }
  } catch (e) {
    console.warn("failed to parse whisper json", e);
  }
  // fallback to stdout
  return r.stdout ? r.stdout.trim() : "";
}

function runLocalAssistantReply(prompt, maxTokens = 256, profile = "default") {
  return localLlamaRuntime.runLocalAssistantReply(prompt, maxTokens, profile);
}

function normalizeUploadedAudio(file) {
  if (!file) {
    throw new Error("no file");
  }

  const tmpPath = file.path;
  const ext = path.extname(file.originalname).toLowerCase();
  let audioPath = tmpPath;
  const wavPath = tmpPath + ".wav";

  try {
    const conv = spawnSync("ffmpeg", ["-y", "-i", tmpPath, wavPath], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    if (conv.status === 0) {
      audioPath = wavPath;
      return { tmpPath, audioPath };
    }
  } catch (error) {
    console.warn(
      "ffmpeg conversion attempt failed with error, falling back",
      error,
    );
  }

  if (ext) {
    const copyPath = tmpPath + ext;
    try {
      fs.copyFileSync(tmpPath, copyPath);
      audioPath = copyPath;
    } catch (error) {
      console.warn("could not copy file to preserve extension", error);
    }
  }

  return { tmpPath, audioPath };
}

function cleanupUploadedAudio(tmpPath, audioPath) {
  setTimeout(() => {
    try {
      fs.unlinkSync(tmpPath);
    } catch (error) {}
    try {
      if (audioPath !== tmpPath) fs.unlinkSync(audioPath);
    } catch (error) {}
  }, 10000);
}

let screenOcrWorkerPromise = null;

function getScreenOcrWorker() {
  if (!screenOcrWorkerPromise) {
    // Quick rundown: keep one OCR worker warm so screen reading is not restarted every reply.
    screenOcrWorkerPromise = createWorker("eng", 1, {
      cachePath: SCREEN_OCR_CACHE_PATH,
      errorHandler: (error) => {
        console.warn("Screen OCR worker error:", error);
      },
    }).catch((error) => {
      screenOcrWorkerPromise = null;
      throw error;
    });
  }

  return screenOcrWorkerPromise;
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || "").match(
    /^data:image\/(?:png|jpeg|jpg);base64,(.+)$/i,
  );
  if (!match) {
    throw new Error("screen image must be a PNG or JPEG data URL");
  }

  return Buffer.from(match[1], "base64");
}

async function readScreenText(imageDataUrl) {
  if (!SCREEN_CONTEXT_ENABLED) {
    return "";
  }

  const startedAt = nowMs();
  const imageBuffer = dataUrlToBuffer(imageDataUrl);
  try {
    const worker = await getScreenOcrWorker();
    const result = await worker.recognize(imageBuffer);
    logPerf("screen ocr", startedAt);
    return clampText(result?.data?.text || "", SCREEN_CONTEXT_MAX_CHARS);
  } catch (error) {
    // Quick rundown: if OCR chokes on one capture, reset it and keep Mana alive.
    screenOcrWorkerPromise = null;
    throw error;
  }
}

function buildScreenAwarePrompt(transcript, screenText, marketText = "") {
  if (!screenText && !marketText) {
    return transcript;
  }

  // Quick rundown: Mana sees this as extra context, not as something the user said.
  const parts = ["User said:", transcript];

  if (marketText) {
    parts.push("", marketText);
  }

  if (screenText) {
    parts.push("", "Visible screen text:", screenText);
  }

  parts.push("", "Answer the user using the extra context only when it helps.");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// OpenAI / proxy API inference
// ---------------------------------------------------------------------------
async function runOpenAIReply(prompt) {
  if (!shouldUseRemoteAi()) {
    return null; // no key configured; fall back to local
  }

  const systemPrompt =
    "You are Mana, a local AI assistant with an original anime little-sister personality. Your tone blends cool confidence with a soft, shy gentleness: calm, caring, lightly teasing, and protective. Use occasional playful little jabs, then help immediately. Keep the teasing affectionate, never cruel or genuinely insulting. Speak naturally for spoken conversation: short sentences, clean wording, minimal rambling, usually one or two short sentences unless the user needs more detail.";

  const baseUrl = OPENAI_BASE_URL.replace(/\/+$/, "");
  const url = new URL(baseUrl + "/v1/chat/completions");
  const transport = url.protocol === "https:" ? https : http;

  const body = JSON.stringify({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    max_tokens: LLAMA_MAX_TOKENS,
    temperature: 0.7,
  });

  return new Promise((resolve) => {
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const j = JSON.parse(raw);
          const text =
            j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || null;
          if (text) {
            resolve(text.trim());
          } else {
            console.warn(
              "OpenAI proxy returned unexpected shape:",
              raw.slice(0, 300),
            );
            resolve(null);
          }
        } catch (e) {
          console.warn("OpenAI proxy parse error:", e.message);
          resolve(null);
        }
      });
    });

    req.on("error", (e) => {
      console.warn("OpenAI proxy request error:", e.message);
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

async function buildAssistantReply(
  transcript,
  screenText = "",
  marketText = "",
  modelProfile = "default",
) {
  const prompt = buildScreenAwarePrompt(transcript, screenText, marketText);
  const normalizedModelProfile = selectLlamaModelProfileForPrompt(
    transcript,
    modelProfile,
  );

  // Try OpenAI/proxy only when explicitly allowed.
  if (shouldUseRemoteAi()) {
    try {
      const openAiReply = await runOpenAIReply(prompt);
      if (openAiReply) {
        console.log("Using OpenAI proxy reply.");
        queueVTubeReaction(openAiReply);
        return openAiReply;
      }
    } catch (e) {
      console.warn(
        "OpenAI proxy failed, falling back to local llama:",
        e.message,
      );
    }
  }

  // Fall back to local llama
  const reply = runLocalAssistantReply(
    prompt,
    LLAMA_MAX_TOKENS,
    normalizedModelProfile,
  );
  queueVTubeReaction(reply);
  return reply;
}

registerCoreRoutes(app, upload, {
  UNIVERSALIS_DEFAULT_WORLD,
  FFXIV_PROFIT_TOP_LIMIT,
  FFXIV_RECIPE_SOURCE,
  XIVAPI_RECIPE_PAGE_SIZE,
  XIVAPI_RECIPE_SCAN_LIMIT,
  TTS_PROVIDER,
  SCREEN_CONTEXT_MAX_CHARS,
  buildAssistantReply: deps.buildAssistantReply || buildAssistantReply,
  buildCraftProfitContextForPrompt:
    deps.buildCraftProfitContextForPrompt || buildCraftProfitContextForPrompt,
  buildMarketContextForPrompt:
    deps.buildMarketContextForPrompt || buildMarketContextForPrompt,
  buildUniversalisContextForPrompt:
    deps.buildUniversalisContextForPrompt || buildUniversalisContextForPrompt,
  cleanupUploadedAudio: deps.cleanupUploadedAudio || cleanupUploadedAudio,
  clampInteger,
  clampText,
  extractExplicitItemNameFromText,
  extractHoveredItemName,
  findProfitableCrafts: deps.findProfitableCrafts || findProfitableCrafts,
  fs,
  getUniversalisMarketSummary:
    deps.getUniversalisMarketSummary || getUniversalisMarketSummary,
  logPerf,
  marketDataClient,
  normalizeCraftRankingMode,
  normalizeGatheringJobFilter,
  normalizeGatheringSourceFilter,
  normalizeLlamaModelProfile,
  normalizeUploadedAudio: deps.normalizeUploadedAudio || normalizeUploadedAudio,
  nowMs,
  readScreenText: deps.readScreenText || readScreenText,
  resolveFfxivItemByName: deps.resolveFfxivItemByName || resolveFfxivItemByName,
  runWhisper: deps.runWhisper || runWhisper,
  synthesizeReply: deps.synthesizeReply || synthesizeReply,
});

registerVTubeRoutes(app, { vtubeRuntime });

  registerMobileRoutes(app, {
    mobileAuth:
      deps.mobileAuth ||
      createMobileAuth({
        passcodeHash: process.env.MOBILE_PASSCODE_HASH || "",
        sessionSecret: process.env.MOBILE_SESSION_SECRET || "",
        sessionTtlMs: Number(
          process.env.MOBILE_SESSION_TTL_MS || 12 * 60 * 60 * 1000,
        ),
      }),
    mobileMemoryStore,
    buildAssistantReply: deps.buildAssistantReply || buildAssistantReply,
    synthesizeReply: deps.synthesizeReply || synthesizeReply,
    runWhisper: deps.runWhisper || runWhisper,
    normalizeUploadedAudio:
      deps.normalizeUploadedAudio || normalizeUploadedAudio,
    cleanupUploadedAudio: deps.cleanupUploadedAudio || cleanupUploadedAudio,
    mobileUnlockRateLimiter: deps.mobileUnlockRateLimiter,
    mobileUnlockRateLimit: deps.mobileUnlockRateLimit,
  });

}

function startServer() {
  const port = process.env.PORT || 5005;
  const app = createApp();
  return app.listen(port, () => console.log("Node local bot listening on", port));
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  ensureDirectory,
  formatCraftRankingDetails,
  getCraftMarketabilityRequirement,
  getCraftRankingValue,
  getGarlandNodeGatheringJob,
  getGarlandNodeGatheringSources,
  getSalesHistoryAdjustedPrice,
  isIgnoredGatheringMaterial,
  materialPassesGatheringFilters,
  normalizeLlamaModelProfile,
  normalizeCraftRankingMode,
  normalizeGatheringSourceFilter,
  pickPreferredLlamaModel,
  resolveGatherableRecipeMaterials,
  selectLlamaModelProfileForPrompt,
  shouldUseRemoteAi,
  startServer,
  summarizeSalesHistory,
};
