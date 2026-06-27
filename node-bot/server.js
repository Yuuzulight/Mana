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
const { registerMobileRoutes } = require("./mobile-routes");
const { createMobileAuth } = require("./mobile-auth");
const { createMobileMemoryStore } = require("./mobile-memory-store");
const {
  buildMarketContextForPrompt,
  createMarketDataClient,
} = require("./market-data");

function createApp(deps = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "15mb" }));
  const upload = multer({ dest: path.join(__dirname, "tmp") });
  registerRoutes(app, upload, deps);
  return app;
}

const WHISPER_BIN = process.env.WHISPER_BIN || null;
const WHISPER_MODEL = process.env.WHISPER_MODEL || null;
const LLAMA_BIN = process.env.LLAMA_BIN || null;
const LLAMA_MODEL = process.env.LLAMA_MODEL || null;

// Remote AI is disabled by default. Set MANA_ALLOW_REMOTE_AI=1 with
// OPENAI_API_KEY only when you intentionally want paid/proxy chat replies.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const MANA_ALLOW_REMOTE_AI = process.env.MANA_ALLOW_REMOTE_AI || "";
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://new.aicode.us.com";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "codex-gpt-5.5";
const TTS_BIN = process.env.TTS_BIN || null;
const TTS_MODEL = process.env.TTS_MODEL || null;
const TTS_ARGS_JSON = process.env.TTS_ARGS_JSON || null;
const TTS_VOICE = process.env.TTS_VOICE || null;
const TTS_SPEAKER = process.env.TTS_SPEAKER || null;
const CHATTERBOX_TTS_URL =
  process.env.CHATTERBOX_TTS_URL || "http://127.0.0.1:5010";
const KOKORO_TTS_URL = process.env.KOKORO_TTS_URL || "http://127.0.0.1:5011";
const UNIVERSALIS_API_URL =
  process.env.UNIVERSALIS_API_URL || "https://universalis.app/api/v2";
const UNIVERSALIS_DEFAULT_WORLD =
  process.env.UNIVERSALIS_DEFAULT_WORLD || "Adamantoise";
const UNIVERSALIS_CACHE_MS = Number(process.env.UNIVERSALIS_CACHE_MS || 60000);
const MARKET_PROVIDER = process.env.MARKET_PROVIDER || "alphavantage";
const XIVAPI_SEARCH_URL =
  process.env.XIVAPI_SEARCH_URL || "https://v2.xivapi.com/api/search";
const XIVAPI_SHEET_URL =
  process.env.XIVAPI_SHEET_URL || "https://v2.xivapi.com/api/sheet";
const XIVAPI_RECIPE_SCAN_LIMIT = Number(
  process.env.XIVAPI_RECIPE_SCAN_LIMIT || 500,
);
const XIVAPI_RECIPE_PAGE_SIZE = Number(
  process.env.XIVAPI_RECIPE_PAGE_SIZE || 100,
);
const FFXIV_PROFIT_TOP_LIMIT = Number(process.env.FFXIV_PROFIT_TOP_LIMIT || 10);
const FFXIV_RECIPE_SOURCE = process.env.FFXIV_RECIPE_SOURCE || "garland";
const GARLAND_TOOLS_BASE_URL =
  process.env.GARLAND_TOOLS_BASE_URL || "https://www.garlandtools.org";
const FISH_TTS_URL = process.env.FISH_TTS_URL || "http://127.0.0.1:8080";
const FISH_TTS_API_KEY = process.env.FISH_TTS_API_KEY || null;
const FISH_TTS_REFERENCE_ID = process.env.FISH_TTS_REFERENCE_ID || null;
const FISH_TTS_FORMAT = process.env.FISH_TTS_FORMAT || "wav";
const FISH_TTS_LATENCY = process.env.FISH_TTS_LATENCY || "normal";
const FISH_TTS_MAX_NEW_TOKENS = Number(
  process.env.FISH_TTS_MAX_NEW_TOKENS || 1024,
);
const FISH_TTS_CHUNK_LENGTH = Number(process.env.FISH_TTS_CHUNK_LENGTH || 300);
const FISH_TTS_TOP_P = Number(process.env.FISH_TTS_TOP_P || 0.8);
const FISH_TTS_REPETITION_PENALTY = Number(
  process.env.FISH_TTS_REPETITION_PENALTY || 1.1,
);
const FISH_TTS_TEMPERATURE = Number(process.env.FISH_TTS_TEMPERATURE || 0.8);
const FISH_TTS_FALLBACK_PROVIDER =
  process.env.FISH_TTS_FALLBACK_PROVIDER || "kokoro";
const KOKORO_TTS_FALLBACK_PROVIDER =
  process.env.KOKORO_TTS_FALLBACK_PROVIDER || "none";
const SCREEN_CONTEXT_ENABLED = process.env.SCREEN_CONTEXT_ENABLED !== "0";
const SCREEN_CONTEXT_MAX_CHARS = Number(
  process.env.SCREEN_CONTEXT_MAX_CHARS || 1200,
);
const SCREEN_OCR_CACHE_PATH =
  process.env.SCREEN_OCR_CACHE_PATH || path.join(__dirname, "tmp", "tesseract");
const WHISPER_THREADS = Number(process.env.WHISPER_THREADS || 2);
const LLAMA_THREADS = Number(process.env.LLAMA_THREADS || 4);
const LLAMA_MAX_TOKENS = Number(process.env.LLAMA_MAX_TOKENS || 180);
const DEFAULT_LLAMA_MODEL = "Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M";
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
const KOKORO_MANA_VOICE = process.env.KOKORO_MANA_VOICE || "jf_nezumi";
const KOKORO_LANGUAGE_PROFILES = {
  english: { lang: "en-us", speed: 1.12 },
  chinese: { lang: "cmn", speed: 1.08 },
  japanese: { lang: "ja", speed: 1.12 },
  korean: { lang: "ko", speed: 1.08 },
  russian: { lang: "ru", speed: 1.08 },
  german: { lang: "de", speed: 1.08 },
  spanish: { lang: "es", speed: 1.1 },
  malay: { lang: "ms", speed: 1.1 },
};

function shouldUseRemoteAi({
  apiKey = OPENAI_API_KEY,
  allowRemoteAi = MANA_ALLOW_REMOTE_AI,
} = {}) {
  return Boolean(apiKey && allowRemoteAi === "1");
}
const vtubeStudio = VTUBE_STUDIO_ENABLED
  ? new VTubeStudioClient({ url: VTUBE_STUDIO_URL })
  : null;
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

if (!fs.existsSync(path.join(__dirname, "tmp"))) {
  fs.mkdirSync(path.join(__dirname, "tmp"));
}

function registerRoutes(app, upload, deps = {}) {
app.get("/health", (req, res) => {
  const llamaStatus = getLlamaStatus();
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

function makeTmpPath(prefix, ext) {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(__dirname, "tmp", `${prefix}-${unique}.${ext}`);
}

function parseTtsArgsTemplate() {
  if (!TTS_ARGS_JSON) {
    return ["-m", "{model}", "-p", "{text}", "-o", "{output}"];
  }

  let parsed;
  try {
    parsed = JSON.parse(TTS_ARGS_JSON);
  } catch (error) {
    throw new Error("TTS_ARGS_JSON must be valid JSON");
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((part) => typeof part !== "string")
  ) {
    throw new Error("TTS_ARGS_JSON must be a JSON array of strings");
  }

  return parsed;
}

function buildTtsArgs(text, outputPath) {
  if (!TTS_BIN) {
    throw new Error("TTS_BIN not configured");
  }

  const template = parseTtsArgsTemplate();
  const values = {
    "{text}": text,
    "{output}": outputPath,
    "{model}": TTS_MODEL || "",
    "{voice}": TTS_VOICE || "",
    "{speaker}": TTS_SPEAKER || "",
  };

  for (const placeholder of ["{model}", "{voice}", "{speaker}"]) {
    const needsValue = template.includes(placeholder);
    if (needsValue && !values[placeholder]) {
      throw new Error(
        `${placeholder.slice(1, -1).toUpperCase()} not configured`,
      );
    }
  }

  return template.map((part) => values[part] ?? part);
}

function runTts(text) {
  if (!text) {
    throw new Error("No text provided for synthesis");
  }

  const outputPath = makeTmpPath("tts", "wav");
  const args = buildTtsArgs(text, outputPath);
  console.log("Running TTS:", TTS_BIN, args.join(" "));

  const result = spawnSync(TTS_BIN, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error("tts stderr:", result.stderr);
    throw new Error("tts failed: " + result.stderr);
  }
  if (!fs.existsSync(outputPath)) {
    throw new Error("tts did not produce an output file");
  }

  const audio = fs.readFileSync(outputPath);
  try {
    fs.unlinkSync(outputPath);
  } catch (error) {}

  return audio;
}

function postJsonBuffer(urlString, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === "https:" ? https : http;
    const payload = Buffer.from(JSON.stringify(body), "utf8");

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buffer);
            return;
          }
          reject(
            new Error(
              `TTS service request failed (${res.statusCode}): ${buffer.toString("utf8")}`,
            ),
          );
        });
      },
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function getJson(urlString) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === "https:" ? https : http;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mana local assistant",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            reject(
              new Error(`GET ${urlString} failed (${res.statusCode}): ${text}`),
            );
            return;
          }

          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on("error", reject);
    req.end();
  });
}

const universalisCache = new Map();
const xivapiItemCache = new Map();
const xivapiRecipeCache = new Map();
const garlandItemCache = new Map();
const RECIPE_PROFIT_FIELDS =
  "ItemResult.Name,AmountResult,Ingredient[].Name,AmountIngredient,CanHq";

function extractItemIdFromText(text) {
  const itemIdMatch = String(text || "").match(
    /\b(?:item\s*id|itemid|id)\s*[:#-]?\s*(\d{1,8})\b/i,
  );
  if (itemIdMatch) {
    return Number(itemIdMatch[1]);
  }

  return null;
}

function textLooksLikeMarketQuestion(text) {
  return /\b(universalis|marketboard|market board|price|prices|listing|listings|sale|sales|gil|hover|hovered|mouse over|mouseover)\b/i.test(
    text || "",
  );
}

function textLooksLikeCraftProfitQuestion(text) {
  return (
    /\b(craft|crafted|crafting|recipe|recipes|materials?|mats?)\b/i.test(
      text || "",
    ) &&
    /\b(profit|profitable|margin|flip|gil|marketboard|market board|universalis)\b/i.test(
      text || "",
    )
  );
}

function extractTopLimitFromText(text, fallback = FFXIV_PROFIT_TOP_LIMIT) {
  const match = String(text || "").match(/\btop\s+(\d{1,2})\b/i);
  const limit = match ? Number(match[1]) : fallback;
  return clampInteger(limit, 1, 25, fallback);
}

function cleanItemNameCandidate(text) {
  return String(text || "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]+\)/g, " ")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractExplicitItemNameFromText(text) {
  const match = String(text || "").match(
    /\b(?:item|item name|name)\s*[:#-]\s*["']?([^"'\n\r]{2,80})/i,
  );
  return match ? cleanItemNameCandidate(match[1]) : "";
}

function extractHoveredItemName(screenText) {
  const blockedPatterns = [
    /\bmarket board\b/i,
    /\binventory\b/i,
    /\barmoury chest\b/i,
    /\bcharacter\b/i,
    /\bitem level\b/i,
    /\bunique\b/i,
    /\buntradable\b/i,
    /\bextractable\b/i,
    /\bprojectable\b/i,
    /\bdesynthesizable\b/i,
    /\bsells for\b/i,
    /\brepair level\b/i,
  ];
  const lines = String(screenText || "")
    .split(/\r?\n| {2,}/)
    .map(cleanItemNameCandidate)
    .filter((line) => line.length >= 3 && line.length <= 80)
    .filter((line) => /[A-Za-z]/.test(line))
    .filter((line) => !blockedPatterns.some((pattern) => pattern.test(line)));

  return lines[0] || "";
}

async function resolveFfxivItemByName(itemName) {
  const cleanName = cleanItemNameCandidate(itemName);
  if (!cleanName) {
    throw new Error("itemName is required");
  }

  const cacheKey = cleanName.toLowerCase();
  const cached = xivapiItemCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < UNIVERSALIS_CACHE_MS) {
    return cached.value;
  }

  const query = encodeURIComponent(`Name~"${cleanName.replace(/"/g, "")}"`);
  const url = `${XIVAPI_SEARCH_URL}?sheets=Item&query=${query}&fields=Name&limit=10`;
  const data = await getJson(url);
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    throw new Error(`No FFXIV item matched "${cleanName}"`);
  }

  const exact = results.find(
    (result) =>
      String(result?.fields?.Name || "").toLowerCase() ===
      cleanName.toLowerCase(),
  );
  const best = exact || results[0];
  const value = {
    itemId: best.row_id,
    name: best.fields?.Name || cleanName,
    score: best.score || null,
    matches: results.slice(0, 5).map((result) => ({
      itemId: result.row_id,
      name: result.fields?.Name || "",
      score: result.score || null,
    })),
  };

  xivapiItemCache.set(cacheKey, {
    createdAt: Date.now(),
    value,
  });
  return value;
}

async function getUniversalisMarketSummary(world, itemId, itemName = "") {
  const safeWorld = encodeURIComponent(world || UNIVERSALIS_DEFAULT_WORLD);
  const safeItemId = Number(itemId);
  if (!Number.isInteger(safeItemId) || safeItemId <= 0) {
    throw new Error("itemId must be a positive integer");
  }

  const cacheKey = `${safeWorld}:${safeItemId}`;
  const cached = universalisCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < UNIVERSALIS_CACHE_MS) {
    return cached.value;
  }

  const url = `${UNIVERSALIS_API_URL}/${safeWorld}/${safeItemId}?listings=5&entries=5`;
  const data = await getJson(url);
  const listings = Array.isArray(data.listings) ? data.listings : [];
  const recentHistory = Array.isArray(data.recentHistory)
    ? data.recentHistory
    : [];
  const lowestListings = listings.slice(0, 5).map((listing) => ({
    pricePerUnit: listing.pricePerUnit,
    quantity: listing.quantity,
    total: listing.total,
    hq: Boolean(listing.hq),
  }));
  const recentSales = recentHistory.slice(0, 5).map((sale) => ({
    pricePerUnit: sale.pricePerUnit,
    quantity: sale.quantity,
    total: sale.total,
    hq: Boolean(sale.hq),
    timestamp: sale.timestamp,
  }));

  const summary = {
    source: "Universalis",
    world: data.worldName || world || UNIVERSALIS_DEFAULT_WORLD,
    itemId: data.itemID || safeItemId,
    itemName,
    lastUploadTime: data.lastUploadTime || null,
    listingsCount: data.listingsCount || listings.length,
    unitsForSale: data.unitsForSale || 0,
    minPrice: data.minPrice || null,
    minPriceNq: data.minPriceNQ || null,
    minPriceHq: data.minPriceHQ || null,
    averagePrice: data.averagePrice || null,
    currentAveragePrice: data.currentAveragePrice || null,
    saleVelocity: data.regularSaleVelocity || null,
    lowestListings,
    recentSales,
  };

  universalisCache.set(cacheKey, {
    createdAt: Date.now(),
    value: summary,
  });
  return summary;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, number));
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(values[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function getXivapiRefName(ref) {
  return typeof ref?.fields?.Name === "string" ? ref.fields.Name : "";
}

function getXivapiRefId(ref) {
  const id = Number(ref?.row_id || ref?.value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function normalizeRecipeRow(row) {
  const fields = row?.fields || {};
  const resultItemId = getXivapiRefId(fields.ItemResult);
  const resultItemName = getXivapiRefName(fields.ItemResult);
  const amountResult = Number(fields.AmountResult || 1);
  const amountIngredient = Array.isArray(fields.AmountIngredient)
    ? fields.AmountIngredient
    : [];
  const ingredients = (
    Array.isArray(fields.Ingredient) ? fields.Ingredient : []
  )
    .map((ingredient, index) => ({
      itemId: getXivapiRefId(ingredient),
      itemName: getXivapiRefName(ingredient),
      quantity: Number(amountIngredient[index] || 0),
    }))
    .filter(
      (ingredient) =>
        ingredient.itemId > 0 &&
        ingredient.quantity > 0 &&
        ingredient.itemName.trim(),
    );

  if (
    !resultItemId ||
    !resultItemName ||
    !amountResult ||
    ingredients.length === 0
  ) {
    return null;
  }

  return {
    recipeId: row.row_id,
    resultItemId,
    resultItemName,
    amountResult,
    canHq: Boolean(fields.CanHq),
    ingredients,
  };
}

async function getXivapiRecipeCandidates({ query = "", scanLimit, pageSize }) {
  const safeScanLimit = clampInteger(
    scanLimit,
    1,
    5000,
    XIVAPI_RECIPE_SCAN_LIMIT,
  );
  const safePageSize = clampInteger(pageSize, 1, 500, XIVAPI_RECIPE_PAGE_SIZE);
  const cleanQuery = cleanItemNameCandidate(query);
  const cacheKey = `${cleanQuery.toLowerCase() || "*"}:${safeScanLimit}:${safePageSize}`;
  const cached = xivapiRecipeCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < UNIVERSALIS_CACHE_MS) {
    return cached.value;
  }

  const recipes = [];
  if (cleanQuery) {
    const encodedQuery = encodeURIComponent(
      `ItemResult.Name~"${cleanQuery.replace(/"/g, "")}"`,
    );
    const url = `${XIVAPI_SEARCH_URL}?sheets=Recipe&query=${encodedQuery}&fields=${encodeURIComponent(RECIPE_PROFIT_FIELDS)}&limit=${safeScanLimit}`;
    const data = await getJson(url);
    const results = Array.isArray(data.results) ? data.results : [];
    recipes.push(...results.map(normalizeRecipeRow).filter(Boolean));
  } else {
    let after = 0;
    while (recipes.length < safeScanLimit) {
      const limit = Math.min(safePageSize, safeScanLimit - recipes.length);
      const url = `${XIVAPI_SHEET_URL}/Recipe?fields=${encodeURIComponent(RECIPE_PROFIT_FIELDS)}&limit=${limit}&after=${after}`;
      const data = await getJson(url);
      const rows = Array.isArray(data.rows) ? data.rows : [];
      if (rows.length === 0) {
        break;
      }

      recipes.push(...rows.map(normalizeRecipeRow).filter(Boolean));
      after = Number(rows[rows.length - 1]?.row_id || after);
      if (!after) {
        break;
      }
    }
  }

  const value = recipes.slice(0, safeScanLimit);
  xivapiRecipeCache.set(cacheKey, {
    createdAt: Date.now(),
    value,
  });
  return value;
}

function normalizeRecipeSource(source) {
  const normalized = String(
    source || FFXIV_RECIPE_SOURCE || "garland",
  ).toLowerCase();
  return normalized === "xivapi" ? "xivapi" : "garland";
}

async function getGarlandItemDoc(itemId) {
  const safeItemId = Number(itemId);
  if (!Number.isInteger(safeItemId) || safeItemId <= 0) {
    throw new Error("Garland item id must be a positive integer");
  }

  const cacheKey = String(safeItemId);
  const cached = garlandItemCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < UNIVERSALIS_CACHE_MS) {
    return cached.value;
  }

  const url = `${GARLAND_TOOLS_BASE_URL}/db/doc/item/en/3/${safeItemId}.json`;
  const data = await getJson(url);
  garlandItemCache.set(cacheKey, {
    createdAt: Date.now(),
    value: data,
  });
  return data;
}

function buildGarlandItemNameMap(doc) {
  const names = new Map();
  if (doc?.item?.id && doc?.item?.name) {
    names.set(Number(doc.item.id), doc.item.name);
  }

  for (const item of Array.isArray(doc?.ingredients) ? doc.ingredients : []) {
    if (item?.id && item?.name) {
      names.set(Number(item.id), item.name);
    }
  }

  for (const partial of Array.isArray(doc?.partials) ? doc.partials : []) {
    if (partial?.type === "item" && partial?.obj?.i && partial?.obj?.n) {
      names.set(Number(partial.obj.i), partial.obj.n);
    }
  }
  return names;
}

function normalizeGarlandRecipeDoc(doc) {
  const resultItemId = Number(doc?.item?.id || 0);
  const resultItemName = doc?.item?.name || "";
  const nameMap = buildGarlandItemNameMap(doc);
  return (Array.isArray(doc?.item?.craft) ? doc.item.craft : [])
    .map((craft) => {
      const ingredients = (
        Array.isArray(craft.ingredients) ? craft.ingredients : []
      )
        .map((ingredient) => ({
          itemId: Number(ingredient.id || 0),
          itemName:
            nameMap.get(Number(ingredient.id || 0)) ||
            `item ID ${ingredient.id}`,
          quantity: Number(ingredient.amount || 0),
        }))
        .filter(
          (ingredient) => ingredient.itemId > 0 && ingredient.quantity > 0,
        );

      if (!resultItemId || !resultItemName || ingredients.length === 0) {
        return null;
      }

      return {
        recipeId: craft.id,
        resultItemId,
        resultItemName,
        amountResult: Number(craft.yield || 1),
        canHq: Boolean(craft.hq),
        recipeLevel: craft.lvl || null,
        recipeSource: "garland",
        ingredients,
      };
    })
    .filter(Boolean);
}

async function searchGarlandCraftableItemIds(query, scanLimit) {
  const cleanQuery = cleanItemNameCandidate(query);
  if (!cleanQuery) {
    return [];
  }

  const url = `${GARLAND_TOOLS_BASE_URL}/api/search.php?text=${encodeURIComponent(cleanQuery)}&lang=en`;
  const data = await getJson(url);
  const values = Array.isArray(data?.value) ? data.value : [];
  return values
    .filter((entry) => entry?.type === "item" && Array.isArray(entry?.obj?.f))
    .map((entry) => Number(entry.id || entry.obj?.i || 0))
    .filter((itemId) => Number.isInteger(itemId) && itemId > 0)
    .slice(0, scanLimit);
}

async function getGarlandRecipeCandidates({ query = "", scanLimit, pageSize }) {
  const safeScanLimit = clampInteger(
    scanLimit,
    1,
    5000,
    XIVAPI_RECIPE_SCAN_LIMIT,
  );
  let itemIds = await searchGarlandCraftableItemIds(query, safeScanLimit);
  if (itemIds.length === 0) {
    const xivapiCandidates = await getXivapiRecipeCandidates({
      query,
      scanLimit: safeScanLimit,
      pageSize,
    });
    itemIds = xivapiCandidates.map((recipe) => recipe.resultItemId);
  }

  const uniqueItemIds = [...new Set(itemIds)].slice(0, safeScanLimit);
  const docs = await mapWithConcurrency(uniqueItemIds, 6, async (itemId) => {
    try {
      return await getGarlandItemDoc(itemId);
    } catch (error) {
      console.warn(`Garland item ${itemId} lookup failed: ${error}`);
      return null;
    }
  });

  return docs
    .filter(Boolean)
    .flatMap(normalizeGarlandRecipeDoc)
    .slice(0, safeScanLimit);
}

function summarizeUniversalisRawItem(rawItem, fallbackWorld, fallbackItemId) {
  const itemId = Number(rawItem?.itemID || fallbackItemId);
  const minPrice = Number(rawItem?.minPrice || 0);
  const minPriceNq = Number(rawItem?.minPriceNQ || 0);
  const minPriceHq = Number(rawItem?.minPriceHQ || 0);
  const currentAveragePrice = Number(rawItem?.currentAveragePrice || 0);
  const averagePrice = Number(rawItem?.averagePrice || 0);
  const listingsCount = Number(rawItem?.listingsCount || 0);
  return {
    itemId,
    world: rawItem?.worldName || fallbackWorld || UNIVERSALIS_DEFAULT_WORLD,
    minPrice: minPrice > 0 ? minPrice : null,
    minPriceNq: minPriceNq > 0 ? minPriceNq : null,
    minPriceHq: minPriceHq > 0 ? minPriceHq : null,
    currentAveragePrice: currentAveragePrice > 0 ? currentAveragePrice : null,
    averagePrice: averagePrice > 0 ? averagePrice : null,
    listingsCount,
    unitsForSale: rawItem?.unitsForSale || 0,
    lastUploadTime: rawItem?.lastUploadTime || null,
    hasData: Boolean(rawItem?.hasData || minPrice > 0 || listingsCount > 0),
  };
}

async function getUniversalisMarketItems(world, itemIds) {
  const safeWorld = encodeURIComponent(world || UNIVERSALIS_DEFAULT_WORLD);
  const uniqueIds = [
    ...new Set(
      itemIds.map(Number).filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  const summaries = new Map();
  const missingIds = [];

  for (const itemId of uniqueIds) {
    const cacheKey = `${safeWorld}:raw:${itemId}`;
    const cached = universalisCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < UNIVERSALIS_CACHE_MS) {
      summaries.set(itemId, cached.value);
    } else {
      missingIds.push(itemId);
    }
  }

  for (const chunk of chunkArray(missingIds, 100)) {
    const url = `${UNIVERSALIS_API_URL}/${safeWorld}/${chunk.join(",")}?listings=0&entries=0`;
    const data = await getJson(url);
    const rawItems =
      data?.items && typeof data.items === "object"
        ? data.items
        : { [String(chunk[0])]: data };

    for (const itemId of chunk) {
      const summary = summarizeUniversalisRawItem(
        rawItems[String(itemId)] || {},
        data.worldName || world,
        itemId,
      );
      const cacheKey = `${safeWorld}:raw:${itemId}`;
      universalisCache.set(cacheKey, {
        createdAt: Date.now(),
        value: summary,
      });
      summaries.set(itemId, summary);
    }
  }

  return summaries;
}

function getMarketComparisonPrice(summary) {
  return summary?.minPrice || null;
}

async function findProfitableCrafts({
  world = UNIVERSALIS_DEFAULT_WORLD,
  query = "",
  limit = FFXIV_PROFIT_TOP_LIMIT,
  scanLimit = XIVAPI_RECIPE_SCAN_LIMIT,
  pageSize = XIVAPI_RECIPE_PAGE_SIZE,
  recipeSource = FFXIV_RECIPE_SOURCE,
} = {}) {
  const safeLimit = clampInteger(limit, 1, 25, FFXIV_PROFIT_TOP_LIMIT);
  const safeScanLimit = clampInteger(
    scanLimit,
    1,
    5000,
    XIVAPI_RECIPE_SCAN_LIMIT,
  );
  const safeRecipeSource = normalizeRecipeSource(recipeSource);
  const recipes =
    safeRecipeSource === "garland"
      ? await getGarlandRecipeCandidates({
          query,
          scanLimit: safeScanLimit,
          pageSize,
        })
      : await getXivapiRecipeCandidates({
          query,
          scanLimit: safeScanLimit,
          pageSize,
        });

  const itemIds = [];
  for (const recipe of recipes) {
    itemIds.push(recipe.resultItemId);
    for (const ingredient of recipe.ingredients) {
      itemIds.push(ingredient.itemId);
    }
  }

  const marketItems = await getUniversalisMarketItems(world, itemIds);
  const skipped = {
    missingResultPrice: 0,
    missingMaterialPrice: 0,
  };
  const bestByResultItem = new Map();

  for (const recipe of recipes) {
    const resultMarket = marketItems.get(recipe.resultItemId);
    const resultUnitPrice = getMarketComparisonPrice(resultMarket);
    if (!resultUnitPrice) {
      skipped.missingResultPrice += 1;
      continue;
    }

    const pricedIngredients = [];
    let materialCost = 0;
    let hasMissingMaterial = false;
    for (const ingredient of recipe.ingredients) {
      const materialMarket = marketItems.get(ingredient.itemId);
      const unitPrice = getMarketComparisonPrice(materialMarket);
      if (!unitPrice) {
        hasMissingMaterial = true;
        break;
      }

      const total = unitPrice * ingredient.quantity;
      materialCost += total;
      pricedIngredients.push({
        ...ingredient,
        unitPrice,
        total,
      });
    }

    if (hasMissingMaterial) {
      skipped.missingMaterialPrice += 1;
      continue;
    }

    const resultRevenue = resultUnitPrice * recipe.amountResult;
    const profit = resultRevenue - materialCost;
    const profitMargin = materialCost > 0 ? profit / materialCost : null;
    const candidate = {
      recipeId: recipe.recipeId,
      itemId: recipe.resultItemId,
      itemName: recipe.resultItemName,
      world: resultMarket?.world || world || UNIVERSALIS_DEFAULT_WORLD,
      amountResult: recipe.amountResult,
      canHq: recipe.canHq,
      saleUnitPrice: resultUnitPrice,
      saleRevenue: resultRevenue,
      materialCost,
      profit,
      profitMargin,
      ingredients: pricedIngredients,
      resultMarket: {
        minPrice: resultMarket?.minPrice ?? null,
        minPriceNq: resultMarket?.minPriceNq ?? null,
        minPriceHq: resultMarket?.minPriceHq ?? null,
        currentAveragePrice: resultMarket?.currentAveragePrice ?? null,
        listingsCount: resultMarket?.listingsCount ?? 0,
        unitsForSale: resultMarket?.unitsForSale ?? 0,
        lastUploadTime: resultMarket?.lastUploadTime ?? null,
      },
    };

    const existing = bestByResultItem.get(recipe.resultItemId);
    if (!existing || candidate.profit > existing.profit) {
      bestByResultItem.set(recipe.resultItemId, candidate);
    }
  }

  const results = [...bestByResultItem.values()]
    .filter((result) => result.profit > 0)
    .sort((left, right) => right.profit - left.profit)
    .slice(0, safeLimit);

  return {
    source: `${safeRecipeSource === "garland" ? "Garland Tools" : "XIVAPI"} + Universalis`,
    recipeSource: safeRecipeSource,
    world: world || UNIVERSALIS_DEFAULT_WORLD,
    query: cleanItemNameCandidate(query) || null,
    limit: safeLimit,
    scanLimit: safeScanLimit,
    recipesScanned: recipes.length,
    recipesPriced: bestByResultItem.size,
    skipped,
    priceBasis:
      "Lowest current Universalis listing price. Revenue is item price multiplied by recipe yield.",
    results,
  };
}

function formatProfitableCraftsForPrompt(report) {
  const lines = [
    "FFXIV crafting profit scan:",
    `World: ${report.world}`,
    `Recipes scanned: ${report.recipesScanned}`,
    `Price basis: ${report.priceBasis}`,
  ];

  if (!report.results.length) {
    lines.push(
      "No profitable fully priced crafts were found in the scanned recipes.",
    );
  } else {
    lines.push("Top profitable crafts:");
    for (const [index, item] of report.results.entries()) {
      const margin =
        item.profitMargin === null
          ? "unknown margin"
          : `${Math.round(item.profitMargin * 100)}% margin`;
      lines.push(
        `${index + 1}. ${item.itemName}: ${item.profit} gil profit (${item.saleRevenue} revenue - ${item.materialCost} mats, ${margin})`,
      );
    }
  }

  lines.push(
    "Answer with the ranked item names, profit, sale revenue, material cost, and world. Mention that prices are current listings and can move.",
  );
  return lines.join("\n");
}

async function buildCraftProfitContextForPrompt(text, requestedWorld) {
  if (!textLooksLikeCraftProfitQuestion(text)) {
    return "";
  }

  const limit = extractTopLimitFromText(text);
  const startedAt = nowMs();
  const report = await findProfitableCrafts({
    world: requestedWorld || UNIVERSALIS_DEFAULT_WORLD,
    limit,
  });
  logPerf("ffxiv-crafting-profit", startedAt);
  return formatProfitableCraftsForPrompt(report);
}

async function buildUniversalisContextForPrompt(
  text,
  requestedWorld,
  screenText = "",
) {
  if (!textLooksLikeMarketQuestion(text)) {
    return "";
  }

  let itemId = extractItemIdFromText(text);
  let itemName = extractExplicitItemNameFromText(text);
  if (
    !itemId &&
    !itemName &&
    /\b(hover|hovered|mouse over|mouseover|this item)\b/i.test(text || "")
  ) {
    itemName = extractHoveredItemName(screenText);
  }

  if (!itemId && itemName) {
    const resolvedItem = await resolveFfxivItemByName(itemName);
    itemId = resolvedItem.itemId;
    itemName = resolvedItem.name;
  }

  if (!itemId) {
    return "";
  }

  const startedAt = nowMs();
  const summary = await getUniversalisMarketSummary(
    requestedWorld || UNIVERSALIS_DEFAULT_WORLD,
    itemId,
    itemName,
  );
  logPerf("universalis", startedAt);
  const listingLines = summary.lowestListings
    .slice(0, 3)
    .map((listing, index) => {
      const quality = listing.hq ? "HQ" : "NQ";
      return `${index + 1}. ${listing.pricePerUnit} gil each (${quality}), stack ${listing.quantity}, total ${listing.total} gil`;
    });
  const saleLines = summary.recentSales.slice(0, 3).map((sale, index) => {
    const quality = sale.hq ? "HQ" : "NQ";
    return `${index + 1}. ${sale.pricePerUnit} gil each (${quality}), quantity ${sale.quantity}`;
  });

  return [
    "Universalis market data:",
    `World: ${summary.world}`,
    `Item: ${summary.itemName || "item ID " + summary.itemId}`,
    `Item ID: ${summary.itemId}`,
    `Lowest NQ: ${summary.minPriceNq ?? "unknown"} gil`,
    `Lowest HQ: ${summary.minPriceHq ?? "unknown"} gil`,
    `Average sale price: ${summary.averagePrice ?? "unknown"} gil`,
    `Current average listing price: ${summary.currentAveragePrice ?? "unknown"} gil`,
    `Units for sale: ${summary.unitsForSale}`,
    "Lowest listings:",
    ...(listingLines.length ? listingLines : ["No current listings found."]),
    "Recent sales:",
    ...(saleLines.length ? saleLines : ["No recent sales found."]),
    "",
    "The user is asking for marketboard price, not item description. Answer with the resolved item name and the lowest NQ/HQ prices first. Keep it concise.",
  ].join("\n");
}

function buildFishTtsRequest(text) {
  const request = {
    text,
    format: FISH_TTS_FORMAT,
    latency: FISH_TTS_LATENCY,
    max_new_tokens: FISH_TTS_MAX_NEW_TOKENS,
    chunk_length: FISH_TTS_CHUNK_LENGTH,
    top_p: FISH_TTS_TOP_P,
    repetition_penalty: FISH_TTS_REPETITION_PENALTY,
    temperature: FISH_TTS_TEMPERATURE,
  };

  if (FISH_TTS_REFERENCE_ID) {
    request.reference_id = FISH_TTS_REFERENCE_ID;
  }

  return request;
}

function postFishTtsBuffer(text) {
  return new Promise((resolve, reject) => {
    const url = new URL("/v1/tts", FISH_TTS_URL);
    const transport = url.protocol === "https:" ? https : http;
    const payload = Buffer.from(
      JSON.stringify(buildFishTtsRequest(text)),
      "utf8",
    );
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": payload.length,
    };

    if (FISH_TTS_API_KEY) {
      headers.Authorization = `Bearer ${FISH_TTS_API_KEY}`;
    }

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(buffer);
            return;
          }
          reject(
            new Error(
              `Fish Speech request failed (${res.statusCode}): ${buffer.toString("utf8")}`,
            ),
          );
        });
      },
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function synthesizeWithConfiguredProvider(provider, text) {
  if (provider === "fish") {
    const startedAt = nowMs();
    const audio = await postFishTtsBuffer(text);
    logPerf("tts fish", startedAt);
    return audio;
  }

  if (provider === "kokoro") {
    const startedAt = nowMs();
    const kokoroProfile = pickKokoroLanguageProfile(text);
    const audio = await postJsonBuffer(`${KOKORO_TTS_URL}/synthesize`, {
      text,
      ...kokoroProfile,
    });
    logPerf("tts kokoro", startedAt);
    return audio;
  }

  if (provider === "chatterbox") {
    const startedAt = nowMs();
    const audio = await postJsonBuffer(`${CHATTERBOX_TTS_URL}/synthesize`, {
      text,
    });
    logPerf("tts chatterbox", startedAt);
    return audio;
  }

  if (provider === "cli") {
    return runTts(text);
  }

  throw new Error(`TTS provider not configured: ${provider}`);
}

async function synthesizeReply(text) {
  if (!text) {
    throw new Error("No text provided for synthesis");
  }

  if (TTS_PROVIDER === "fish") {
    try {
      return await synthesizeWithConfiguredProvider("fish", text);
    } catch (error) {
      if (FISH_TTS_FALLBACK_PROVIDER === "none") {
        throw error;
      }

      console.warn(
        `Fish Speech TTS failed, falling back to ${FISH_TTS_FALLBACK_PROVIDER}: ${error.message}`,
      );
      return await synthesizeWithConfiguredProvider(
        FISH_TTS_FALLBACK_PROVIDER,
        text,
      );
    }
  }

  if (TTS_PROVIDER === "kokoro") {
    try {
      return await synthesizeWithConfiguredProvider("kokoro", text);
    } catch (error) {
      if (KOKORO_TTS_FALLBACK_PROVIDER === "none") {
        throw error;
      }

      console.warn(
        `Kokoro TTS failed, falling back to ${KOKORO_TTS_FALLBACK_PROVIDER}: ${error.message}`,
      );
      return await synthesizeWithConfiguredProvider(
        KOKORO_TTS_FALLBACK_PROVIDER,
        text,
      );
    }
  }

  if (TTS_PROVIDER === "chatterbox") {
    return await synthesizeWithConfiguredProvider("chatterbox", text);
  }

  if (TTS_PROVIDER === "cli") {
    return await synthesizeWithConfiguredProvider("cli", text);
  }

  throw new Error("TTS not configured");
}

function pickKokoroLanguageProfile(text) {
  const language = detectTtsLanguage(text);
  return {
    voice: KOKORO_MANA_VOICE,
    ...(KOKORO_LANGUAGE_PROFILES[language] || KOKORO_LANGUAGE_PROFILES.english),
  };
}

function detectTtsLanguage(text) {
  if (/[\u3040-\u30ff]/.test(text)) {
    return "japanese";
  }
  if (/[\u3400-\u9fff]/.test(text)) {
    return "chinese";
  }
  if (/[\uac00-\ud7af]/.test(text)) {
    return "korean";
  }
  if (/[\u0400-\u04ff]/.test(text)) {
    return "russian";
  }

  const lowerText = text.toLowerCase();
  if (
    /[äöüß]/i.test(text) ||
    /\b(ich|nicht|danke|bitte|guten|hallo)\b/.test(lowerText)
  ) {
    return "german";
  }
  if (
    /[áéíóúñ¿¡]/i.test(text) ||
    /\b(hola|gracias|por favor|buenos|quiero)\b/.test(lowerText)
  ) {
    return "spanish";
  }
  if (
    /\b(saya|awak|kamu|terima kasih|tolong|boleh|tidak|apa khabar)\b/.test(
      lowerText,
    )
  ) {
    return "malay";
  }

  return "english";
}

function parseVTubeReactions() {
  try {
    const parsed = JSON.parse(VTUBE_STUDIO_REACTIONS_JSON);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (error) {
    console.warn("VTUBE_STUDIO_REACTIONS_JSON must be a JSON object");
    return {};
  }
}

function pickVTubeReaction(text) {
  const reactions = parseVTubeReactions();
  const lowerText = text.toLowerCase();

  // Quick note: reaction keys are plain words/phrases, values are VTube Studio hotkey names.
  for (const [phrase, hotkeyName] of Object.entries(reactions)) {
    if (phrase && lowerText.includes(phrase.toLowerCase())) {
      return hotkeyName;
    }
  }

  return reactions.default || null;
}

async function triggerVTubeReactionForReply(reply) {
  if (!vtubeStudio || !reply) {
    return null;
  }

  const hotkeyName = pickVTubeReaction(reply);
  if (!hotkeyName) {
    return null;
  }

  return await vtubeStudio.triggerHotkey({ hotkeyName });
}

function queueVTubeReaction(reply) {
  if (!vtubeStudio) {
    return;
  }

  triggerVTubeReactionForReply(reply).catch((error) => {
    console.warn("VTube Studio reaction failed:", error.message);
  });
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

function collectFilesRecursively(rootDir, predicate) {
  const matches = [];

  if (!fs.existsSync(rootDir)) {
    return matches;
  }

  const pending = [rootDir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      continue;
    }

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

function findLlamaBin() {
  const candidates = [];
  if (LLAMA_BIN) {
    candidates.push(LLAMA_BIN);
  }

  const localToolDir = path.join(__dirname, "..", "tools", "llama");
  const bundledLlamaDir = path.join(
    localToolDir,
    "llama-b9436-bin-win-cuda-12.4-x64",
  );
  candidates.push(
    path.join(bundledLlamaDir, "llama-cli.exe"),
    path.join(bundledLlamaDir, "llama.exe"),
    path.join(bundledLlamaDir, "llama-completion.exe"),
    path.join(localToolDir, "llama-cli.exe"),
    path.join(localToolDir, "llama.exe"),
  );

  const validPath = candidates.find(
    (candidate) => candidate && fs.existsSync(candidate),
  );
  if (validPath) {
    return validPath;
  }

  const checked = candidates.filter(Boolean).join(", ");
  throw new Error(
    `Llama executable not found. Checked: ${checked}. Set LLAMA_BIN to a valid llama-cli.exe path.`,
  );
}

function findLlamaModel() {
  if (LLAMA_MODEL) {
    return LLAMA_MODEL;
  }

  const localToolDir = path.join(__dirname, "..", "tools", "llama");
  const localGguf = collectFilesRecursively(localToolDir, (fullPath) =>
    fullPath.toLowerCase().endsWith(".gguf"),
  )[0];

  if (localGguf) {
    return localGguf;
  }

  // Quick fallback order: env var first, local GGUF next, then a small downloadable GGUF target.
  return DEFAULT_LLAMA_MODEL;
}

function isLocalModelSpec(modelSpec) {
  if (!modelSpec) {
    return false;
  }

  if (fs.existsSync(modelSpec)) {
    return true;
  }

  const normalized = modelSpec.toLowerCase();
  return (
    normalized.endsWith(".gguf") ||
    normalized.includes("\\") ||
    /^[a-z]:/i.test(modelSpec)
  );
}

function getLlamaStatus() {
  try {
    return {
      ok: true,
      bin: findLlamaBin(),
      model: findLlamaModel(),
      message: "ready",
    };
  } catch (error) {
    return {
      ok: false,
      bin: null,
      model: LLAMA_MODEL || DEFAULT_LLAMA_MODEL,
      message: error.message,
    };
  }
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

function runLlama(prompt, maxTokens = 256) {
  if (!LLAMA_BIN || !LLAMA_MODEL) {
    console.warn(
      "LLAMA_BIN or LLAMA_MODEL not configured — returning placeholder reply",
    );
    // This keeps the voice round-trip testable even before the local model is wired up.
    return "(no model configured) I heard: " + prompt.slice(0, 200);
  }

  // Support either a local GGUF path or an HF repo-style identifier without branching elsewhere.
  let args = [];
  const looksLikeHfRepo =
    LLAMA_MODEL.indexOf("/") !== -1 && !fs.existsSync(LLAMA_MODEL);
  if (looksLikeHfRepo) {
    args = [
      "completion",
      "--hf-repo",
      LLAMA_MODEL,
      "-p",
      prompt,
      "-n",
      String(maxTokens),
      "-t",
      String(LLAMA_THREADS),
    ];
  } else {
    args = [
      "completion",
      "-m",
      LLAMA_MODEL,
      "-p",
      prompt,
      "-n",
      String(maxTokens),
      "-t",
      String(LLAMA_THREADS),
    ];
  }

  console.log("Running llama:", LLAMA_BIN, args.join(" "));
  const r = spawnSync(LLAMA_BIN, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  console.log(
    "llama exit",
    r.status,
    "stdout_len",
    r.stdout ? r.stdout.length : 0,
    "stderr_len",
    r.stderr ? r.stderr.length : 0,
  );
  if (r.status !== 0) {
    console.error("llama stderr:", r.stderr);
    throw new Error("llama failed: " + r.stderr);
  }
  // The binary usually prints the generated text to stdout after the prompt
  const out = r.stdout || "";
  // Attempt to strip the prompt echo if present
  let reply = out;
  try {
    const idx = out.indexOf("\n");
    if (idx !== -1) reply = out.slice(idx + 1);
  } catch (e) {}
  reply = reply.trim();
  return reply;
}

function runLocalAssistantReply(prompt, maxTokens = 256) {
  const startedAt = nowMs();
  let llamaBin;
  try {
    llamaBin = findLlamaBin();
  } catch (error) {
    console.warn(`${error.message} Returning placeholder reply instead.`);
    logPerf("llama placeholder", startedAt);
    return "(no local llama binary found) I heard: " + prompt.slice(0, 200);
  }

  const llamaModel = findLlamaModel();
  const systemPrompt =
    "You are Mana, a local AI assistant with an original anime little-sister personality. Your tone blends cool confidence with a soft, shy gentleness: calm, caring, lightly teasing, and protective. Use occasional playful little jabs, then help immediately. Keep the teasing affectionate, never cruel or genuinely insulting. Speak naturally for spoken conversation: short sentences, clean wording, minimal rambling, usually one or two short sentences unless the user needs more detail.";

  // Quick note: llama.cpp can load either a local GGUF file or an HF repo shorthand.
  const args = isLocalModelSpec(llamaModel)
    ? [
        "-m",
        llamaModel,
        "-sys",
        systemPrompt,
        "-p",
        prompt,
        "-n",
        String(maxTokens),
        "-t",
        String(LLAMA_THREADS),
        "--single-turn",
        "--simple-io",
        "--no-display-prompt",
        "--no-show-timings",
        "--no-perf",
        "--no-warmup",
      ]
    : [
        "-hf",
        llamaModel,
        "-sys",
        systemPrompt,
        "-p",
        prompt,
        "-n",
        String(maxTokens),
        "-t",
        String(LLAMA_THREADS),
        "--single-turn",
        "--simple-io",
        "--no-display-prompt",
        "--no-show-timings",
        "--no-perf",
        "--no-warmup",
      ];

  console.log("Running llama:", llamaBin, args.join(" "));
  const result = spawnSync(llamaBin, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    cwd: path.dirname(llamaBin),
  });
  if (result.error) {
    throw result.error;
  }

  console.log(
    "llama exit",
    result.status,
    "stdout_len",
    result.stdout ? result.stdout.length : 0,
    "stderr_len",
    result.stderr ? result.stderr.length : 0,
  );

  if (result.status !== 0) {
    console.error("llama stderr:", result.stderr);
    throw new Error("llama failed: " + result.stderr);
  }
  logPerf("llama", startedAt);

  const rawOutput = (result.stdout || "").replace(/\r/g, "").trim();
  const promptMarker = `> ${prompt}`;
  const markerIndex = rawOutput.lastIndexOf(promptMarker);
  if (markerIndex !== -1) {
    const afterPrompt = rawOutput
      .slice(markerIndex + promptMarker.length)
      .replace(/^(\s*\n)+/, "")
      .replace(/\n+Exiting\.\.\.\s*$/i, "")
      .trim();
    if (afterPrompt) {
      return afterPrompt;
    }
  }

  // Quick cleanup fallback if the CLI output format shifts a bit.
  return rawOutput.replace(/\n+Exiting\.\.\.\s*$/i, "").trim();
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
) {
  const prompt = buildScreenAwarePrompt(transcript, screenText, marketText);

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
  const reply = runLocalAssistantReply(prompt, LLAMA_MAX_TOKENS);
  queueVTubeReaction(reply);
  return reply;
}

app.post("/transcribe-only", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });

    const { tmpPath, audioPath } = normalizeUploadedAudio(req.file);
    const transcript = runWhisper(audioPath);
    cleanupUploadedAudio(tmpPath, audioPath);

    return res.json({ transcript });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/screen/read", async (req, res) => {
  try {
    const image = typeof req.body?.image === "string" ? req.body.image : "";
    if (!image) {
      return res.status(400).json({ error: "no screen image" });
    }

    const text = await readScreenText(image);
    return res.json({ text });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/market/stock/summary", async (req, res) => {
  try {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "";
    const summary = await marketDataClient.getStockSummary(symbol);
    return res.json({
      ...summary,
      disclaimer: "Market analysis only. Not financial advice.",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/market/stock/compare", async (req, res) => {
  try {
    const symbols =
      typeof req.query.symbols === "string" ? req.query.symbols : "";
    const results = await marketDataClient.compareStocks(symbols);
    return res.json({
      source: "Alpha Vantage",
      symbols: results.map((item) => item.symbol),
      results,
      disclaimer: "Market analysis only. Not financial advice.",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/market/watchlist", async (req, res) => {
  try {
    const results = await marketDataClient.getWatchlistSummary();
    return res.json({
      source: "Alpha Vantage",
      symbols: results.map((item) => item.symbol),
      results,
      disclaimer: "Market analysis only. Not financial advice.",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/ffxiv/market", async (req, res) => {
  try {
    const world =
      typeof req.query.world === "string" && req.query.world.trim()
        ? req.query.world.trim()
        : UNIVERSALIS_DEFAULT_WORLD;
    let itemName =
      typeof req.query.itemName === "string" && req.query.itemName.trim()
        ? req.query.itemName.trim()
        : "";
    let itemId = Number(req.query.itemId || req.query.itemID || req.query.id);
    let resolvedItem = null;
    if (!Number.isInteger(itemId) || itemId <= 0) {
      resolvedItem = await resolveFfxivItemByName(itemName);
      itemId = resolvedItem.itemId;
      itemName = resolvedItem.name;
    }

    const summary = await getUniversalisMarketSummary(world, itemId, itemName);
    return res.json({
      ...summary,
      resolvedItem,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/ffxiv/crafting/profit", async (req, res) => {
  try {
    const world =
      typeof req.query.world === "string" && req.query.world.trim()
        ? req.query.world.trim()
        : UNIVERSALIS_DEFAULT_WORLD;
    const query =
      typeof req.query.query === "string" && req.query.query.trim()
        ? req.query.query.trim()
        : "";
    const limit = clampInteger(req.query.limit, 1, 25, FFXIV_PROFIT_TOP_LIMIT);
    const scanLimit = clampInteger(
      req.query.scanLimit,
      1,
      5000,
      XIVAPI_RECIPE_SCAN_LIMIT,
    );
    const pageSize = clampInteger(
      req.query.pageSize,
      1,
      500,
      XIVAPI_RECIPE_PAGE_SIZE,
    );
    const recipeSource =
      typeof req.query.recipeSource === "string" &&
      req.query.recipeSource.trim()
        ? req.query.recipeSource.trim()
        : FFXIV_RECIPE_SOURCE;
    const startedAt = nowMs();
    const report = await findProfitableCrafts({
      world,
      query,
      limit,
      scanLimit,
      pageSize,
      recipeSource,
    });
    logPerf("ffxiv-crafting-profit", startedAt);
    return res.json(report);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/ffxiv/market/from-screen", async (req, res) => {
  try {
    const world =
      typeof req.body?.world === "string" && req.body.world.trim()
        ? req.body.world.trim()
        : UNIVERSALIS_DEFAULT_WORLD;
    const screenText =
      typeof req.body?.screenText === "string" ? req.body.screenText : "";
    const itemName =
      extractExplicitItemNameFromText(req.body?.text || "") ||
      extractHoveredItemName(screenText);
    if (!itemName) {
      return res
        .status(400)
        .json({ error: "Could not find an item name in the screen text" });
    }

    const resolvedItem = await resolveFfxivItemByName(itemName);
    const summary = await getUniversalisMarketSummary(
      world,
      resolvedItem.itemId,
      resolvedItem.name,
    );
    return res.json({
      ...summary,
      hoveredItemName: itemName,
      resolvedItem,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/reply", async (req, res) => {
  try {
    const transcript =
      typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!transcript) {
      return res.status(400).json({ error: "no text" });
    }

    const screenText =
      typeof req.body?.screenText === "string"
        ? clampText(req.body.screenText, SCREEN_CONTEXT_MAX_CHARS)
        : "";
    const world =
      typeof req.body?.ffxivWorld === "string" && req.body.ffxivWorld.trim()
        ? req.body.ffxivWorld.trim()
        : UNIVERSALIS_DEFAULT_WORLD;
    const craftProfitText = await buildCraftProfitContextForPrompt(
      transcript,
      world,
    );
    const marketText =
      craftProfitText ||
      (await buildUniversalisContextForPrompt(transcript, world, screenText)) ||
      (await buildMarketContextForPrompt(transcript, marketDataClient));
    const reply = await buildAssistantReply(transcript, screenText, marketText);
    return res.json({
      reply,
      ttsConfigured: TTS_PROVIDER !== "none",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    console.log("Got file upload:", req.file);
    const { tmpPath, audioPath } = normalizeUploadedAudio(req.file);

    console.log(
      "audioPath ->",
      audioPath,
      "exists=",
      fs.existsSync(audioPath),
      "size=",
      fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0,
    );
    const transcript = runWhisper(audioPath);

    const stockMarketText = await buildMarketContextForPrompt(
      transcript,
      marketDataClient,
    );
    const reply = await buildAssistantReply(transcript, "", stockMarketText);
    cleanupUploadedAudio(tmpPath, audioPath);

    return res.json({
      transcript,
      reply,
      ttsConfigured: TTS_PROVIDER !== "none",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/synthesize", async (req, res) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ error: "no text" });
    }
    if (TTS_PROVIDER === "none") {
      return res.status(400).json({ error: "TTS not configured" });
    }

    const audio = await synthesizeReply(text);
    res.setHeader("Content-Type", "audio/wav");
    return res.send(audio);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/vtube/status", async (req, res) => {
  if (!vtubeStudio) {
    return res.json({ enabled: false });
  }

  try {
    const state = await vtubeStudio.getState();
    return res.json({
      enabled: true,
      connected: true,
      authenticated: vtubeStudio.authenticated,
      url: VTUBE_STUDIO_URL,
      state,
    });
  } catch (error) {
    return res.status(503).json({
      enabled: true,
      connected: false,
      authenticated: false,
      url: VTUBE_STUDIO_URL,
      error: error.message,
    });
  }
});

app.post("/vtube/auth", async (req, res) => {
  if (!vtubeStudio) {
    return res.status(400).json({ error: "VTube Studio integration disabled" });
  }

  try {
    const result = await vtubeStudio.authenticate();
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/vtube/hotkeys", async (req, res) => {
  if (!vtubeStudio) {
    return res.status(400).json({ error: "VTube Studio integration disabled" });
  }

  try {
    const hotkeys = await vtubeStudio.listHotkeys();
    return res.json({ hotkeys });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/vtube/hotkey", async (req, res) => {
  if (!vtubeStudio) {
    return res.status(400).json({ error: "VTube Studio integration disabled" });
  }

  try {
    const hotkeyID =
      typeof req.body?.hotkeyID === "string" ? req.body.hotkeyID.trim() : "";
    const hotkeyName =
      typeof req.body?.hotkeyName === "string"
        ? req.body.hotkeyName.trim()
        : "";
    const result = await vtubeStudio.triggerHotkey({ hotkeyID, hotkeyName });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

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
    mobileMemoryStore: deps.mobileMemoryStore || createMobileMemoryStore(),
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
  shouldUseRemoteAi,
  startServer,
};
