/*
Node backend server (server.js)
- POST /transcribe : accepts multipart 'file' audio, runs whisper.cpp to transcribe, then llama.cpp to generate a reply.
- POST /synthesize : accepts JSON { text } and returns WAV audio from the configured TTS tool.
- POST /screen/read : accepts a screenshot data URL and returns local OCR text.
- GET /health : basic health check

Environment variables (set before running):
- WHISPER_BIN : full path to whisper.cpp main executable (e.g. C:\whisper.cpp\main.exe)
- WHISPER_MODEL : full path to whisper model file (e.g. models/ggml-base.en.bin)
- WHISPER_LANGUAGE : spoken language passed to whisper.cpp (default "en")
- WHISPER_PROMPT : initial prompt biasing transcription toward Mana's wake
  words and Singapore English/Singlish vocabulary by default
- WHISPER_BEAM_SIZE, WHISPER_NO_SPEECH_THRESHOLD, WHISPER_TEMPERATURE :
  whisper.cpp decoding tuning knobs, see docs/speech_recognition_improvement_plan.md
- LLAMA_BIN : full path to llama.cpp/main executable (e.g. C:\llama.cpp\main.exe)
- LLAMA_MODEL : full path to a GGUF model file, or an HF repo shorthand like user/model:Q4_K_M
- TTS_PROVIDER : "cli", "kokoro", or "fish" (default: "fish",
  see docs/fish_speech_tts.md for the recommended S1-mini checkpoint)
- TTS_BIN : full path to your TTS executable
- TTS_MODEL : model path or model id for your TTS executable
- TTS_ARGS_JSON : optional JSON array of CLI args with placeholders like {text}, {output}, {model}, {voice}, {speaker}
- TTS_VOICE : optional voice value used by your TTS args
- TTS_SPEAKER : optional speaker value used by your TTS args
- KOKORO_TTS_URL : local Kokoro TTS microservice URL
- FISH_TTS_URL : local Fish Speech server URL
- FISH_TTS_API_KEY : optional Fish Speech bearer token
- FISH_TTS_REFERENCE_ID : optional saved (server-side) Fish Speech reference voice id
- FISH_TTS_REF_AUDIO, FISH_TTS_REF_TEXT : optional local reference clip path
  + its exact transcript, for zero-shot in-context voice cloning on every
  request (takes priority over FISH_TTS_REFERENCE_ID when both are set)
- FISH_TTS_FALLBACK_PROVIDER : "kokoro" or "none"
- MANA_ALLOW_REMOTE_AI : set to "1" to allow OpenAI/proxy chat replies
- GAMING_PROCESS_NAMES : optional comma-separated game process names for Gaming mode
- MANA_MCP_SERVER_ENABLED : set to "1" to allow `npm run mcp` (mcp-server.js) to
  start Mana as a local Model Context Protocol server over stdio, see
  docs/roadmap/issue-42-mcp-support.md
- MANA_RESEARCH_MAX_SOURCES, MANA_RESEARCH_MAX_TOTAL_MS,
  MANA_RESEARCH_MAX_SUB_QUERIES, MANA_RESEARCH_MAX_PER_DOMAIN : persistent
  defaults for Deep Research's bounds (per-request body values still win;
  hard caps in tools/deep-research.js apply regardless)
- MANA_RESEARCH_JOB_TTL_MS : how long finished research jobs stay pollable
  before being pruned from memory (default 10 minutes)

This server aims to avoid Python. You must download and place the whisper.cpp and llama.cpp binaries and model files yourself.
*/

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("node:stream");
const http = require("http");
const https = require("https");
const { createWorker } = require("tesseract.js");
const { VTubeStudioClient } = require("./vtube-studio-client");
const { registerVTubeRoutes } = require("./vtube-routes");
const { createVTubeRuntime } = require("./vtube-runtime");
	const { registerMobileRoutes } = require("./mobile-routes");
	const { createMobileAuth } = require("./mobile-auth");
	const { createMobileMemoryStore } = require("./mobile-memory-store");
	const { registerCoreRoutes, isLocalRestartRequest } = require("./server-routes");
	const {
	  buildCapabilityHealth,
	  contributePluginPromptContext,
	  registerCapabilities,
	  isPluginEnabled,
	} = require("./capabilities/registry");
	const dirScannerCapability = require("./capabilities/dir-scanner-capability");
const {
  webAccessCapability,
} = require("./capabilities/web-access-capability");
const { sessionsCapability } = require("./capabilities/sessions-capability");
const { presetsCapability } = require("./capabilities/presets-capability");
const {
  deepResearchCapability,
} = require("./capabilities/deep-research-capability");
const {
  backgroundMemoryCapability,
} = require("./capabilities/background-memory-capability");
const {
  retrieverAdminCapability,
} = require("./capabilities/retriever-admin-capability");
const { skillsCapability } = require("./capabilities/skills-capability");
const { createSkillsStore } = require("./skills-store");
const { createApprovalGate } = require("./approval-gate");
const { createRutDetector } = require("./rut-detection");
const { createPhrasingVariator, rewritePhrase } = require("./phrasing-variation");
const { approvalGateCapability } = require("./capabilities/approval-gate-capability");
const {
  RESEARCH_SYSTEM_PROMPT,
  SUB_QUERY_SYSTEM_PROMPT,
  REFLECT_SYSTEM_PROMPT,
  COMPRESS_SYSTEM_PROMPT,
} = require("./tools/deep-research");
const { fetchPage, searchWeb, wikiLookup } = require("./tools/web-access");
const { readGgufMetadata } = require("./tools/gguf-metadata");
	const { runDoctorChecksAsync } = require("./doctor");
	const { MobileDeviceStore } = require("./mobile-device-store");
	// NOTE: mobile-auth and mobile-memory-store may exist; we add device store integration here
	const stockMarketPlugin = require("../plugins/stock-market");
	const { createMarketDataClient } = stockMarketPlugin;
	const jobApplicationsPlugin = require("../plugins/job-applications");
	const { createJobApplicationsStore } = jobApplicationsPlugin;
	const jobSearchAdzunaPlugin = require("../plugins/job-search-adzuna");
	const { createAdzunaClient } = jobSearchAdzunaPlugin;
	const documentReaderPlugin = require("../plugins/document-reader");
	const cronSchedulerPlugin = require("../plugins/cron-scheduler");
	const imageGenerationPlugin = require("../plugins/image-generation");
	const browserAutomationPlugin = require("../plugins/browser-automation");
	const telegramBridgePlugin = require("../plugins/telegram-bridge");
	const discordBotPlugin = require("../plugins/discord-bot");
	const videoWatchPlugin = require("../plugins/video-watch");
	const contextPushPlugin = require("../plugins/context-push");
const { createTtsRuntime } = require("./tts-runtime");
const { createAcpMemoryStore } = require("./acp-memory-store");
const { createSessionSearchIndex } = require("./session-search-index");
const { createSkillProposalRunner } = require("./skill-proposal");
const persona = require("./persona");
const { createPresetsStore } = require("./presets-store");
const { createPluginSettingsStore } = require("./plugin-settings-store");
const { createAuthStore } = require("./auth-store");
const { createToolPolicy } = require("./ai/tool-policy");
const { createMemoryToolSource, buildToolPolicyWithMemory } = require("./ai/memory-tool-source");
const { createSessionSearchToolSource, buildToolPolicyWithSessionSearch } = require("./ai/session-search-tool-source");
const { createSkillToolSource, buildToolPolicyWithSkillCreate } = require("./ai/skill-tool-source");
const { createMcpClientRegistry, buildToolPolicyWithMcp } = require("./mcp-client-registry");
const { mcpClientCapability } = require("./capabilities/mcp-client-capability");
const { createToolCallLog, wrapWithToolCallLog } = require("./tool-call-log");
const { toolCallLogCapability } = require("./capabilities/tool-call-log-capability");
const {
  createBrowserAutomationToolSource,
  buildToolPolicyWithBrowserAutomation,
} = require("../plugins/browser-automation/browser-automation-tool-source");
const {
  createEditorIntegrations,
  createZedIntegration,
} = require("./zed-integration");
const { createModelManagement } = require("./model-management");
const { createModelSettingsStore } = require("./model-settings-store");
const whisperDiscovery = require("./whisper-discovery");
const {
  normalizeLlamaModelProfile,
  pickPreferredLlamaModel,
  selectLlamaModelProfileForPrompt,
  shouldUseRemoteAi: shouldUseRemoteAiCore,
} = require("./ai/local-ai");
const {
  createLocalLlamaRuntime,
  cleanLlamaOutput,
} = require("./ai/local-llama-runtime");
const { createLlamaServerRuntime } = require("./ai/llama-server-runtime");
const { createRestartController } = require("./admin-restart");
const ffxivMarketPlugin = require("../plugins/ffxiv-market");
const {
  FFXIV_PROFIT_TOP_LIMIT,
  FFXIV_RECIPE_SOURCE,
  XIVAPI_RECIPE_PAGE_SIZE,
  XIVAPI_RECIPE_SCAN_LIMIT,
  UNIVERSALIS_DEFAULT_WORLD,
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
} = ffxivMarketPlugin;

function createApp(deps = {}) {
  const app = express();
  const appEnv = deps.env || process.env;
  app.use(cors());
  app.use(express.json({ limit: "15mb" }));

  // App-wide rate limit so every route (server.js, mobile-routes.js,
  // vtube-routes.js, server-routes.js -- all mounted on this same `app`)
  // gets baseline abuse protection without annotating each one. Auth-heavy
  // routes (unlock, pairing) still layer their own tighter, failure-aware
  // limiters on top of this for brute-force protection specifically.
  const isTestContext =
    process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
  app.use(
    rateLimit({
      windowMs: Number(process.env.MANA_RATE_LIMIT_WINDOW_MS || 60 * 1000),
      limit: isTestContext
        ? Number.MAX_SAFE_INTEGER
        : Number(process.env.MANA_RATE_LIMIT_MAX || 300),
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  	const upload = multer({ dest: path.join(__dirname, "tmp") });

  	  // wire mobile device store (allow override via deps for tests)
  	  const deviceStore = deps.deviceStore || new MobileDeviceStore();

  	  // register existing routes with deviceStore available in deps
  	  registerRoutes(app, upload, { ...deps, env: appEnv, deviceStore });

	  // serve small admin UI
	  app.use('/admin/mobile-devices', express.static(path.join(__dirname, 'admin')));

	  // register mobile routes on the app
	  registerMobileRoutes(app, { deviceStore });

	  return app;
}

// Remote AI is disabled by default for a genuinely external endpoint --
// set MANA_ALLOW_REMOTE_AI=1 with OPENAI_API_KEY only when you
// intentionally want paid/proxy chat replies (see shouldUseRemoteAi in
// ai/local-ai.js: a self-hosted OpenAI-compatible server on this machine
// or LAN is exempt from that gate). Settings > Brain provider (see
// /models/brain-provider below) can override base URL/key/model at
// runtime; these three getters are what every call site should use
// instead of reading process.env directly, so that override takes effect
// without a restart.
function openAiBrainOverride() {
  const brain = modelSettingsStore.getBrainSettings();
  return brain.type === "openai_compatible" ? brain : null;
}
function openAiApiKey() {
  const override = openAiBrainOverride();
  if (override && override.apiKey) return override.apiKey;
  return process.env.OPENAI_API_KEY || null;
}
function openAiBaseUrl() {
  const override = openAiBrainOverride();
  if (override && override.baseUrl) return override.baseUrl;
  return process.env.OPENAI_BASE_URL || "https://api.openai.com";
}
function openAiModel() {
  const override = openAiBrainOverride();
  if (override && override.model) return override.model;
  return process.env.OPENAI_MODEL || "codex-gpt-5.5";
}
const MANA_ALLOW_REMOTE_AI = process.env.MANA_ALLOW_REMOTE_AI || "";

// Threads the dynamic Settings-driven apiKey/baseUrl through to every
// existing shouldUseRemoteAi() call site in this file without touching
// them -- explicit overrides (as local-ai-policy.test.js passes) still
// win, since they're spread in last.
function shouldUseRemoteAi(overrides = {}) {
  return shouldUseRemoteAiCore({
    apiKey: openAiApiKey(),
    allowRemoteAi: MANA_ALLOW_REMOTE_AI,
    baseUrl: openAiBaseUrl(),
    ...overrides,
  });
}
const TTS_BIN = process.env.TTS_BIN || null;
const KOKORO_TTS_URL = process.env.KOKORO_TTS_URL || "http://127.0.0.1:5011";
const FISH_TTS_URL = process.env.FISH_TTS_URL || "http://127.0.0.1:8080";
const SCREEN_CONTEXT_ENABLED = process.env.SCREEN_CONTEXT_ENABLED !== "0";
const SCREEN_CONTEXT_MAX_CHARS = Number(
  process.env.SCREEN_CONTEXT_MAX_CHARS || 1200,
);
const SCREEN_OCR_CACHE_PATH =
  process.env.SCREEN_OCR_CACHE_PATH || path.join(__dirname, "tmp", "tesseract");
const WHISPER_THREADS = Number(process.env.WHISPER_THREADS || 2);
// Biases whisper.cpp toward Mana's wake words and Singapore English/Singlish
// vocabulary via an initial prompt, per docs/speech_recognition_improvement_plan.md.
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || "en";
const WHISPER_PROMPT =
  process.env.WHISPER_PROMPT ||
  "Singapore English conversation with an AI assistant named Mana. Wake words include Mana, Manah, Manna, Mannah, Myna, My Na, and wake up. Common Singlish words include lah, leh, lor, meh, sia, can, cannot, already, alr, ok, and okay.";
const WHISPER_BEAM_SIZE = process.env.WHISPER_BEAM_SIZE || "5";
const WHISPER_NO_SPEECH_THRESHOLD =
  process.env.WHISPER_NO_SPEECH_THRESHOLD || "0.45";
const WHISPER_TEMPERATURE = process.env.WHISPER_TEMPERATURE || "0";
const LLAMA_THREADS = Number(process.env.LLAMA_THREADS || 4);
const LLAMA_MAX_TOKENS = Number(process.env.LLAMA_MAX_TOKENS || 180);
const VTUBE_STUDIO_URL = process.env.VTUBE_STUDIO_URL || "ws://127.0.0.1:8001";
const VTUBE_STUDIO_ENABLED = process.env.VTUBE_STUDIO_ENABLED !== "0";
const VTUBE_STUDIO_REACTIONS_JSON =
  process.env.VTUBE_STUDIO_REACTIONS_JSON || "{}";
const TTS_PROVIDER =
  process.env.TTS_PROVIDER || (TTS_BIN ? "cli" : "fish");
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
const jobApplicationsStore = createJobApplicationsStore();
const adzunaClient = createAdzunaClient();

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

// Shared with modelManagement below so a model picked via /models/path (scan
// or browse, from the desktop client's Settings > Model or the onboarding
// wizard) is what llama-server actually loads next -- not just what
// /models/status reports.
const modelSettingsStore = createModelSettingsStore({});

const llamaServerRuntime = createLlamaServerRuntime({
  env: process.env,
  threads: LLAMA_THREADS,
  nowMs,
  logPerf,
  modelSettingsStore,
});

// Unified local reply helper: prefer the persistent llama-server (model loads
// once, no per-call process spawn, event loop stays free); fall back to the
// one-shot llama-cli path when the server is unavailable or fails.
async function runLocalLlamaReply(
  prompt,
  maxTokens = 256,
  profile = "default",
  overrideSystemPrompt = null,
) {
  if (llamaServerRuntime.isEnabled()) {
    try {
      return await llamaServerRuntime.runLocalAssistantReply(
        prompt,
        maxTokens,
        profile,
        overrideSystemPrompt,
      );
    } catch (e) {
      const cause =
        e && e.cause ? ` (cause: ${e.cause.code || e.cause.message || e.cause})` : "";
      console.warn(
        "llama-server reply failed, falling back to llama-cli:",
        `${e && e.message ? e.message : e}${cause}`,
      );
    }
  }
  return localLlamaRuntime.runLocalAssistantReply(
    prompt,
    maxTokens,
    profile,
    overrideSystemPrompt,
  );
}

function localLlamaReplyAvailable() {
  return (
    llamaServerRuntime.isEnabled() ||
    Boolean(localLlamaRuntime.getLlamaStatus().ok)
  );
}

// Issue #208/#211: shared compress step -- one place decides how excerpts
// get condensed, reused by both Deep Research's compress wiring below and
// retriever-index.js's search() when called from the coding-mode
// repo-retrieval block later in this file.
function compressExcerpts(prompt) {
  return runLocalLlamaReply(prompt, 1200, "quality", COMPRESS_SYSTEM_PROMPT);
}

const ttsRuntime = createTtsRuntime({
  env: process.env,
  baseDir: __dirname,
  nowMs,
  logPerf,
});

// Full-text search over past conversation turns -- an independent SQLite
// FTS5 index, not the source of truth for session content
// (acp-memory-store.js's own per-session JSON files still are).
const sessionSearchIndex = createSessionSearchIndex();

// ACP memory store (conversation/session memory)
const acpMemoryStore = createAcpMemoryStore({
  sessionSearchIndex,
  // tokenEstimator will call the local Python retriever service /tokenize endpoint when available
  tokenEstimator: async (text) => {
    try {
      const retrieverBase = (
        process.env.RETRIEVER_URL || "http://127.0.0.1:9000/retrieve"
      ).replace(/\/retrieve\/?$/, "");
      const url = retrieverBase + "/tokenize";
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: String(text || "") }),
      });
      if (resp.ok) {
        const j = await resp.json();
        if (typeof j?.tokens === "number") return j.tokens;
      }
    } catch (e) {
      // fall through to heuristic
    }
    // fallback heuristic: 1 token ≈ 4 chars
    return Math.max(1, Math.ceil(String(text || "").length / 4));
  },
  summarizeFn: async ({ sessionId, summary, turns, maxSummaryTokens }) => {
    // Build a concise summarization prompt and prefer remote AI if allowed
    try {
      const maxTokens = Math.max(32, Number(maxSummaryTokens || 128));
      const maxChars = Number(process.env.MANA_ACP_SUMMARY_MAX_CHARS || 4000);
      const recent = (turns || [])
        .slice(-5)
        .map((t) => `User: ${t.user}\nAssistant: ${t.assistant || ""}`)
        .join("\n\n");

      const prompt = `You are a concise summarization assistant. Create a compact summary (no more than ${maxTokens} tokens) of the conversation memory and recent turns for long-term storage. Keep concrete facts and user preferences. Do not include explanations; return only the summary.\n\nCURRENT SUMMARY:\n${summary || ""}\n\nRECENT TURNS:\n${recent}\n\nCONCISE SUMMARY:`;

      if (shouldUseRemoteAi()) {
        // runOpenAIReply accepts a maxTokens parameter (for the model's output)
        const res = await runOpenAIReply(prompt, Math.min(maxTokens, 512));
        return (res || "").trim().slice(0, maxChars);
      } else {
        // prefer the persistent llama-server, fall back to llama-cli; limit output tokens reasonably
        const localMax = Math.min(256, Math.max(32, maxTokens));
        const res = await runLocalLlamaReply(prompt, localMax, "default");
        return String(res || "")
          .trim()
          .slice(0, maxChars);
      }
    } catch (e) {
      console.warn("Memory summarizer failed:", e.message || e);
      return summary || "";
    }
  },
});

// Named prompt/behavior presets (see presets-store.js)
const presetsStore = createPresetsStore({});

// Procedural-memory skills store (see skills-store.js, issue #140)
const skillsStore = createSkillsStore({});

// Approval gate for agent-authored content -- skill writes today, whatever
// #142's script-runner gets wired into next (see approval-gate.js, #152).
// Executor registration happens in createApp below, against whichever
// skillsStore/approvalGate that specific call actually uses.
// Content scanning (flagging a pending request for shell/fs/credential-like
// patterns) stays off by default -- opt in once the flagged-pending UI is
// something you actually want surfaced.
const approvalGate = createApprovalGate({
  contentScanEnabled: process.env.MANA_APPROVAL_CONTENT_SCAN_ENABLED === "1",
});

// Conversational rut detection (issue #159): flags a reply too similar to
// Mana's own recent replies so it can be swapped for a less-repetitive
// Best-of-N candidate, or regenerated with a "say this differently" nudge
// on the general reply path. Env-var configurable, matching how other
// tuning knobs in this codebase work -- see rut-detection.js.
const rutDetector = createRutDetector({
  lookback: Number(process.env.MANA_RUT_LOOKBACK) || undefined,
  similarityThreshold: process.env.MANA_RUT_SIMILARITY_THRESHOLD
    ? Number(process.env.MANA_RUT_SIMILARITY_THRESHOLD)
    : undefined,
  cooldownReplies: Number(process.env.MANA_RUT_COOLDOWN_REPLIES) || undefined,
});

// Anti-formulaic-phrasing rewrite pass (issue #160): catches Mana's own
// well-worn catchphrases/openers/kaomoji recurring too often and asks the
// model for one alternate phrasing of just that part -- see
// phrasing-variation.js. A hand-curated lexicon, not learned.
const phrasingVariator = createPhrasingVariator({
  lookback: Number(process.env.MANA_PHRASING_LOOKBACK) || undefined,
});

// Which optional plugins (capabilities with a category) are enabled --
// see plugin-settings-store.js and capabilities/registry.js's gating.
const pluginSettingsStore = createPluginSettingsStore({});

// Multi-account auth with admin/user roles and API keys (see auth-store.js)
const authStore = createAuthStore({});

// Foundational tool-calling (issue #51): one read-only tool, scoped to the
// repo root by default. See ai/tool-policy.js.
const toolPolicy = createToolPolicy({});

// Outbound MCP client (issue #169): registered remote servers' tools merge
// with toolPolicy's own at reply time (see replyMaybeWithTools below), not
// into toolPolicy itself -- MCP tool discovery is async, tool-policy.js's
// tools stay a plain synchronous array. New server registrations route
// through the same approvalGate every other gated action uses.
const mcpClientRegistry = createMcpClientRegistry({ approvalGate });

// Issue #188: the shared audit/trace log every tool call gets routed
// through in replyMaybeWithTools below, regardless of source.
const toolCallLog = createToolCallLog({});

// Issue #188: browser-automation's navigate/click/type/snapshot as
// tool-calling schemas, sharing the plugin's own singleton browser session
// (see plugins/browser-automation/index.js's exported getSession) rather
// than opening a second Chromium instance.
const browserAutomationToolSource = createBrowserAutomationToolSource({
  getSession: browserAutomationPlugin.getSession,
  approvalGate,
});

// Background memory block that can be refreshed periodically from ACP session files.
let BACKGROUND_MEMORY_BLOCK = "";
let BACKGROUND_MEMORY_LOCK = false;
let BACKGROUND_MEMORY_META = { files: {} };
const BACKGROUND_META_PATH = path.join(
  __dirname,
  "data",
  "acp-memory",
  "background_meta.json",
);

function loadPersistedBackgroundMetaSync() {
  try {
    if (fs.existsSync(BACKGROUND_META_PATH)) {
      const txt = fs.readFileSync(BACKGROUND_META_PATH, "utf8") || "";
      const parsed = JSON.parse(txt || "{}") || {};
      if (parsed && parsed.files && typeof parsed.files === "object") {
        BACKGROUND_MEMORY_META = parsed;
        console.log(
          "Loaded persisted BACKGROUND_MEMORY_META (files=",
          Object.keys(BACKGROUND_MEMORY_META.files || {}).length,
          ")",
        );
      }
    }
  } catch (e) {
    console.warn(
      "Failed to load persisted background meta:",
      e && e.message ? e.message : e,
    );
  }
}

// load persisted meta synchronously at startup to avoid re-reading many files
try {
  loadPersistedBackgroundMetaSync();
} catch (e) {}

let runBackgroundReviewerPublic = null;
let runBackgroundCompactorPublic = null;
let runBackgroundConnectionsPublic = null;
let runSkillProposalPublic = null;

// Human-readable counterpart to background_meta.json's internal bookkeeping
// (issue #69) -- written whenever a compaction/review pass actually changes
// the compacted summary or important facts, whether triggered by idle
// detection or the hourly timer.
const MEMORY_MD_PATH = path.join(
  __dirname,
  "data",
  "acp-memory",
  "MEMORY.md",
);

function formatMemoryMarkdown(compacted, facts, connections = []) {
  const lines = [
    "# Mana Memory",
    "",
    `_Last updated: ${new Date().toISOString()}_`,
    "",
    "## Summary",
    "",
    compacted || "_(no summary yet)_",
  ];
  if (facts && facts.length) {
    lines.push("", "## Key Facts", "", ...facts.map((f) => `- ${f}`));
  }
  // Issue #75: kept in its own section, separate from the compacted
  // summary, so a later compaction pass can't silently merge/drop them.
  if (connections && connections.length) {
    lines.push("", "## Connections", "", ...connections.map((c) => `- ${c}`));
  }
  return lines.join("\n") + "\n";
}

function slugifyEntityName(name) {
  return (
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

// Splits Mana's memory into one Obsidian-style note per cross-session entity
// (issue #78's entity-index.json) plus a facts note and a connections note,
// instead of one flat blob -- each entity note links to every other entity
// it co-occurred with in the same session, so Obsidian's own graph view does
// the clustering. No new clustering algorithm: this is entirely a reshape of
// data Mana already computes (entity-index.json, important_facts,
// connections).
function buildMemoryNotes(entityIndex, facts, connections) {
  const notes = [];
  const entityNames = Object.keys(entityIndex || {});
  const slugFor = {};
  for (const key of entityNames) {
    slugFor[key] = slugifyEntityName(key);
  }

  for (const key of entityNames) {
    const mentions = entityIndex[key] || [];
    if (!mentions.length) continue;
    const display = mentions[mentions.length - 1].display || key;
    const sessionIds = new Set(mentions.map((m) => m.sessionId));

    const linkedKeys = entityNames.filter(
      (other) =>
        other !== key &&
        (entityIndex[other] || []).some((m) => sessionIds.has(m.sessionId)),
    );

    const body = [
      `# ${display}`,
      "",
      "## Mentioned in",
      "",
      ...mentions
        .slice()
        .reverse()
        .map((m) => `- ${m.at || "unknown time"} (session \`${m.sessionId}\`)`),
    ];
    if (linkedKeys.length) {
      body.push(
        "",
        "## Related",
        "",
        ...linkedKeys.map((k) => `- [[${slugFor[k]}]]`),
      );
    }

    notes.push({
      slug: slugFor[key],
      title: display,
      body: body.join("\n") + "\n",
      links: linkedKeys.map((k) => slugFor[k]),
    });
  }

  if (facts && facts.length) {
    const factLines = facts.map((f) => {
      const mentioned = entityNames.filter((key) =>
        String(f).toLowerCase().includes(key),
      );
      const linkSuffix = mentioned.length
        ? ` (${mentioned.map((k) => `[[${slugFor[k]}]]`).join(", ")})`
        : "";
      return `- ${f}${linkSuffix}`;
    });
    notes.push({
      slug: "key-facts",
      title: "Key Facts",
      body: ["# Key Facts", "", ...factLines].join("\n") + "\n",
      links: [],
    });
  }

  if (connections && connections.length) {
    notes.push({
      slug: "connections",
      title: "Connections",
      body:
        ["# Connections", "", ...connections.map((c) => `- ${c}`)].join("\n") +
        "\n",
      links: [],
    });
  }

  return notes;
}

async function writeMemoryMarkdown() {
  try {
    const compacted =
      (BACKGROUND_MEMORY_META.lastCompacted &&
        BACKGROUND_MEMORY_META.lastCompacted.text) ||
      "";
    const facts = BACKGROUND_MEMORY_META.important_facts || [];
    const connections = BACKGROUND_MEMORY_META.connections || [];
    await fs.promises.mkdir(path.dirname(MEMORY_MD_PATH), {
      recursive: true,
    });
    await fs.promises.writeFile(
      MEMORY_MD_PATH,
      formatMemoryMarkdown(compacted, facts, connections),
      "utf8",
    );
  } catch (e) {
    console.warn(
      "Failed to write MEMORY.md:",
      e && e.message ? e.message : e,
    );
  }
}

async function persistBackgroundMeta() {
  try {
    const dir = path.dirname(BACKGROUND_META_PATH);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = BACKGROUND_META_PATH + ".tmp";
    await fs.promises.writeFile(
      tmp,
      JSON.stringify(BACKGROUND_MEMORY_META || { files: {} }, null, 2),
      "utf8",
    );
    await fs.promises.rename(tmp, BACKGROUND_META_PATH);
  } catch (e) {
    console.warn(
      "Failed to persist background meta:",
      e && e.message ? e.message : e,
    );
  }
}

// Background-memory audit log storage/index and vector-rebuild audit
// logging now live in capabilities/background-memory-capability.js and
// capabilities/retriever-admin-capability.js respectively, alongside the
// admin routes that are their only consumers.

async function asyncLoadBackgroundMemory() {
  if (BACKGROUND_MEMORY_LOCK) return;
  BACKGROUND_MEMORY_LOCK = true;
  try {
    const sessionsDir =
      (acpMemoryStore && acpMemoryStore.sessionsDir) ||
      path.join(__dirname, "data", "acp-memory", "sessions");
    if (!fs.existsSync(sessionsDir)) {
      BACKGROUND_MEMORY_BLOCK = "";
      BACKGROUND_MEMORY_META = { files: {} };
      try {
        await persistBackgroundMeta();
      } catch (e) {}
      return { summaries: [], text: "", processed: 0, totalFiles: 0 };
    }

    const names = await fs.promises.readdir(sessionsDir);
    const jsonFiles = names.filter((f) => f.endsWith(".json"));

    // Gather stats (mtime) for files and sort by most recent
    const statPromises = jsonFiles.map(async (f) => {
      const p = path.join(sessionsDir, f);
      try {
        const st = await fs.promises.stat(p);
        return { file: f, mtime: st.mtimeMs, path: p };
      } catch (e) {
        return null;
      }
    });
    const statsAll = (await Promise.all(statPromises)).filter(Boolean);
    statsAll.sort((a, b) => b.mtime - a.mtime);

    const maxFiles = Number(
      process.env.MANA_BACKGROUND_MEMORY_MAX_FILES || 200,
    );

    const summaries = [];
    const processedFiles = [];
    let processed = 0;

    for (const s of statsAll.slice(0, maxFiles)) {
      const prev =
        BACKGROUND_MEMORY_META.files && BACKGROUND_MEMORY_META.files[s.file];
      if (prev && prev.mtime === s.mtime && prev.summary) {
        summaries.push(prev.summary);
        processedFiles.push({
          file: s.file,
          summary: prev.summary,
          mtime: prev.mtime,
        });
      } else {
        try {
          const raw = await fs.promises.readFile(s.path, "utf8");
          const obj = JSON.parse(raw || "null") || {};
          const summ =
            obj && obj.summary && typeof obj.summary === "string"
              ? String(obj.summary || "")
                  .replace(/\s+/g, " ")
                  .trim()
              : "";
          if (summ) summaries.push(summ);
          BACKGROUND_MEMORY_META.files[s.file] = {
            mtime: s.mtime,
            summary: summ,
          };
          processedFiles.push({ file: s.file, summary: summ, mtime: s.mtime });
        } catch (e) {
          // ignore malformed files and remove from meta
          if (
            BACKGROUND_MEMORY_META.files &&
            BACKGROUND_MEMORY_META.files[s.file]
          ) {
            delete BACKGROUND_MEMORY_META.files[s.file];
          }
        }
      }
      processed++;
    }

    // If no summaries collected, clear block
    if (!summaries.length) {
      BACKGROUND_MEMORY_BLOCK = "";
      try {
        await persistBackgroundMeta();
      } catch (e) {}
      return {
        summaries: [],
        text: "",
        processed,
        processedFiles: [],
        totalFiles: jsonFiles.length,
      };
    }

    // Join summaries (most recent first) and compact by max chars
    const maxChars = Number(
      process.env.MANA_BACKGROUND_MEMORY_MAX_CHARS || 2000,
    );
    let text = summaries.join("\n\n").replace(/\s+/g, " ").trim();

    if (text.length > maxChars) {
      // Simple compaction: keep as much of the start (most recent) as fits
      text = text.slice(0, maxChars).trim() + "...";
    }

    BACKGROUND_MEMORY_BLOCK = `[BACKGROUND MEMORY]\n${text}\n[END BACKGROUND MEMORY]`;
    console.log(
      `Loaded BACKGROUND_MEMORY_BLOCK (${text.length} chars) from ${processed} processed files (${jsonFiles.length} total)`,
    );
    try {
      await persistBackgroundMeta();
    } catch (e) {}
    return {
      summaries,
      text,
      processed,
      processedFiles,
      totalFiles: jsonFiles.length,
    };
  } catch (e) {
    console.warn(
      "Failed to load background memory:",
      e && e.message ? e.message : e,
    );
    return { summaries: [], text: "", processed: 0, totalFiles: 0 };
  } finally {
    BACKGROUND_MEMORY_LOCK = false;
  }
}

// Initial async load and periodic refresh
// NODE_TEST_CONTEXT is set by the node:test runner; run_tests.js also sets
// NODE_ENV=test. Without both checks, requiring server.js from a test boots
// the background jobs and spawns real model processes.
if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
  (async () => {
    try {
      await asyncLoadBackgroundMemory();
      const refreshMs = Number(
        process.env.MANA_BACKGROUND_MEMORY_REFRESH_MS || 3600000,
      );

      // Scheduled background jobs stay quiet while a watched game is running,
      // matching what Gaming mode already promises for launcher idle work.
      function backgroundJobsPausedForGaming() {
        try {
          const status = getGamingStatus();
          if (status.gamingAppRunning) {
            console.log(
              `Background memory jobs paused: watched game running (${status.matchedProcesses.join(", ")})`,
            );
            return true;
          }
        } catch (e) {
          // If the process check fails, do not block background work.
        }
        return false;
      }

      // Background summarizer: run an async compaction step after loading summaries.
      let summarizerRunning = false;
      async function runBackgroundCompactor() {
        if (summarizerRunning) return;
        summarizerRunning = true;
        try {
          const res = await asyncLoadBackgroundMemory();
          const summaries = res && res.summaries ? res.summaries : [];
          const processedFiles =
            res && res.processedFiles ? res.processedFiles : [];
          if (!summaries || !summaries.length) return;

          const maxChars = Number(
            process.env.MANA_BACKGROUND_MEMORY_MAX_CHARS || 2000,
          );
          const maxTokens = Number(
            process.env.MANA_BACKGROUND_SUMMARIZER_MAX_TOKENS ||
              Math.max(64, Math.floor(maxChars / 4)),
          );

          // Build a compact summarization prompt
          const joined = summaries.slice(0, 200).join("\n\n");

          // Skip the model call entirely when the summaries have not changed
          // since the last successful compaction; reuse the stored result.
          const summariesHash = crypto
            .createHash("sha1")
            .update(joined)
            .digest("hex");
          const lastCompacted = BACKGROUND_MEMORY_META.lastCompacted || null;
          if (lastCompacted && lastCompacted.hash === summariesHash) {
            if (lastCompacted.text) {
              BACKGROUND_MEMORY_BLOCK = `[BACKGROUND MEMORY]\n${lastCompacted.text}\n[END BACKGROUND MEMORY]`;
            }
            return;
          }

          const prompt = `You are a concise summarization assistant. Combine the following session summaries into a single compact background memory block suitable for inclusion beneath system instructions. Keep concrete facts, user preferences, and avoid redundancy. Return only the compacted summary text; do not add commentary.\n\nBEGIN SUMMARIES:\n${joined}\n\nCOMPACT SUMMARY:`;

          let compacted = null;
          try {
            if (shouldUseRemoteAi()) {
              compacted = await runOpenAIReply(
                prompt,
                Math.min(maxTokens, 512),
              );
            }
          } catch (e) {
            console.warn(
              "Background summarizer (remote) failed:",
              e && e.message ? e.message : e,
            );
          }

          if (!compacted) {
            try {
              // Only attempt local summarizer when a local runtime is available
              if (localLlamaReplyAvailable()) {
                compacted = await runLocalLlamaReply(
                  prompt,
                  Math.min(maxTokens, 256),
                  "default",
                );
              } else {
                compacted = null;
              }
            } catch (e) {
              console.warn(
                "Background summarizer (local) failed:",
                e && e.message ? e.message : e,
              );
              compacted = null;
            }
          }

          if (compacted && typeof compacted === "string") {
            compacted = compacted.trim().replace(/\s+/g, " ");
            if (compacted.length > maxChars)
              compacted = compacted.slice(0, maxChars).trim() + "...";
            BACKGROUND_MEMORY_BLOCK = `[BACKGROUND MEMORY]\n${compacted}\n[END BACKGROUND MEMORY]`;
            BACKGROUND_MEMORY_META.lastCompacted = {
              hash: summariesHash,
              text: compacted,
              at: new Date().toISOString(),
            };
            try {
              await persistBackgroundMeta();
              await writeMemoryMarkdown();
            } catch (e) {}
            console.log(
              "Background memory compacted by summarizer (len=",
              compacted.length,
              ")",
            );
          }
        } catch (e) {
          console.warn(
            "Background compactor failed:",
            e && e.message ? e.message : e,
          );
        } finally {
          summarizerRunning = false;
        }
      }

      // Background reviewer: prune unnecessary summaries using the summarizer (non-blocking)
      async function runBackgroundReviewer(apply = true, options = {}) {
        try {
          const res = await asyncLoadBackgroundMemory();
          const processedFiles =
            res && res.processedFiles ? res.processedFiles : [];
          const minSummaries = Number(
            process.env.MANA_BACKGROUND_MEMORY_REVIEW_MIN_SUMMARIES || 10,
          );
          if (!processedFiles || processedFiles.length < minSummaries) {
            // nothing to review yet
            return {
              ok: false,
              reason: "not_enough_summaries",
              processedFiles,
            };
          }

          // Build numbered summaries list
          const numbered = processedFiles
            .map(
              (p, idx) =>
                `${idx + 1}. ${String(p.summary || "").slice(0, 400)}`,
            )
            .join("\n\n");

          // Scheduled runs skip the model call when nothing changed since the
          // last applied review; explicit route-triggered runs always proceed.
          const reviewHash = crypto
            .createHash("sha1")
            .update(numbered)
            .digest("hex");
          if (
            options.skipIfUnchanged &&
            BACKGROUND_MEMORY_META.lastReviewedHash === reviewHash
          ) {
            return {
              ok: false,
              reason: "unchanged_since_last_review",
              processedFiles,
            };
          }

          const maxChars = Number(
            process.env.MANA_BACKGROUND_MEMORY_MAX_CHARS || 2000,
          );
          const maxTokens = Number(
            process.env.MANA_BACKGROUND_SUMMARIZER_MAX_TOKENS ||
              Math.max(64, Math.floor(maxChars / 4)),
          );

          const prompt = `You are a memory curator. Given the following numbered session summaries, identify which entries are redundant or unnecessary for long-term background memory, and which contain important facts or user preferences that should be kept. Return a strict JSON object with keys: \n  - compacted: a single compact background memory string (no more than ${Math.max(64, Math.floor(maxChars / 4))} tokens),\n  - important_facts: an array of short strings (3-10 words each) listing the most salient facts to remember,\n  - remove_indices: an array of integer indices (1-based) indicating which numbered summaries can be removed from the persisted metadata because they are trivial or redundant.\nDo not include any extra commentary. Respond with valid JSON only.\n\nBEGIN SUMMARIES:\n${numbered}\n\nEND SUMMARIES\n\nRETURN JSON:`;

          let reply = null;
          try {
            if (shouldUseRemoteAi()) {
              reply = await runOpenAIReply(prompt, Math.min(maxTokens, 512));
            }
          } catch (e) {
            console.warn(
              "Background reviewer (remote) failed:",
              e && e.message ? e.message : e,
            );
          }
          if (!reply) {
            try {
              if (localLlamaReplyAvailable()) {
                // Background review doesn't need live-reply quality, and
                // during genuine idle time nothing else needs the main
                // brain model anyway -- defaults to the "background"
                // profile (smallest available model) instead of paying
                // main-model cost/latency for a maintenance pass the user
                // isn't waiting on. Overridable (e.g. back to "default" to
                // reuse whatever's already loaded and skip a model swap).
                reply = await runLocalLlamaReply(
                  prompt,
                  Math.min(maxTokens, 256),
                  process.env.MANA_BACKGROUND_REVIEW_PROFILE || "background",
                );
              } else {
                reply = null;
              }
            } catch (e) {
              console.warn(
                "Background reviewer (local) failed:",
                e && e.message ? e.message : e,
              );
              reply = null;
            }
          }

          if (!reply || typeof reply !== "string") {
            console.warn("Background reviewer produced no textual reply");
            return { ok: false, reason: "no_reply", processedFiles };
          }

          // Try to extract JSON from reply
          let parsed = null;
          try {
            parsed = JSON.parse(reply);
          } catch (e) {
            // attempt to find a JSON block inside text
            const m = reply.match(/\{[\s\S]*\}/m);
            if (m) {
              try {
                parsed = JSON.parse(m[0]);
              } catch (e2) {
                parsed = null;
              }
            }
          }

          if (!parsed) {
            console.warn(
              "Background reviewer reply is not valid JSON; skipping application",
            );
            return { ok: false, reason: "invalid_json", reply, processedFiles };
          }

          const removeIndices = Array.isArray(parsed.remove_indices)
            ? parsed.remove_indices
            : parsed.removeIndices || [];
          const importantFacts = Array.isArray(parsed.important_facts)
            ? parsed.important_facts
            : parsed.importantFacts || [];
          const compacted =
            typeof parsed.compacted === "string"
              ? String(parsed.compacted).trim()
              : null;

          if (!apply) {
            // Dry run: return the parsed result for preview
            return {
              ok: true,
              dryRun: true,
              parsed: { removeIndices, importantFacts, compacted },
              reply,
              processedFiles,
            };
          }

          // Apply removals to BACKGROUND_MEMORY_META (mark as pruned)
          for (const idx of removeIndices) {
            if (!Number.isInteger(idx)) continue;
            const i = Number(idx) - 1;
            const pf = processedFiles[i];
            if (
              pf &&
              pf.file &&
              BACKGROUND_MEMORY_META.files &&
              BACKGROUND_MEMORY_META.files[pf.file]
            ) {
              BACKGROUND_MEMORY_META.files[pf.file].pruned = true;
              BACKGROUND_MEMORY_META.files[pf.file].summary = ""; // drop stored summary to conserve space
            }
          }

          // Save important facts to meta for admin inspection
          if (importantFacts && importantFacts.length) {
            BACKGROUND_MEMORY_META.important_facts = importantFacts.slice(
              0,
              200,
            );
          }

          // If we received a compacted text, update the background memory block
          if (compacted) {
            let compactText = compacted.replace(/\s+/g, " ").trim();
            if (compactText.length > maxChars)
              compactText = compactText.slice(0, maxChars).trim() + "...";
            BACKGROUND_MEMORY_BLOCK = `[BACKGROUND MEMORY]\n${compactText}\n[END BACKGROUND MEMORY]`;
            console.log(
              "Background memory reviewer produced compacted block (len=",
              compactText.length,
              ")",
            );
          }

          // Persist updated meta
          BACKGROUND_MEMORY_META.lastReviewedHash = reviewHash;
          try {
            await persistBackgroundMeta();
            await writeMemoryMarkdown();
          } catch (e) {
            console.warn(
              "Failed to persist background meta after review:",
              e && e.message ? e.message : e,
            );
          }

          console.log(
            `Background reviewer applied: removed ${removeIndices.length} entries, saved ${importantFacts.length} important facts`,
          );
          return {
            ok: true,
            parsed: { removeIndices, importantFacts, compacted },
            processedFiles,
          };
        } catch (e) {
          console.warn(
            "Background reviewer failed:",
            e && e.message ? e.message : e,
          );
          return { ok: false, reason: "exception", error: String(e) };
        }
      }

      // Cross-session connections (issue #75): a distinct pass from
      // compaction/pruning -- looks for real relationships *between*
      // separate session summaries (same topic revisited days apart, one
      // session following up on another) rather than summarizing each in
      // isolation. Kept as its own MEMORY.md section (see
      // formatMemoryMarkdown) so a later compaction pass can't silently
      // merge or drop what it found.
      async function runBackgroundConnections() {
        try {
          const res = await asyncLoadBackgroundMemory();
          const processedFiles =
            res && res.processedFiles ? res.processedFiles : [];
          const minSummaries = Number(
            process.env.MANA_BACKGROUND_CONNECTIONS_MIN_SUMMARIES || 2,
          );
          if (!processedFiles || processedFiles.length < minSummaries) {
            // Not enough session history to find a real connection --
            // matches the acceptance criteria's "skip on noise" requirement.
            return { ok: false, reason: "not_enough_summaries" };
          }

          const maxSummaries = Number(
            process.env.MANA_BACKGROUND_CONNECTIONS_MAX_SUMMARIES || 30,
          );
          const numbered = processedFiles
            .slice(0, maxSummaries)
            .map(
              (p, idx) =>
                `${idx + 1}. [session: ${p.file}] ${String(p.summary || "").slice(0, 300)}`,
            )
            .join("\n\n");

          const prompt = `You are finding real connections between separate chat session summaries -- e.g. two sessions touching the same topic days apart, or one session following up on an earlier one. Given the numbered summaries below (each tagged with its session file), list at most 5 short connection lines, each naming which numbered summaries relate and why, formatted like "Summary #1 <-> Summary #3: both discuss the FFXIV crafting rework". Only report connections that are actually there -- if the summaries are all unrelated one-off topics, reply with exactly the single word NONE and nothing else.\n\nBEGIN SUMMARIES:\n${numbered}\n\nEND SUMMARIES\n\nCONNECTIONS:`;

          let reply = null;
          try {
            if (shouldUseRemoteAi()) {
              reply = await runOpenAIReply(prompt, 300);
            }
          } catch (e) {
            console.warn(
              "Background connections (remote) failed:",
              e && e.message ? e.message : e,
            );
          }
          if (!reply) {
            try {
              if (localLlamaReplyAvailable()) {
                reply = await runLocalLlamaReply(prompt, 300, "default");
              }
            } catch (e) {
              console.warn(
                "Background connections (local) failed:",
                e && e.message ? e.message : e,
              );
            }
          }
          if (!reply || typeof reply !== "string") {
            return { ok: false, reason: "no_reply" };
          }

          const trimmed = reply.trim();
          const connections =
            !trimmed || /^NONE$/i.test(trimmed)
              ? []
              : trimmed
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .slice(0, 5);

          BACKGROUND_MEMORY_META.connections = connections;
          try {
            await persistBackgroundMeta();
            await writeMemoryMarkdown();
          } catch (e) {}

          console.log(
            `Background connections pass found ${connections.length} connection(s)`,
          );
          return { ok: true, connections };
        } catch (e) {
          console.warn(
            "Background connections failed:",
            e && e.message ? e.message : e,
          );
          return { ok: false, reason: "exception", error: String(e) };
        }
      }

      // expose reviewer/compactor/connections to other modules/routes (preview/apply, idle-report)
      try {
        runBackgroundReviewerPublic = runBackgroundReviewer;
        runBackgroundCompactorPublic = runBackgroundCompactor;
        runBackgroundConnectionsPublic = runBackgroundConnections;
        // runSkillProposalPublic is constructed in registerRoutes below,
        // not here -- runOpenAIReply only exists in that scope (unlike
        // shouldUseRemoteAi/runLocalLlamaReply/localLlamaReplyAvailable,
        // which really are module-level). Building it eagerly here with a
        // bare `runOpenAIReply` reference would throw immediately at
        // startup (ReferenceError), not just fail quietly when actually
        // invoked -- caught by this same eager-construction refactor.
      } catch (e) {}

      // Run compactor once now, and schedule periodic compaction
      if (!backgroundJobsPausedForGaming()) {
        runBackgroundCompactor().catch((err) =>
          console.warn(
            "Compactor initial run failed:",
            err && err.message ? err.message : err,
          ),
        );
      }

      if (refreshMs > 0) {
        // The compactor reloads background memory itself, so one call per tick
        // is enough; reviewing runs on its own (slower) schedule below.
        setInterval(() => {
          if (backgroundJobsPausedForGaming()) return;
          runBackgroundCompactor().catch((err) =>
            console.warn(
              "Background memory refresh failed:",
              err && err.message ? err.message : err,
            ),
          );
        }, refreshMs);
        console.log(`Background memory will refresh every ${refreshMs}ms`);
      }

      // Periodic reviewer runs less frequently than the compactor (default 1h)
      const reviewMs = Number(
        process.env.MANA_BACKGROUND_MEMORY_REVIEW_MS || 3600000,
      );
      if (reviewMs > 0) {
        setInterval(() => {
          if (backgroundJobsPausedForGaming()) return;
          runBackgroundReviewer(true, { skipIfUnchanged: true }).catch((err) =>
            console.warn(
              "Background memory reviewer periodic run failed:",
              err && err.message ? err.message : err,
            ),
          );
        }, reviewMs);
        console.log(`Background memory reviewer will run every ${reviewMs}ms`);
      }
    } catch (e) {
      console.warn(
        "Initial background memory load failed:",
        e && e.message ? e.message : e,
      );
    }
  })();
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
  // Fires the same compaction/review pass the hourly timer runs, but on the
  // idle signal (issue #69). Deliberately per-registerRoutes-call state (not
  // module-level) so each app instance -- and each test -- starts fresh.
  let idleConsolidationFiredForCurrentIdlePeriod = false;
  const idleGamingStatusCheck = deps.getGamingStatus || getGamingStatus;
  const triggerIdleConsolidation =
    deps.triggerIdleConsolidation ||
    (async function triggerIdleConsolidation() {
      if (typeof runBackgroundCompactorPublic === "function") {
        await runBackgroundCompactorPublic().catch((err) =>
          console.warn(
            "Idle-triggered compactor failed:",
            err && err.message ? err.message : err,
          ),
        );
      }
      if (typeof runBackgroundReviewerPublic === "function") {
        await runBackgroundReviewerPublic(true, {
          skipIfUnchanged: true,
        }).catch((err) =>
          console.warn(
            "Idle-triggered reviewer failed:",
            err && err.message ? err.message : err,
          ),
        );
      }
      if (typeof runBackgroundConnectionsPublic === "function") {
        await runBackgroundConnectionsPublic().catch((err) =>
          console.warn(
            "Idle-triggered connections pass failed:",
            err && err.message ? err.message : err,
          ),
        );
      }
      // Idle-triggered skill proposal (issue #262) -- runs after the
      // memory passes above so it benefits from whatever they just
      // refreshed, and before pruning below so a newly-staged proposal
      // isn't immediately at risk of being considered for staleness.
      if (typeof runSkillProposalPublic === "function") {
        await runSkillProposalPublic({
          skillsStore: deps.skillsStore,
          approvalGate: deps.approvalGate,
        }).catch((err) =>
          console.warn(
            "Idle-triggered skill proposal failed:",
            err && err.message ? err.message : err,
          ),
        );
      }
      // Deterministic, no-LLM skill pruning (issue #140) -- same idle
      // signal as the memory consolidation above, but this pass never
      // calls the model: it just flags/archives skills nobody's used in
      // a while so the cheap skills index doesn't grow forever.
      const idleSkillsStore = deps.skillsStore || skillsStore;
      if (idleSkillsStore && typeof idleSkillsStore.pruneStaleSkills === "function") {
        try {
          idleSkillsStore.pruneStaleSkills({
            staleDays: Number(process.env.MANA_SKILL_STALE_DAYS) || undefined,
            archiveDays: Number(process.env.MANA_SKILL_ARCHIVE_DAYS) || undefined,
          });
        } catch (err) {
          console.warn(
            "Idle-triggered skill pruning failed:",
            err && err.message ? err.message : err,
          );
        }
      }
    });

  // Reported by windows-launcher's powerMonitor.getSystemIdleTime() poll.
  // Fires consolidation once per idle period (resets when the user is seen
  // active again below the threshold), so staying idle for hours doesn't
  // re-trigger it on every ~60s report.
  app.post("/internal/idle-report", (req, res) => {
    const idleSeconds = Number(req.body?.idleSeconds) || 0;
    const thresholdSeconds =
      Number(process.env.MANA_IDLE_THRESHOLD_MS || 20 * 60 * 1000) / 1000;

    if (idleSeconds < thresholdSeconds) {
      idleConsolidationFiredForCurrentIdlePeriod = false;
      return res.json({ ok: true, idleTriggered: false });
    }
    if (idleConsolidationFiredForCurrentIdlePeriod) {
      return res.json({ ok: true, idleTriggered: false });
    }

    let gamingRunning = false;
    try {
      gamingRunning = idleGamingStatusCheck().gamingAppRunning;
    } catch (e) {}
    if (gamingRunning) {
      return res.json({ ok: true, idleTriggered: false, pausedForGaming: true });
    }

    idleConsolidationFiredForCurrentIdlePeriod = true;
    triggerIdleConsolidation().catch((err) =>
      console.warn(
        "Idle-triggered consolidation failed:",
        err && err.message ? err.message : err,
      ),
    );
    return res.json({ ok: true, idleTriggered: true });
  });

  let editorIntegrations = deps.editors || null;
  const mobileMemoryStore = deps.mobileMemoryStore || createMobileMemoryStore();
  function getEditorIntegrations() {
    if (!editorIntegrations) {
      editorIntegrations = createEditorIntegrations();
    }
    return editorIntegrations;
  }
  const modelManagement =
    deps.modelManagement ||
    createModelManagement({
      env: deps.env || process.env,
      modelSettingsStore,
    });

  // llama-server normally starts lazily on the first chat reply. Desktop
  // clients that want a startup loading screen to actually mean something
  // (see desktop-client's service-manager.js) can set this to make node-bot
  // warm it up immediately instead, using whatever model the active profile
  // already resolves to. Best-effort: a missing binary/model here just means
  // replies fall back to on-demand startup (or llama-cli) like today, same
  // as any other ensureServerConfig failure.
  if (
    String((deps.env || process.env).MANA_EAGER_LLAMA_SERVER || "") === "1" &&
    llamaServerRuntime.isEnabled()
  ) {
    const eagerProfile = modelManagement.getActiveProfile();
    const eagerStatus = modelManagement.getModelStatus().profiles[eagerProfile];
    if (eagerStatus && eagerStatus.available && eagerStatus.selectedModel) {
      llamaServerRuntime
        .ensureServerConfig(eagerStatus.selectedModel)
        .catch((e) => console.warn("Eager llama-server startup skipped:", e.message));
    }
  }

  // Issue #215: unlike the llama-server warmup above (opt-in, since eagerly
  // starting it has real GPU/resource cost even when never asked for), this
  // always fires when Fish Speech is the configured provider -- torch.compile
  // (issue #213) makes the first real generate() call after each restart
  // take ~4 minutes instead of ~1-3s, and without this, that first call is
  // whatever the user's next chat message happens to trigger, which blows
  // through fishTtsTimeoutMs and silently falls back to Kokoro for one reply.
  // warmupFishTts() itself no-ops (status "skipped") when the provider isn't
  // fish, so this is a no-op for every other TTS setup. Skipped under tests
  // -- every test file that builds an app via createApp() would otherwise
  // fire a real outbound request to a Fish Speech server that isn't running,
  // slowing (or hanging, on a leaked open handle) the whole suite.
  if (
    !(process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT))
  ) {
    ttsRuntime
      .warmupFishTts()
      .catch((e) => console.warn("Fish Speech warmup skipped:", e.message));
  }

  // Shared by every /admin/* route (moved here, out of the GET /health
  // handler it used to be nested in -- see checkAdminAuth's git history for
  // why that mattered).
  const ADMIN_SECRET =
    (deps.env && deps.env.MANA_ADMIN_SECRET) ||
    process.env.MANA_ADMIN_SECRET ||
    "";

  function checkAdminAuth(req, res) {
    if (!ADMIN_SECRET) return true; // no secret configured -> allow (local dev)
    const header = req.get("authorization") || req.get("Authorization") || "";
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return false;
    }
    const token = header.slice(7).trim();
    if (token !== ADMIN_SECRET) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return false;
    }
    return true;
  }

  const capabilities = deps.capabilities || [
    ffxivMarketPlugin,
    stockMarketPlugin,
    jobApplicationsPlugin,
    jobSearchAdzunaPlugin,
    documentReaderPlugin,
    cronSchedulerPlugin,
    imageGenerationPlugin,
    browserAutomationPlugin,
    telegramBridgePlugin,
    discordBotPlugin,
    videoWatchPlugin,
    contextPushPlugin,
    dirScannerCapability,
    webAccessCapability,
    sessionsCapability,
    deepResearchCapability,
    presetsCapability,
    backgroundMemoryCapability,
    retrieverAdminCapability,
    skillsCapability,
    approvalGateCapability,
    mcpClientCapability,
    toolCallLogCapability,
  ];
  const activePresetsStore = deps.presetsStore || presetsStore;
  const activePluginSettingsStore = deps.pluginSettingsStore || pluginSettingsStore;
  const activeSkillsStore = deps.skillsStore || skillsStore;
  // Registered against whichever store this createApp call actually uses
  // (real singleton, or a test's injected fake) -- registering it at
  // module load time against the module-level skillsStore would silently
  // bypass a test's deps.skillsStore override.
  const activeApprovalGate = deps.approvalGate || approvalGate;
  activeApprovalGate.registerExecutor("skill-write", (payload) => activeSkillsStore.createSkill(payload));
  // Distinct action type for the idle-triggered autonomous pass (issue
  // #262/skill-proposal.js) -- same executor, but kept separate from
  // "skill-write" above so an "always-allow" decision on a manual/
  // conversational skill write doesn't silently also disable review for
  // every future proposal nobody's actually looked at.
  activeApprovalGate.registerExecutor("skill-write-idle", (payload) => activeSkillsStore.createSkill(payload));
  activeApprovalGate.registerExecutor("memory-write", (payload) => acpMemoryStore.rememberFact(payload));

  // Idle-triggered skill-proposal pass (issue #262) -- extracted to
  // skill-proposal.js so its actual logic is directly unit testable; built
  // here (not in the earlier module-load-time startup block) because
  // runOpenAIReply only exists in this function's scope, unlike
  // shouldUseRemoteAi/runLocalLlamaReply/localLlamaReplyAvailable, which
  // really are module-level. Rebuilt on every registerRoutes call (once
  // per real server start, once per test's createApp()), matching
  // activeSkillsStore/activeApprovalGate just above.
  runSkillProposalPublic = createSkillProposalRunner({
    asyncLoadBackgroundMemory,
    shouldUseRemoteAi,
    runOpenAIReply,
    localLlamaReplyAvailable,
    runLocalLlamaReply,
    skillsStore: activeSkillsStore,
    approvalGate: activeApprovalGate,
  }).run;
  const activeMcpClientRegistry = deps.mcpClientRegistry || mcpClientRegistry;
  const activeToolCallLog = deps.toolCallLog || toolCallLog;
  const activeBrowserAutomationToolSource = deps.browserAutomationToolSource || browserAutomationToolSource;
  const capabilityContext = {
    acpMemoryStore: deps.acpMemoryStore || acpMemoryStore,
    // Only cron-scheduler's agent-job executor uses this today -- every
    // other capability builds its own scoped model-reply function above.
    buildAssistantReply: deps.buildAssistantReply || buildAssistantReply,
    // Only browser-automation's routes use this today -- everywhere else
    // that needs a loopback-only guard builds it inline (e.g. the
    // brain-provider test route above).
    isLocalRestartRequest: deps.isLocalRestartRequest || isLocalRestartRequest,
    approvalGate: activeApprovalGate,
    mcpClientRegistry: activeMcpClientRegistry,
    toolCallLog: deps.toolCallLog || toolCallLog,
    // Issue #187: discord-bot's voice session needs the same full
    // "speak this reply" pipeline (gaming-aware TTS provider switching,
    // VTube reactions, captions) every other surface already uses, not a
    // bare ttsRuntime.synthesizeReply call.
    synthesizeReply: deps.synthesizeReply || synthesizeReply,
    // Only video-watch's route uses this today -- everywhere else that
    // needs a vision reply builds its own scoped call (see the
    // recordChatTurn/vision block below).
    runVisionReply:
      deps.runVisionReply ||
      ((prompt, images, maxTokens) =>
        llamaServerRuntime.runVisionReply(prompt, images, maxTokens)),
    pluginSettingsStore: activePluginSettingsStore,
    skillsStore: activeSkillsStore,
    env: deps.env || process.env,
    synthesize:
      deps.synthesize ||
      ((prompt) => runLocalLlamaReply(prompt, 800, "quality", RESEARCH_SYSTEM_PROMPT)),
    // Deliberately the same profile as synthesize: a different profile here
    // would force a llama-server model swap (kill/respawn) in the middle of
    // every research pass. Sub-query planning is a short completion anyway.
    decompose:
      deps.decompose ||
      ((prompt) => runLocalLlamaReply(prompt, 200, "quality", SUB_QUERY_SYSTEM_PROMPT)),
    // Issue #197: same bound-completion pattern and "quality" profile as
    // decompose above -- a short structured decision (a follow-up query or
    // NONE), not a full reply.
    reflect:
      deps.reflect ||
      ((prompt) => runLocalLlamaReply(prompt, 100, "quality", REFLECT_SYSTEM_PROMPT)),
    // Issue #208: same shared compressExcerpts helper the coding-mode
    // repo-retrieval block (issue #211) also reuses.
    compress: deps.compress || compressExcerpts,
    // Same bound-completion pattern as synthesize/decompose above, just with
    // job-applications' own system prompt (issue #116).
    synthesizeJobMatch:
      deps.synthesizeJobMatch ||
      ((prompt) =>
        runLocalLlamaReply(
          prompt,
          jobApplicationsPlugin.JOB_MATCH_MAX_TOKENS,
          "quality",
          jobApplicationsPlugin.JOB_MATCH_SYSTEM_PROMPT,
        )),
    presetsStore: activePresetsStore,
    marketDataClient,
    jobApplicationsStore,
    adzunaClient,
    UNIVERSALIS_DEFAULT_WORLD,
    FFXIV_PROFIT_TOP_LIMIT,
    FFXIV_RECIPE_SOURCE,
    XIVAPI_RECIPE_PAGE_SIZE,
    XIVAPI_RECIPE_SCAN_LIMIT,
    extractExplicitItemNameFromText,
    extractHoveredItemName,
    findProfitableCrafts: deps.findProfitableCrafts || findProfitableCrafts,
    getUniversalisMarketSummary:
      deps.getUniversalisMarketSummary || getUniversalisMarketSummary,
    logPerf,
    normalizeCraftRankingMode,
    normalizeGatheringJobFilter,
    normalizeGatheringSourceFilter,
    nowMs,
    resolveFfxivItemByName:
      deps.resolveFfxivItemByName || resolveFfxivItemByName,
    searchWeb: deps.searchWeb || searchWeb,
    fetchPage: deps.fetchPage || fetchPage,
    wikiLookup: deps.wikiLookup || wikiLookup,
    checkAdminAuth,
    runBackgroundReviewerPublic: deps.runBackgroundReviewerPublic || runBackgroundReviewerPublic,
    runSkillProposalPublic: deps.runSkillProposalPublic || runSkillProposalPublic,
    asyncLoadBackgroundMemory: deps.asyncLoadBackgroundMemory || asyncLoadBackgroundMemory,
    persistBackgroundMeta: deps.persistBackgroundMeta || persistBackgroundMeta,
    getBackgroundMemoryMeta: () => BACKGROUND_MEMORY_META,
    setBackgroundMemoryBlock: (block) => {
      BACKGROUND_MEMORY_BLOCK = block;
    },
  };
  registerCapabilities(app, capabilities, capabilityContext);

  app.get("/doctor", async (req, res) => {
    try {
      const doctor = deps.doctor || runDoctorChecksAsync;
      const result = await doctor({
        fishTtsWarmup: ttsRuntime.getFishWarmupStatus(),
      });
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
    // Opens an arbitrary local path in an editor -- CORS is wide open
    // app-wide, so without this any site the user has loaded in a browser
    // tab could otherwise trigger it via a background fetch().
    if (!checkAdminAuth(req, res)) return;
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
    if (!checkAdminAuth(req, res)) return;
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
    if (!checkAdminAuth(req, res)) return;
    const editors = getEditorIntegrations();
    return res.json({ workspace: editors.getWorkspace() });
  });

  app.post("/editors/workspace", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
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
    if (!checkAdminAuth(req, res)) return;
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
    if (!checkAdminAuth(req, res)) return;
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
    if (!checkAdminAuth(req, res)) return;
    const editors = getEditorIntegrations();
    return res.json({ proposals: editors.listEditProposals() });
  });

  app.post("/editors/workspace/proposals", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
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
    if (!checkAdminAuth(req, res)) return;
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
    if (!checkAdminAuth(req, res)) return;
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

  app.get("/models/status", (req, res) => {
    return res.json(modelManagement.getModelStatus());
  });

  // Issue #196: separate from /models/status (polled frequently) on
  // purpose -- real GGUF header parsing is real file I/O, not something to
  // add to a hot poll path. Called on-demand when a user actually wants to
  // see a model's real metadata instead of just its filename. Reuses the
  // same magic-byte gate setModelPath()/setVisionSettings() already use
  // before ever trusting a path is a real GGUF file.
  const activeReadGgufMetadata = deps.readGgufMetadata || readGgufMetadata;
  app.get("/models/gguf-metadata", async (req, res) => {
    const filePath = String(req.query?.path || "");
    if (!filePath || !modelManagement.isValidGgufFile(filePath)) {
      return res.status(400).json({ error: "path must point to a valid GGUF file" });
    }
    const metadata = await activeReadGgufMetadata(filePath);
    if (!metadata) {
      return res.status(422).json({ error: "could not parse GGUF metadata for this file" });
    }
    return res.json(metadata);
  });

  app.post("/models/active-profile", (req, res) => {
    try {
      return res.json(modelManagement.setActiveProfile(req.body?.profile));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // Full-storage scan for .gguf files (issue #123 install flow): best-effort,
  // time/dir-capped -- see scanForGgufFiles in model-management.js. Optional
  // body.roots lets the desktop client scope it (e.g. just a chosen drive)
  // instead of the default home-dir + every drive letter.
  app.post("/models/scan", (req, res) => {
    try {
      const roots = Array.isArray(req.body?.roots) ? req.body.roots : undefined;
      return res.json(modelManagement.scanForModels(roots));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // Explicitly select (or clear, with modelPath: null/"") which local .gguf
  // file to use, from either a scan result or a manual file browse.
  app.post("/models/path", (req, res) => {
    try {
      return res.json(modelManagement.setModelPath(req.body?.modelPath));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // Switch Mana's brain between local (llama-server + a GGUF) and any
  // OpenAI-compatible endpoint. apiKey is write-only from here on out --
  // /models/status never echoes it back (see model-management.js).
  app.post("/models/brain-provider", (req, res) => {
    try {
      return res.json(
        modelManagement.setBrainSettings({
          type: req.body?.type,
          baseUrl: req.body?.baseUrl,
          apiKey: req.body?.apiKey,
          model: req.body?.model,
        }),
      );
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  // Presets for the brain-provider dropdown (Settings' "Use Remote AI" UI).
  app.get("/models/brain-providers", (req, res) => {
    return res.json(modelManagement.getKnownBrainProviders());
  });

  // "Connect" button: tests reachability/auth against baseUrl before saving.
  // Local-only (same isLocalRestartRequest check as /admin/restart): this is
  // the one /models/* route that makes node-bot issue an outbound request to
  // a user-supplied URL, and node-bot listens on all interfaces with CORS
  // wide open, so an unrestricted version of this route would let anyone who
  // can reach this machine's port make it probe arbitrary hosts (SSRF). The
  // fix is restricting *who can call it*, not the destination -- the whole
  // point of this button is testing local/LAN endpoints (Ollama, LM
  // Studio), so blocking private addresses would defeat the feature.
  app.post("/models/brain-provider/test", async (req, res) => {
    if (!isLocalRestartRequest(req)) {
      return res.status(403).json({ error: "this endpoint is only available from this PC" });
    }
    const result = await modelManagement.testBrainConnection({
      baseUrl: req.body?.baseUrl,
      apiKey: req.body?.apiKey,
    });
    return res.json(result);
  });

  // A one-off, session-scoped mode switch layered on top of Mana's base
  // persona (persona.js) -- doesn't touch the persona file itself, and
  // clears on request or when the process restarts.
  app.post("/persona/override", (req, res) => {
    const sessionId = req.body?.sessionId;
    const override = req.body?.override;
    const applied = persona.setPersonaOverride(sessionId, override);
    if (!applied) {
      return res.status(400).json({ error: "sessionId and override are required" });
    }
    return res.json({ ok: true, sessionId, override });
  });

  app.post("/persona/override/clear", (req, res) => {
    const sessionId = req.body?.sessionId;
    const cleared = persona.clearPersonaOverride(sessionId);
    return res.json({ ok: true, cleared });
  });

  // Vision GGUF + mmproj override ("" clears back to auto-detection).
  app.post("/models/vision-path", (req, res) => {
    try {
      return res.json(
        modelManagement.setVisionSettings({
          modelPath: req.body?.modelPath,
          mmprojPath: req.body?.mmprojPath,
        }),
      );
    } catch (error) {
      return res.status(400).json({ error: error.message });
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
    return names.some(
      (name) => typeof env[name] === "string" && env[name].trim(),
    );
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
        whisperConfigured
          ? "Whisper is configured."
          : "Whisper binary or model is missing.",
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
        mobileAuthConfigured
          ? "Mobile auth is configured."
          : "Mobile auth secrets are missing.",
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
        cloudflareConfigured
          ? `Cloudflare Tunnel is configured -- Mana's backend may be reachable from the internet through it. Keep the mobile passcode enabled and see docs/mobile_pwa_cloudflare.md.${mobileAuthConfigured ? "" : " Mobile auth is NOT currently configured; anyone who reaches the tunnel hostname can hit unauthenticated routes."}`
          : "Cloudflare Tunnel is not configured. Mana is only reachable locally.",
      ),
      vtubeStudio: makeHealthComponent(
        vtubeEnabled ? "configured" : "unavailable",
        vtubeEnabled,
        vtubeEnabled
          ? "VTube Studio integration is enabled."
          : "VTube Studio integration is disabled.",
      ),
    };
  }

  // Graceful shutdown for the desktop client's closing UI: releases
  // llama-server's VRAM/RAM before this process exits, instead of leaving
  // it orphaned. A plain process kill from the parent doesn't work for
  // this on Windows -- child_process.kill() force-terminates rather than
  // delivering a catchable signal, so llamaServerRuntime's own SIGTERM
  // handler (registered for the POSIX case) never runs. desktop-client's
  // shutdown-manager.js calls this instead, then waits for this process to
  // actually exit.
  app.post("/admin/shutdown", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      llamaServerRuntime.stop();
    } catch (e) {
      console.error("Error stopping llama-server during shutdown:", e?.message || e);
    }
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 150);
  });

  app.get("/health", (req, res) => {
    const env = deps.env || process.env;
    const llamaStatus = getLlamaStatus();
    const components = buildHealthComponents({
      env,
      llamaStatus,
      mobileMemoryStore,
      ttsBin: TTS_BIN,
      ttsProvider: TTS_PROVIDER,
      whisperBin: whisperDiscovery.findWhisperBin({ env }),
      whisperModel: whisperDiscovery.findWhisperModel({ env }),
    });
    Object.assign(
      components,
      buildCapabilityHealth(capabilities, capabilityContext),
    );

    res.json({
      ok: true,
      ttsConfigured: TTS_PROVIDER !== "none",
      ttsProvider: TTS_PROVIDER,
      kokoroTtsUrl: KOKORO_TTS_URL,
      fishTtsUrl: FISH_TTS_URL,
      llamaConfigured: llamaStatus.ok,
      llamaModel: llamaStatus.model,
      llamaBin: llamaStatus.bin,
      llamaStatus: llamaStatus.message,
      // Distinct from llamaConfigured (paths resolved): whether the
      // persistent llama-server process is actually up right now -- see
      // MANA_EAGER_LLAMA_SERVER above. false is a legitimate steady state
      // when it hasn't been asked to start yet, not an error.
      llamaServerRunning: llamaServerRuntime.getStatus().running,
      // Issue #215: "idle" (fish isn't the configured provider or the
      // warmup hasn't fired yet) | "warming" (compile trace in progress) |
      // "ready" | "skipped" (provider isn't fish) | "failed".
      fishTtsWarmup: ttsRuntime.getFishWarmupStatus(),
      remoteAiEnabled: shouldUseRemoteAi(),
      vtubeStudioConfigured: Boolean(vtubeStudio),
      vtubeStudioUrl: VTUBE_STUDIO_URL,
      components,
    });
  });

  // Lightweight debug endpoint for frontend intent preview
  app.post("/debug/intent", (req, res) => {
    const { text } = req.body || {};
    if (text === undefined || typeof text !== "string") {
      return res.status(400).json({
        success: false,
        error: "Bad Request",
        message:
          "Missing or invalid 'text' property in the JSON body payload.",
      });
    }

    try {
      const evaluation = classifyIntent(text);
      return res.status(200).json(
        Object.assign(
          {
            success: true,
            input_length: text.length,
          },
          evaluation,
        ),
      );
    } catch (err) {
      console.error(
        "🚨 [/debug/intent] Router checkpoint failed:",
        err?.message || err,
      );
      return res.status(500).json({
        success: false,
        error: "Internal Server Error",
        message: err?.message || String(err),
      });
    }
  });

  // Admin endpoints for file write approvals
  const PENDING_DIR =
    process.env.MANA_PENDING_WRITES_DIR ||
    path.join(__dirname, "data", "pending_writes");

  // Pending-write ids come straight from the URL (:id) into path.join()
  // below; without this check "../../whatever" would let an admin-auth'd
  // request read/write/delete files outside PENDING_DIR.
  function isSafePendingWriteId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
  }

  app.get("/admin/pending-writes", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      await fs.promises.mkdir(PENDING_DIR, { recursive: true });
      const files = await fs.promises.readdir(PENDING_DIR);
      const pending = [];
      for (const f of files) {
        if (
          f.endsWith(".json") &&
          !f.endsWith(".approved.json") &&
          !f.endsWith(".rejected.json")
        ) {
          const id = f.replace(/\.json$/i, "");
          const base = path.join(PENDING_DIR, id);
          const pendingPath = `${base}.json`;
          let payload = null;
          try {
            payload = JSON.parse(
              await fs.promises.readFile(pendingPath, "utf8"),
            );
          } catch (e) {
            payload = null;
          }
          const approved = fs.existsSync(`${base}.approved.json`);
          const rejected = fs.existsSync(`${base}.rejected.json`);
          pending.push({ id, payload, approved, rejected });
        }
      }
      return res.json({ ok: true, pending });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/admin/pending-writes/:id/approve", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const id = req.params.id;
      if (!isSafePendingWriteId(id)) {
        return res.status(400).json({ ok: false, error: "invalid id" });
      }
      const base = path.join(PENDING_DIR, id);
      const approvedPath = `${base}.approved.json`;
      const data = {
        approver: req.body?.approver || "local-user",
        at: new Date().toISOString(),
        note: req.body?.note || null,
      };
      await fs.promises.writeFile(
        approvedPath,
        JSON.stringify(data, null, 2),
        "utf8",
      );
      // Optionally archive immediately
      try {
        const archiveDir = path.join(PENDING_DIR, "archive");
        await fs.promises.mkdir(archiveDir, { recursive: true });
        const pendingPath = `${base}.json`;
        let pendingPayload = null;
        try {
          pendingPayload = JSON.parse(
            await fs.promises.readFile(pendingPath, "utf8"),
          );
        } catch (e) {
          pendingPayload = null;
        }
        const outPath = path.join(archiveDir, `${id}.approved.json`);
        const archiveObj = {
          id,
          status: "approved",
          pending: pendingPayload,
          action: data,
          archivedAt: new Date().toISOString(),
        };
        await fs.promises.writeFile(
          outPath,
          JSON.stringify(archiveObj, null, 2),
          "utf8",
        );
        // remove originals
        try {
          if (fs.existsSync(pendingPath))
            await fs.promises.unlink(pendingPath);
        } catch (e) {}
        try {
          if (fs.existsSync(approvedPath))
            await fs.promises.unlink(approvedPath);
        } catch (e) {}
      } catch (e) {
        // ignore archive errors
      }

      return res.json({ ok: true, id });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/admin/pending-writes/:id/reject", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const id = req.params.id;
      if (!isSafePendingWriteId(id)) {
        return res.status(400).json({ ok: false, error: "invalid id" });
      }
      const base = path.join(PENDING_DIR, id);
      const rejectedPath = `${base}.rejected.json`;
      const data = {
        approver: req.body?.approver || "local-user",
        at: new Date().toISOString(),
        reason: req.body?.reason || null,
      };
      await fs.promises.writeFile(
        rejectedPath,
        JSON.stringify(data, null, 2),
        "utf8",
      );
      // Optionally archive immediately
      try {
        const archiveDir = path.join(PENDING_DIR, "archive");
        await fs.promises.mkdir(archiveDir, { recursive: true });
        const pendingPath = `${base}.json`;
        let pendingPayload = null;
        try {
          pendingPayload = JSON.parse(
            await fs.promises.readFile(pendingPath, "utf8"),
          );
        } catch (e) {
          pendingPayload = null;
        }
        const outPath = path.join(archiveDir, `${id}.rejected.json`);
        const archiveObj = {
          id,
          status: "rejected",
          pending: pendingPayload,
          action: data,
          archivedAt: new Date().toISOString(),
        };
        await fs.promises.writeFile(
          outPath,
          JSON.stringify(archiveObj, null, 2),
          "utf8",
        );
        // remove originals
        try {
          if (fs.existsSync(pendingPath))
            await fs.promises.unlink(pendingPath);
        } catch (e) {}
        try {
          if (fs.existsSync(rejectedPath))
            await fs.promises.unlink(rejectedPath);
        } catch (e) {}
      } catch (e) {
        // ignore archive errors
      }

      return res.json({ ok: true, id });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Admin token-cache endpoints
  app.get("/admin/token-cache", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const cachePath = path.join(
        __dirname,
        "data",
        "token_count_cache.json",
      );
      if (!fs.existsSync(cachePath))
        return res.json({ ok: true, keys: [], count: 0 });
      const txt = await fs.promises.readFile(cachePath, "utf8");
      const obj = JSON.parse(txt || "{}");
      const keys = Object.keys(obj);
      return res.json({ ok: true, keys, count: keys.length });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  app.post("/admin/token-cache/evict", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const p = typeof req.body?.path === "string" ? req.body.path : null;
      if (!p)
        return res.status(400).json({ ok: false, error: "path required" });
      const cachePath = path.join(
        __dirname,
        "data",
        "token_count_cache.json",
      );
      let cache = {};
      try {
        if (fs.existsSync(cachePath))
          cache = JSON.parse(
            (await fs.promises.readFile(cachePath, "utf8")) || "{}",
          );
      } catch (e) {
        cache = {};
      }
      const key = path.resolve(p);
      if (cache[key]) delete cache[key];
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.promises.writeFile(
        cachePath,
        JSON.stringify(cache, null, 2),
        "utf8",
      );
      return res.json({ ok: true, evicted: key });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // proxy metrics from Python token HTTP server if available
  app.get("/admin/token-cache-metrics", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const pyPort = Number(process.env.PY_TOKEN_SERVER_PORT || 9000);
      const pySecret = process.env.PY_TOKEN_SERVER_SECRET || null;
      const url = `http://127.0.0.1:${pyPort}/metrics`;
      const headers = {};
      if (pySecret) headers["Authorization"] = `Bearer ${pySecret}`;
      const fetch = require("node-fetch");
      const resp = await fetch(url, { headers, method: "GET" });
      const body = await resp.text();
      try {
        const parsed = JSON.parse(body);
        return res.json({ ok: true, metrics: parsed.metrics || parsed });
      } catch (e) {
        return res
          .status(502)
          .json({ ok: false, error: "invalid_metrics_response" });
      }
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // Admin endpoint: send a tray notification (protected)
  app.post("/admin/notify/tray", async (req, res) => {
    const ADMIN_SECRET_ENV = process.env.MANA_ADMIN_SECRET || "";
    if (ADMIN_SECRET_ENV) {
      const header = req.get("authorization") || req.get("Authorization") || "";
      if (!header || !header.startsWith("Bearer "))
        return res.status(401).json({ ok: false, error: "unauthorized" });
      const token = header.slice(7).trim();
      if (token !== ADMIN_SECRET_ENV)
        return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    try {
      const body = req.body || {};
      const title =
        typeof body.title === "string" ? body.title : "Mana Notification";
      const text = typeof body.text === "string" ? body.text : "";
      const type = typeof body.type === "string" ? body.type : "info";
      const data = body.data || null;

      try {
        const bt = app && app.locals && app.locals.broadcastTrayNotification;
        if (typeof bt === "function") {
          bt({ type, title, text, data, at: new Date().toISOString() });
          return res.json({ ok: true });
        } else {
          return res
            .status(500)
            .json({ ok: false, error: "tray_server_unavailable" });
        }
      } catch (e) {
        return res.status(500).json({ ok: false, error: String(e) });
      }
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e) });
    }
  });

  const TTS_OVERRIDE_PROVIDERS = ["fish", "kokoro", "gpt_sovits", "cli"];

  app.get("/tts/override", (req, res) => {
    res.json({ ok: true, override: ttsRuntime.getProviderOverride() });
  });

  app.post("/tts/override", (req, res) => {
    const { provider } = req.body || {};
    if (provider !== null && provider !== undefined && !TTS_OVERRIDE_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        ok: false,
        error: `provider must be one of ${TTS_OVERRIDE_PROVIDERS.join(", ")}, or null to clear`,
      });
    }
    ttsRuntime.setProviderOverride(provider || null);
    return res.json({ ok: true, override: ttsRuntime.getProviderOverride() });
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

  // Lists capabilities that opt in with a `category` (e.g. the FFXIV plugin
  // under ../plugins/), grouped by category. Built-in capabilities without
  // a category (sessions, presets, etc.) aren't "plugins" in this sense and
  // don't appear here -- see /health for the full component list.
  app.get("/plugins", (req, res) => {
    const grouped = {};
    for (const capability of capabilities) {
      if (!capability.category) continue;
      const bucket = grouped[capability.category] || (grouped[capability.category] = []);
      bucket.push({
        key: capability.key,
        name: capability.name || capability.key,
        description: capability.description || null,
        enabled: activePluginSettingsStore.isEnabled(
          capability.key,
          capability.defaultEnabled !== false,
        ),
      });
    }
    return res.json({ ok: true, plugins: grouped });
  });

  app.post("/plugins/:key/enabled", (req, res) => {
    const capability = capabilities.find(
      (c) => c.category && c.key === req.params.key,
    );
    if (!capability) {
      return res.status(404).json({ ok: false, error: "no such plugin" });
    }
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "enabled must be a boolean" });
    }
    const resolved = activePluginSettingsStore.setEnabled(capability.key, enabled);
    return res.json({ ok: true, key: capability.key, enabled: resolved });
  });

  const turnArbiter = require("./utils/turn_arbiter");

  async function synthesizeReply(text, opts = {}) {
    // S1-mini needs the GPU largely to itself -- under real VRAM contention
    // from a running game it doesn't fail, it just gets slow enough (10-50x)
    // to be unusable for real-time chat. Switch to Kokoro automatically
    // whenever a watched game is running, and back once it closes.
    if (ttsRuntime.ttsProvider === "fish") {
      try {
        const gaming = getGamingStatus();
        ttsRuntime.setProviderOverride(gaming.gamingAppRunning ? "kokoro" : null);
        // Fire-and-forget: also park S1-mini's weights in system RAM while
        // the game holds the GPU, and pull them back once it closes. Swaps
        // take 30-100s+ under contention, so this must never block the
        // reply that's about to go out over Kokoro.
        ttsRuntime
          .swapFishDevice(gaming.gamingAppRunning ? "cpu" : "cuda")
          .catch((err) =>
            console.warn("Fish device swap failed:", err.message),
          );
      } catch (e) {
        // Best-effort; fall through with whatever provider is configured.
      }
    }

    // Acquire a voice turn (priority 0 = highest for direct voice turns)
    const release = await turnArbiter.acquireTurn(0, {
      timeoutMs: 2 * 60 * 1000,
    });

    let captionServer = null;
    try {
      try {
        captionServer = require("./caption-server");
      } catch (e) {
        captionServer = null;
      }

      // prefer a provider method that returns timings
      if (typeof ttsRuntime.synthesizeWithTimings === "function") {
        const res = await ttsRuntime.synthesizeWithTimings(text);
        const audio = res && res.audio ? res.audio : res;
        const timings = res && res.timings ? res.timings : null;
        // broadcast captions if we have timings and a caption server
        if (
          timings &&
          captionServer &&
          typeof captionServer.broadcastCaption === "function"
        ) {
          try {
            captionServer.broadcastCaption({
              text,
              words: timings,
              source: "tts",
            });
          } catch (e) {}
        }
        return audio;
      }

      // fallback: synthesize audio and estimate timings locally
      const audio = await ttsRuntime.synthesizeReply(text);
      if (
        captionServer &&
        typeof captionServer.broadcastCaption === "function"
      ) {
        try {
          // estimate timings using TTS runtime helper if available
          const timings =
            typeof ttsRuntime.estimateWordTimings === "function"
              ? ttsRuntime.estimateWordTimings(text)
              : String(text)
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((w, i) => ({
                    word: w,
                    startMs: i * 120,
                    endMs: (i + 1) * 120,
                  }));
          captionServer.broadcastCaption({
            text,
            words: timings,
            source: "tts",
          });
        } catch (e) {}
      }

      return audio;
    } finally {
      try {
        release();
      } catch (e) {}
    }
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
    const found = whisperDiscovery.findWhisperBin({ env: process.env });
    if (found) {
      return found;
    }
    throw new Error(
      "Whisper executable not found under tools/whisper. Set WHISPER_BIN to a valid whisper-cli.exe path.",
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
    const whisperModel = whisperDiscovery.findWhisperModel({ env: process.env });
    if (!whisperModel) {
      throw new Error(
        "Whisper model not found under tools/whisper. Set WHISPER_MODEL to a valid ggml *.bin path.",
      );
    }
    const whisperBin = findWhisperBin();
    const startedAt = nowMs();
    // I ask whisper-cli for JSON output so transcription parsing does not depend on stdout formatting.
    const outBase = filePath + ".out";
    const outJson = outBase + ".json";
    const args = [
      "-m",
      whisperModel,
      "-f",
      filePath,
      "-t",
      String(WHISPER_THREADS),
      "-l",
      WHISPER_LANGUAGE,
      "-bs",
      WHISPER_BEAM_SIZE,
      "-nth",
      WHISPER_NO_SPEECH_THRESHOLD,
      "-tp",
      WHISPER_TEMPERATURE,
      "--output-json",
      "-of",
      outBase,
    ];
    if (WHISPER_PROMPT) {
      args.push("--prompt", WHISPER_PROMPT, "--carry-initial-prompt");
    }
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

  const runLocalAssistantReply =
    deps.runLocalAssistantReply ||
    (async function runLocalAssistantReply(
      prompt,
      maxTokens = 256,
      profile = "default",
      overrideSystemPrompt = null,
    ) {
      return runLocalLlamaReply(prompt, maxTokens, profile, overrideSystemPrompt);
    });

  // Foundational tool-calling (issue #51): only llama-server (not the
  // llama-cli fallback) exposes an OpenAI-compatible tools API, so this has
  // no CLI equivalent -- callers check llamaServerRuntime.isEnabled() first.
  const runToolAwareReply =
    deps.runToolAwareReply ||
    (async function runToolAwareReply(prompt, toolPolicyArg, options) {
      return llamaServerRuntime.runToolAwareReply(prompt, toolPolicyArg, options);
    });
  const activeToolPolicy = deps.toolPolicy || toolPolicy;
  // Shared by tool-calling and best-of-N (issue #70): both require
  // llama-server specifically, not the llama-cli fallback.
  const isLlamaServerAvailable =
    deps.isLlamaServerEnabled || (() => llamaServerRuntime.isEnabled());

  // Best-of-N self-voting (issue #70): same "llama-server only" constraint
  // as tool-calling -- sampling-parameter (temperature) control isn't
  // available through the llama-cli fallback path.
  const runBestOfNReply =
    deps.runBestOfNReply ||
    (async function runBestOfNReply(prompt, options) {
      return llamaServerRuntime.runBestOfNReply(prompt, options);
    });

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

    parts.push(
      "",
      "Answer the user using the extra context only when it helps.",
    );
    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // OpenAI / proxy API inference
  // ---------------------------------------------------------------------------
  async function runOpenAIReply(
    prompt,
    maxTokens = LLAMA_MAX_TOKENS,
    systemPromptOverride = null,
  ) {
    if (!shouldUseRemoteAi()) {
      return null; // no key configured; fall back to local
    }

    const systemPrompt = systemPromptOverride || persona.DEFAULT_SYSTEM_PROMPT;

    const baseUrl = openAiBaseUrl().replace(/\/+$/, "");
    const url = new URL(baseUrl + "/v1/chat/completions");
    const transport = url.protocol === "https:" ? https : http;

    const body = JSON.stringify({
      model: openAiModel(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
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
          // Many self-hosted OpenAI-compatible servers (Ollama, llama.cpp's
          // own llama-server, etc.) don't require auth at all -- only send
          // the header when there's actually a key configured, rather than
          // sending a literal "Bearer null" to a server that might choke on it.
          ...(openAiApiKey() ? { Authorization: `Bearer ${openAiApiKey()}` } : {}),
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
              j?.choices?.[0]?.message?.content ||
              j?.choices?.[0]?.text ||
              null;
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

  // Assistant mode picker: use the local intent classifier when available
  const { classifyIntent } = require("./utils/intent-classifier");

  // Returns an object: { mode: 'casual'|'everyday'|'coding', reason: string }
  function pickAssistantMode(transcript, normalizedModelProfile) {
    try {
      const result = classifyIntent(transcript, normalizedModelProfile);
      if (result && result.mode) return result;
      return {
        mode: normalizedModelProfile === "coding" ? "coding" : "everyday",
        reason: "fallback_model_profile",
      };
    } catch (e) {
      return {
        mode: normalizedModelProfile === "coding" ? "coding" : "everyday",
        reason: "error_classifier",
      };
    }
  }

  async function buildAssistantReply(
    transcript,
    screenText = "",
    marketText = "",
    modelProfile = "default",
    sessionId = null,
    assistantMode = null,
    presetId = null,
  ) {
    const prompt = buildScreenAwarePrompt(transcript, screenText, marketText);
    const normalizedModelProfile = selectLlamaModelProfileForPrompt(
      transcript,
      modelProfile,
    );

    // Determine assistant mode and system prompt
    const inferred = pickAssistantMode(transcript, normalizedModelProfile); // { mode, reason }
    // Use explicit assistantMode if provided; otherwise use inferred.mode
    const mode =
      assistantMode ||
      (inferred && inferred.mode) ||
      (normalizedModelProfile === "coding" ? "coding" : "everyday");

    // Optional lightweight intent telemetry (enable with MANA_INTENT_TELEMETRY=1)
    try {
      const intentTelemetry =
        process.env.MANA_INTENT_TELEMETRY === "1" ||
        process.env.MANA_INTENT_TELEMETRY === "true";
      if (intentTelemetry) {
        console.log(
          `[Mana Router] 🧭 Routing to mode [${mode}] | Reason: ${inferred && inferred.reason ? inferred.reason : "none"} | Session: ${sessionId || "none"}`,
        );
      }
    } catch (e) {
      // don't block on telemetry
    }

    let selectedSystemPrompt = null;
    // Identity ("who Mana is") comes from persona.js, layered with each
    // mode's own task-specific operational instructions -- these three
    // used to each redefine Mana's personality from scratch, drifting
    // slightly from one another and from persona.js's other consumers.
    const personaBlock = persona.buildPersonaPrompt(sessionId);
    const CASUAL_SYSTEM_PROMPT = `${personaBlock} Use short paragraphs and natural conversational phrasing; include occasional friendly flourishes (e.g. "You got this!"). Ask one clarifying question only when necessary. If the user requests professional or safety-sensitive information, politely indicate you cannot provide it and offer to look up resources or recommend professionals.`;
    const EVERYDAY_SYSTEM_PROMPT = `${personaBlock} Provide clear, concise, and practical guidance. When giving instructions, present them as short numbered steps and include expected outcomes or simple checks when helpful. Use plain language accessible to non-technical users. Offer follow-up actions and ask clarifying questions only when required. For health, legal, or hazardous topics, recommend professional resources.`;
    const CODING_SYSTEM_PROMPT = `${personaBlock} In this mode, be focused, precise, and technical: start with a one-line summary of intent, then provide minimal, runnable code examples in fenced blocks, followed by a short explanation and a suggested test or verification step. Avoid small talk entirely. Ask only necessary clarifying questions. When the user requests structured output (JSON, patch, or commands), return exactly the machine-readable block unless commentary is explicitly requested. Include assumptions and environment notes when relevant.`;

    if (mode === "casual" || mode === "chat") {
      selectedSystemPrompt = CASUAL_SYSTEM_PROMPT;
    } else if (mode === "coding" || mode === "developer") {
      selectedSystemPrompt = CODING_SYSTEM_PROMPT;
    } else {
      selectedSystemPrompt = EVERYDAY_SYSTEM_PROMPT;
    }

    // A saved preset layers its instructions on top of the base persona
    // prompt rather than replacing it -- Mana stays Mana, just tuned. No
    // preset selected (the common case) leaves this untouched.
    if (presetId) {
      try {
        const preset = activePresetsStore.getPreset(presetId);
        if (preset && preset.instructions) {
          selectedSystemPrompt = `${selectedSystemPrompt}\n\n${preset.instructions}`;
        }
      } catch (presetErr) {
        console.warn("Failed to apply preset:", presetErr.message || presetErr);
      }
    }

    // Small server log for selected mode
    try {
      console.log(
        `Mana mode=${mode} session=${sessionId || "none"} system_prompt_snippet="${selectedSystemPrompt.slice(0, 160).replace(/\n/g, " ")}..."`,
      );
    } catch (e) {
      // don't block on logging
    }

    // Inject global BACKGROUND_MEMORY_BLOCK (loaded at startup) directly under the system instructions
    try {
      if (BACKGROUND_MEMORY_BLOCK) {
        selectedSystemPrompt = `${selectedSystemPrompt}\n\n${BACKGROUND_MEMORY_BLOCK}`;
      }
    } catch (e) {
      // ignore failures here
    }

    // Load short session memory (if provided) and inject into the system
    // prompt -- this is the small, hard-capped "always in context" tier
    // (bounded by maxPromptTokens in acp-memory-store.js, same pattern as
    // BACKGROUND_MEMORY_BLOCK above).
    let memoryBlock = "";
    try {
      if (sessionId) {
        try {
          memoryBlock =
            (await acpMemoryStore.buildPromptMemory(sessionId)) || "";
          if (memoryBlock) {
            memoryBlock = memoryBlock.trim();
            memoryBlock = "Conversation memory:\n" + memoryBlock + "\n\n";
          }
        } catch (memErr) {
          console.warn("Failed to build session memory:", memErr.message);
          memoryBlock = "";
        }
      }
    } catch (e) {
      console.warn("ACP memory unavailable:", e.message);
      memoryBlock = "";
    }
    if (memoryBlock) {
      selectedSystemPrompt = `${selectedSystemPrompt}\n\n${memoryBlock.trim()}`;
    }

    // Issue #141: the larger, on-demand tier -- only pulled in when the
    // current message actually names something previously discussed in a
    // *different* session. Bounded by maxChars in getRelatedFacts, so it
    // never grows with total memory volume.
    try {
      if (typeof acpMemoryStore.getRelatedFacts === "function") {
        const relatedFacts = acpMemoryStore.getRelatedFacts(transcript, {
          excludeSessionId: sessionId,
        });
        if (relatedFacts) {
          selectedSystemPrompt = `${selectedSystemPrompt}\n\n${relatedFacts}`;
        }
      }
    } catch (relErr) {
      console.warn("Failed to look up related facts:", relErr.message);
    }

    // Attempt retrieval from local retriever-index (fast) first. If it yields nothing, fall back to the existing HTTP or legacy Python retrievers.
    // Repository retrieval helps coding questions; casual chat just gets
    // polluted by random repo snippets. Override with MANA_RETRIEVAL_MODES
    // (comma-separated modes, e.g. "coding,everyday").
    let retrievedText = "";
    const retrievalModes = String(process.env.MANA_RETRIEVAL_MODES || "coding")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    try {
      if (!retrievalModes.includes(String(mode || "").toLowerCase())) {
        throw Object.assign(new Error("retrieval skipped for this mode"), {
          retrievalSkipped: true,
        });
      }
      try {
        const retrieverIndex = require("./tools/retriever-index");
        const idx =
          retrieverIndex.loadIndexSync && retrieverIndex.loadIndexSync();
        if (idx && Array.isArray(idx.entries) && idx.entries.length) {
          try {
            let hits = null;
            try {
              const vsModule = require("./tools/vector-store");
              const createStore =
                vsModule && vsModule.createStore ? vsModule.createStore : null;
              if (createStore) {
                const store = createStore({
                  dir:
                    process.env.VECTOR_STORE_DIR ||
                    path.join(__dirname, "..", "tools", "vector_store"),
                });
                await store.init();
                await store.load();
                const cnt = (await store.count().catch(() => 0)) || 0;
                if (
                  cnt > 0 &&
                  typeof retrieverIndex.computeEmbedding === "function"
                ) {
                  try {
                    const qembed =
                      await retrieverIndex.computeEmbedding(transcript);
                    if (qembed) {
                      const s = await store.search(qembed, 5);
                      if (Array.isArray(s) && s.length) {
                        // Issue #217: this vector-store-direct fast path used
                        // to duplicate the read-file-then-slice(0, 800) loop
                        // retriever-index.js's search() itself replaced with
                        // buildSnippets() in issue #211 -- meaning whenever
                        // this fast path succeeded (the common case once a
                        // vector store exists), #211's compression never
                        // actually ran. Reusing the same shared helper here
                        // closes that gap.
                        const candidates = s.map((it) => ({
                          id: it.id,
                          path: it.path || it.id,
                          score: it.score,
                        }));
                        hits = await retrieverIndex.buildSnippets(
                          candidates,
                          transcript,
                          compressExcerpts,
                        );
                      }
                    }
                  } catch (e) {
                    hits = null;
                  }
                }
              }
            } catch (e) {
              hits = null;
            }

            if (!hits)
              hits = await retrieverIndex.search(transcript, 5, {
                compress: compressExcerpts,
              });
            if (Array.isArray(hits) && hits.length) {
              const maxChars = Number(process.env.RETRIEVER_MAX_CHARS || 3000);
              const pieces = [];
              let acc = 0;
              for (let i = 0; i < hits.length; i++) {
                const h = hits[i];
                const chunk = (h.snippet || "").trim();
                const header = `Source: ${h.path} [score ${h.score}]\n`;
                const snippet = header + chunk + "\n\n";
                if (acc + snippet.length > maxChars) {
                  break;
                }
                pieces.push(
                  `--- Retrieved snippet ${i + 1} ---\n${snippet}--- End snippet ${i + 1} ---`,
                );
                acc += snippet.length;
                if (pieces.length >= 5) break;
              }
              if (pieces.length) {
                retrievedText =
                  "Retrieved repository context:\n\n" +
                  pieces.join("\n\n") +
                  "\n\n";
              }
            }
          } catch (riErr) {
            console.warn(
              "retriever-index.search failed:",
              riErr && riErr.message ? riErr.message : riErr,
            );
          }
        }
      } catch (loadErr) {
        // retriever-index not available or failed to load; continue to HTTP/Python retriever
      }

      // If retriever-index produced results, skip the heavier HTTP/python retrievers
      if (!retrievedText) {
        const retrieverUrl =
          process.env.RETRIEVER_URL || "http://127.0.0.1:9000/retrieve";
        try {
          // try HTTP retriever first
          const resp = await fetch(retrieverUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: transcript, k: 5 }),
          });
          if (resp.ok) {
            try {
              const hits = await resp.json();
              if (Array.isArray(hits) && hits.length) {
                const maxChars = Number(
                  process.env.RETRIEVER_MAX_CHARS || 3000,
                );
                const pieces = [];
                let acc = 0;
                for (let i = 0; i < hits.length; i++) {
                  const h = hits[i];
                  const meta = h.meta || {};
                  const chunk = (meta.text || meta.preview || "").trim();
                  const header = `Source: ${meta.path} [chars ${meta.start_char}-${meta.end_char}]\n`;
                  const snippet = header + chunk + "\n\n";
                  if (acc + snippet.length > maxChars) {
                    break;
                  }
                  pieces.push(
                    `--- Retrieved snippet ${i + 1} ---\n${snippet}--- End snippet ${i + 1} ---`,
                  );
                  acc += snippet.length;
                  if (pieces.length >= 5) break;
                }
                if (pieces.length) {
                  retrievedText =
                    "Retrieved repository context:\n\n" +
                    pieces.join("\n\n") +
                    "\n\n";
                }
              }
            } catch (pe) {
              console.warn(
                "Failed to parse retriever HTTP response:",
                pe.message,
              );
            }
          } else {
            console.warn(
              "Retriever HTTP returned status",
              resp.status,
              resp.statusText,
            );
          }
        } catch (httpErr) {
          // HTTP retriever failed; attempt legacy python subprocess retriever for compatibility
          try {
            const vectorDir =
              process.env.VECTOR_STORE_DIR ||
              path.join(__dirname, "..", "tools", "vector_store");
            const pythonBin = process.env.PYTHON_BIN || "python";
            const retrieverScript = path.join(
              __dirname,
              "..",
              "tools",
              "retriever.py",
            );
            if (fs.existsSync(vectorDir) && fs.existsSync(retrieverScript)) {
              const args = [
                retrieverScript,
                "--index",
                vectorDir,
                "--query",
                transcript,
                "--k",
                "5",
              ];
              const r = spawnSync(pythonBin, args, {
                encoding: "utf8",
                maxBuffer: 20 * 1024 * 1024,
              });
              if (!r.error && r.status === 0 && r.stdout) {
                try {
                  const hits = JSON.parse(r.stdout);
                  if (Array.isArray(hits) && hits.length) {
                    const maxChars = Number(
                      process.env.RETRIEVER_MAX_CHARS || 3000,
                    );
                    const pieces = [];
                    let acc = 0;
                    for (let i = 0; i < hits.length; i++) {
                      const h = hits[i];
                      const meta = h.meta || {};
                      const chunk = (meta.text || meta.preview || "").trim();
                      const header = `Source: ${meta.path} [chars ${meta.start_char}-${meta.end_char}]\n`;
                      const snippet = header + chunk + "\n\n";
                      if (acc + snippet.length > maxChars) {
                        break;
                      }
                      pieces.push(
                        `--- Retrieved snippet ${i + 1} ---\n${snippet}--- End snippet ${i + 1} ---`,
                      );
                      acc += snippet.length;
                      if (pieces.length >= 5) break;
                    }
                    if (pieces.length) {
                      retrievedText =
                        "Retrieved repository context:\n\n" +
                        pieces.join("\n\n") +
                        "\n\n";
                    }
                  }
                } catch (pe) {
                  console.warn(
                    "Failed to parse retriever subprocess output:",
                    pe.message,
                  );
                }
              } else if (r.error) {
                console.warn(
                  "Retriever subprocess spawn error:",
                  r.error.message,
                );
              } else if (r.status !== 0) {
                console.warn(
                  "Retriever subprocess exited with status",
                  r.status,
                );
              }
            }
          } catch (subErr) {
            console.warn("Subprocess retriever failed:", subErr.message);
          }
        }
      }
    } catch (e) {
      if (!e || !e.retrievalSkipped) {
        console.warn("Vector retriever failed:", e.message);
      }
    }

    const finalPrompt = (retrievedText || "") + prompt;

    // Try OpenAI/proxy only when explicitly allowed.
    if (shouldUseRemoteAi()) {
      try {
        const openAiReply = await runOpenAIReply(
          finalPrompt,
          LLAMA_MAX_TOKENS,
          selectedSystemPrompt,
        );
        if (openAiReply) {
          console.log("Using OpenAI proxy reply.");
          queueVTubeReaction(openAiReply);
          try {
            if (
              sessionId &&
              acpMemoryStore &&
              typeof acpMemoryStore.appendTurn === "function"
            ) {
              // fire-and-forget but log failures
              acpMemoryStore
                .appendTurn({
                  sessionId,
                  user: transcript,
                  assistant:
                    typeof openAiReply === "string" &&
                    typeof cleanLlamaOutput === "function"
                      ? cleanLlamaOutput(openAiReply)
                      : openAiReply,
                })
                .catch((memErr) =>
                  console.warn(
                    "Failed to append turn to ACP memory:",
                    memErr?.message || memErr,
                  ),
                );
            }
          } catch (memErr) {
            console.warn(
              "Failed to append turn to ACP memory:",
              memErr.message,
            );
          }
          return openAiReply;
        }
      } catch (e) {
        console.warn(
          "OpenAI proxy failed, falling back to local llama:",
          e.message,
        );
      }
    }

    // Foundational tool-calling (issue #51), opt-in and scoped to the one
    // profile that's actually been verified to emit reliable tool_calls
    // (Qwen3-4B / "default" -- see docs/roadmap/issue-51-tool-calling.md).
    // Any failure or empty result falls straight back to the plain path
    // rather than surfacing a broken reply.
    const toolCallingEnabled =
      String(process.env.MANA_TOOL_CALLING_ENABLED || "0") === "1";
    // Captured here rather than threaded through replyMaybeWithBestOfN's and
    // the verify/retry loop's return values (both currently just `string`)
    // -- issue #153 needs whatever tool calls actually produced the reply
    // that gets appended to session memory, and a closure-scoped variable
    // gets that without changing any other reply path's signature.
    let lastToolCalls = [];
    async function replyMaybeWithTools(promptText) {
      lastToolCalls = [];
      if (
        toolCallingEnabled &&
        normalizedModelProfile === "default" &&
        isLlamaServerAvailable()
      ) {
        try {
          // Issue #169: merged fresh per reply, not cached -- MCP tool
          // discovery is async and the registered-server list is small
          // enough that re-listing costs little once a connection is
          // already established (see mcp-client-registry.js).
          let mergedToolPolicy = await buildToolPolicyWithMcp(activeToolPolicy, activeMcpClientRegistry);
          // Issue #198: bound to this reply's sessionId (not model-supplied),
          // built fresh per reply for the same reason -- cheap, and the
          // session the fact should be attributed to only exists per-call.
          // approvalGate: a model-asserted memory write is agent-authored
          // content same as a skill write (issue #152) -- gated the same
          // way, see ai/memory-tool-source.js.
          mergedToolPolicy = await buildToolPolicyWithMemory(
            mergedToolPolicy,
            createMemoryToolSource({ acpMemoryStore, sessionId, approvalGate: activeApprovalGate }),
          );
          // Full-text search across past conversations, independent of
          // the curated memory summary above.
          mergedToolPolicy = await buildToolPolicyWithSessionSearch(
            mergedToolPolicy,
            createSessionSearchToolSource({ acpMemoryStore, sessionId }),
          );
          // User-requested skill creation mid-conversation ("make a skill
          // that does X") -- distinct from the idle-triggered autonomous
          // proposal pass (issue #262's runSkillProposal), which nobody
          // explicitly asked for. Despite the direct ask, this still stays
          // genuinely pending like the idle pass does, not auto-approved
          // like the Settings UI's own create flow -- the drafted content
          // is the model's own text, not the user's verbatim words, and a
          // page Mana read earlier in the same turn could otherwise talk
          // it into staging attacker-authored content (see
          // ai/skill-tool-source.js).
          mergedToolPolicy = await buildToolPolicyWithSkillCreate(
            mergedToolPolicy,
            createSkillToolSource({ approvalGate: activeApprovalGate }),
          );
          // Issue #188: only offered when the plugin is actually enabled
          // (Settings > Plugins) -- same gate every other browser-automation
          // entry point (its own HTTP routes, GET /plugins) already respects.
          if (isPluginEnabled(browserAutomationPlugin, activePluginSettingsStore)) {
            mergedToolPolicy = await buildToolPolicyWithBrowserAutomation(
              mergedToolPolicy,
              activeBrowserAutomationToolSource,
            );
          }
          // Issue #188: applied last so it catches every tool call from
          // every source (local read_file, browser-automation, MCP) in one
          // shared audit/trace log.
          mergedToolPolicy = wrapWithToolCallLog(mergedToolPolicy, activeToolCallLog);
          const toolResult = await runToolAwareReply(
            promptText,
            mergedToolPolicy,
            {
              maxTokens: LLAMA_MAX_TOKENS,
              profile: normalizedModelProfile,
              overrideSystemPrompt: selectedSystemPrompt,
            },
          );
          if (toolResult.content && toolResult.content.trim()) {
            if (toolResult.toolCalls.length) {
              lastToolCalls = toolResult.toolCalls;
              console.log(
                `Mana tool-calling (${toolResult.rounds} round(s)): ${toolResult.toolCalls
                  .map((call) => `${call.name}(${call.ok ? "ok" : "error"})`)
                  .join(", ")}`,
              );
            }
            return toolResult.content;
          }
          console.warn(
            "Tool-aware reply returned empty content; falling back to the plain reply path",
          );
        } catch (e) {
          console.warn(
            "Tool-aware reply failed, falling back to plain reply:",
            e && e.message ? e.message : e,
          );
        }
      }
      return runLocalAssistantReply(
        promptText,
        LLAMA_MAX_TOKENS,
        normalizedModelProfile,
        selectedSystemPrompt,
      );
    }

    // Best-of-N self-voting (issue #70), opt-in and scoped to coding-mode
    // replies. Layers on top of replyMaybeWithTools rather than replacing
    // the reply pipeline: on any failure or empty result it falls through
    // to the same tool-calling-or-plain path above, and the existing
    // verify/retry pass below still gates whatever reply comes out of here,
    // exactly as it already does for every other reply path.
    const bestOfNEnabled =
      String(process.env.MANA_BEST_OF_N_ENABLED || "0") === "1";
    async function replyMaybeWithBestOfN(promptText) {
      if (
        bestOfNEnabled &&
        mode === "coding" &&
        isLlamaServerAvailable()
      ) {
        try {
          const n = Number(process.env.MANA_BEST_OF_N_COUNT || 3);
          const result = await runBestOfNReply(promptText, {
            n,
            maxTokens: LLAMA_MAX_TOKENS,
            profile: normalizedModelProfile,
            overrideSystemPrompt: selectedSystemPrompt,
          });
          if (result.content && result.content.trim()) {
            // Issue #159: rather than trusting the judge's pick blindly,
            // prefer whichever already-generated candidate is least
            // similar to Mana's recent replies in this session -- no
            // extra network call, since Best-of-N already paid for all N.
            let selected = { content: result.content, index: result.judgeIndex, switched: false };
            if (sessionId && acpMemoryStore && result.candidates.length > 1) {
              const recentReplies = (acpMemoryStore.getSession(sessionId)?.turns || [])
                .map((t) => t.assistant)
                .filter(Boolean);
              selected = rutDetector.pickLeastRepetitive(
                sessionId,
                result.candidates,
                result.judgeIndex,
                recentReplies,
              );
              if (selected.switched) {
                console.log(
                  `Mana rut detection: swapped judge's pick for candidate ${selected.index + 1}/${result.candidates.length} (less repetitive)`,
                );
              }
            }
            console.log(
              `Mana best-of-N: judge picked candidate ${result.judgeIndex + 1}/${result.candidates.length}`,
            );
            return selected.content;
          }
          console.warn(
            "Best-of-N reply returned empty content; falling back to the plain reply path",
          );
        } catch (e) {
          console.warn(
            "Best-of-N reply failed, falling back to plain reply:",
            e && e.message ? e.message : e,
          );
        }
      }
      return replyMaybeWithTools(promptText);
    }

    // Fall back to local llama
    let reply = await replyMaybeWithBestOfN(finalPrompt);

    // Conversational rut detection (issue #159), general reply path: the
    // Best-of-N branch above already prefers a less-repetitive candidate
    // when one exists, but every reply -- Best-of-N or not -- funnels
    // through here, so this is where casual/everyday replies (where
    // verbal-tic repetition actually shows up) get covered too. Only one
    // regeneration attempt, with an explicit nudge -- if that's still a
    // rut, send it rather than looping.
    try {
      const rutEnabled = String(process.env.MANA_RUT_DETECTION_ENABLED || "1") === "1";
      if (rutEnabled && sessionId && acpMemoryStore && typeof reply === "string") {
        const recentReplies = (acpMemoryStore.getSession(sessionId)?.turns || [])
          .map((t) => t.assistant)
          .filter(Boolean);
        const check = rutDetector.checkReply(sessionId, reply, recentReplies);
        if (check.isRut) {
          const nudgedPrompt = `${finalPrompt}\n\nYour last several replies have repeated similar phrasing. Say this differently -- vary your wording and sentence structure instead of reusing recent lines.`;
          const regenerated = await replyMaybeWithBestOfN(nudgedPrompt);
          if (typeof regenerated === "string" && regenerated.trim()) {
            reply = regenerated;
            rutDetector.recordIntervention(sessionId);
            console.log("Mana rut detection: regenerated a repetitive reply with a phrasing nudge");
          }
        }
      }
    } catch (e) {
      console.warn("Rut detection check failed:", e?.message || e);
    }
    queueVTubeReaction(reply);

    // Token-budget accounting: estimate reply tokens and deduct from session budget
    try {
      const talkBudget = require("./utils/talk_budget");
      try {
        const tokenCount =
          await require("./tools/python_token_cache.async").countTokensForText(
            typeof reply === "string" ? reply : String(reply),
            ".py",
            false,
          );
        const sessionKey = sessionId || "global";
        const consumeRes = talkBudget.consumeTokens(sessionKey, tokenCount);
        if (!consumeRes.ok) {
          console.warn(
            `Talk budget exceeded for session ${sessionKey}: attempted ${tokenCount} tokens, remaining ${consumeRes.remaining}`,
          );
        }
        // record perf metric (perfMetrics.operations is a label->stats map,
        // same shape logPerf uses; GET /perf/status returns it as-is)
        perfMetrics.operations.reply_token_usage = {
          lastTokens: tokenCount,
          session: sessionKey,
          updatedAt: new Date().toISOString(),
        };
      } catch (e) {
        console.warn("Failed to account for reply tokens:", e?.message || e);
      }
    } catch (e) {
      // if talk budget module missing, skip
    }

    // Optional verification and auto-retry logic
    try {
      const { verifyReply } = require("./utils/reply-verifier");
      const verifyEnabled =
        String(process.env.MANA_VERIFY_REPLY || "0") === "1";
      const autoRetry =
        String(process.env.MANA_AUTO_RETRY_VERIFICATION || "0") === "1";
      const maxRetries = Number(process.env.MANA_VERIFY_MAX_RETRIES || 1);

      if (verifyEnabled) {
        let attempts = 0;
        while (true) {
          attempts += 1;
          const verification = await verifyReply(
            typeof reply === "string" ? reply : String(reply),
            assistantMode || "everyday",
          );
          if (verification.ok) {
            // verified
            break;
          }

          console.warn("Reply verification failed:", verification.issues);
          if (autoRetry && attempts <= maxRetries) {
            // Ask the model to fix its previous reply
            const fixPrompt =
              finalPrompt +
              "\n\nThe assistant produced a reply that failed verification.\nPlease regenerate the reply and fix the following issues:\n" +
              verification.issues
                .map((i) => `- ${i.type}: ${i.message}`)
                .join("\n") +
              "\nReturn only the reply.";
            console.log(
              "Attempting auto-retry of assistant reply (attempt",
              attempts,
              ")",
            );
            try {
              reply = await replyMaybeWithBestOfN(fixPrompt);
              queueVTubeReaction(reply);
              continue; // re-verify
            } catch (retryErr) {
              console.warn("Auto-retry failed:", retryErr?.message || retryErr);
              break;
            }
          }

          break;
        }
      }
    } catch (e) {
      console.warn("Reply verification unavailable:", e?.message || e);
    }

    // Anti-formulaic-phrasing rewrite pass (issue #160): runs last, right
    // before the reply is recorded/returned, since the verify/retry loop
    // above can still replace `reply` wholesale -- this needs to see
    // whatever text will actually be spoken, not an intermediate draft.
    try {
      const phrasingEnabled =
        String(process.env.MANA_PHRASING_VARIATION_ENABLED || "1") === "1";
      if (phrasingEnabled && sessionId && typeof reply === "string") {
        const check = phrasingVariator.checkReply(sessionId, reply);
        if (check.isPredictable) {
          const alt = await rewritePhrase(check.match.matchedText, {
            synthesize: (prompt) =>
              runLocalAssistantReply(
                prompt,
                40,
                normalizedModelProfile,
                "You are a concise writing assistant. Follow instructions exactly and reply with only what was asked for.",
              ),
          });
          if (alt && alt.trim() && alt.toLowerCase() !== check.match.matchedText.toLowerCase()) {
            reply = reply.replace(check.match.matchedText, alt.trim());
            console.log("Mana phrasing variation: rewrote a repeated catchphrase/opener");
          }
        }
        const finalMatch = phrasingVariator.findLexiconMatch(reply);
        if (finalMatch) phrasingVariator.recordUsage(sessionId, finalMatch.id);
      }
    } catch (e) {
      console.warn("Phrasing variation check failed:", e?.message || e);
    }

    try {
      if (
        sessionId &&
        acpMemoryStore &&
        typeof acpMemoryStore.appendTurn === "function"
      ) {
        acpMemoryStore
          .appendTurn({
            sessionId,
            user: transcript,
            assistant:
              typeof reply === "string" &&
              typeof cleanLlamaOutput === "function"
                ? cleanLlamaOutput(reply)
                : reply,
            toolCalls: lastToolCalls,
          })
          .catch((memErr) =>
            console.warn(
              "Failed to append turn to ACP memory:",
              memErr?.message || memErr,
            ),
          );
      }
    } catch (memErr) {
      console.warn("Failed to append turn to ACP memory:", memErr.message);
    }
    return reply;
  }

  registerCoreRoutes(app, upload, {
    UNIVERSALIS_DEFAULT_WORLD,
    TTS_PROVIDER,
    SCREEN_CONTEXT_MAX_CHARS,
    restartController: deps.restartController || createRestartController(),
    buildAssistantReply: deps.buildAssistantReply || buildAssistantReply,
    capabilities,
    pluginSettingsStore: activePluginSettingsStore,
    contributePluginPromptContext:
      deps.contributePluginPromptContext || contributePluginPromptContext,
    cleanupUploadedAudio: deps.cleanupUploadedAudio || cleanupUploadedAudio,
    clampInteger,
    clampText,
    fs,
    getActiveModelProfile: () => modelManagement.getActiveProfile(),
    marketDataClient,
    jobApplicationsStore,
    normalizeLlamaModelProfile,
    normalizeUploadedAudio:
      deps.normalizeUploadedAudio || normalizeUploadedAudio,
    readScreenText: deps.readScreenText || readScreenText,
    recordChatTurn:
      deps.recordChatTurn ||
      ((sessionId, userText, assistantText) => {
        try {
          if (
            sessionId &&
            acpMemoryStore &&
            typeof acpMemoryStore.appendTurn === "function"
          ) {
            acpMemoryStore
              .appendTurn({
                sessionId,
                user: userText,
                assistant: assistantText,
              })
              .catch((memErr) =>
                console.warn(
                  "Failed to append vision turn to ACP memory:",
                  memErr?.message || memErr,
                ),
              );
          }
        } catch (memErr) {
          console.warn(
            "Failed to append vision turn to ACP memory:",
            memErr?.message || memErr,
          );
        }
      }),
    runVisionReply:
      deps.runVisionReply ||
      ((prompt, images, maxTokens) =>
        llamaServerRuntime.runVisionReply(prompt, images, maxTokens)),
    getVisionStatus:
      deps.getVisionStatus || (() => llamaServerRuntime.getVisionStatus()),
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
    deviceStore: deps.deviceStore,
    buildAssistantReply: deps.buildAssistantReply || buildAssistantReply,
    synthesizeReply: deps.synthesizeReply || synthesizeReply,
    runWhisper: deps.runWhisper || runWhisper,
    normalizeUploadedAudio:
      deps.normalizeUploadedAudio || normalizeUploadedAudio,
    cleanupUploadedAudio: deps.cleanupUploadedAudio || cleanupUploadedAudio,
    mobileUnlockRateLimiter: deps.mobileUnlockRateLimiter,
    mobileUnlockRateLimit: deps.mobileUnlockRateLimit,
  });

  // Auth middleware: check Authorization header for protected routes
  function authMiddleware(req, res, next) {
    const authHeader = req.get("Authorization") || "";
    // Plain prefix-check instead of /^Bearer\s+(.+)$/ -- \s+ and .+ both
    // match spaces, so a header of many repeated spaces gave the regex
    // engine a quadratic number of equivalent ways to split them.
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }
    const auth = authStore.validateKey(token);
    if (!auth) {
      return res.status(401).json({ error: "Invalid API key" });
    }
    req.user = auth;
    next();
  }

  // Admin-only middleware for account create/revoke (must run after
  // authMiddleware, which sets req.user). Account management is more
  // sensitive than the read-only /api/memory routes -- which are
  // intentionally remote-accessible by design, per issue #93 -- so it gets
  // an extra layer beyond just "the API key has role=admin": same
  // local-unless-explicit-token pattern this codebase already uses for
  // /admin/restart (see isLocalRestartRequest, which also accounts for a
  // LAN tunnel terminating on loopback but forwarding from elsewhere), so a
  // leaked admin API key alone isn't enough to manage accounts remotely.
  function requireAdmin(req, res, next) {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin role required" });
    }
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
    if (ADMIN_TOKEN && req.get("x-admin-token") === ADMIN_TOKEN) {
      return next();
    }
    if (isLocalRestartRequest(req)) {
      return next();
    }
    return res.status(403).json({
      error:
        "admin-only: request must be local, or present a valid ADMIN_TOKEN via the x-admin-token header",
    });
  }

  // GET /api/memory — return Mana's consolidated memory to any authenticated
  // key (admin or user role). Mana has one shared memory store, not
  // per-account partitions, so this is the same content for every valid key;
  // the role only gates the /admin/* account-management routes below. See
  // docs/API_KEYS.md "Account Roles".
  app.get("/api/memory", authMiddleware, async (req, res) => {
    try {
      const compacted =
        (BACKGROUND_MEMORY_META.lastCompacted &&
          BACKGROUND_MEMORY_META.lastCompacted.text) ||
        "";
      const facts = BACKGROUND_MEMORY_META.important_facts || [];
      const connections = BACKGROUND_MEMORY_META.connections || [];
      // Format memory as markdown with summary, facts, and connections
      const lines = [
        "# Mana Memory",
        "",
        `_Last updated: ${new Date().toISOString()}_`,
        "",
        "## Summary",
        "",
        compacted || "_(no summary yet)_",
      ];
      if (facts && facts.length) {
        lines.push("", "## Key Facts", "", ...facts.map((f) => `- ${f}`));
      }
      if (connections && connections.length) {
        lines.push("", "## Connections", "", ...connections.map((c) => `- ${c}`));
      }
      const markdown = lines.join("\n") + "\n";
      res.type("text/markdown").send(markdown);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // GET /api/memory/notes — same access as /api/memory, but split into one
  // note per cross-session entity (see buildMemoryNotes) for clients that
  // want to sync Mana's memory as a linked set of notes (e.g. the Obsidian
  // plugin) instead of one flat markdown blob.
  app.get("/api/memory/notes", authMiddleware, async (req, res) => {
    try {
      const entityIndexPath = path.join(
        acpMemoryStore.dataDir,
        "entity-index.json",
      );
      let entityIndex = {};
      if (fs.existsSync(entityIndexPath)) {
        entityIndex = JSON.parse(fs.readFileSync(entityIndexPath, "utf8") || "{}");
      }
      const facts = BACKGROUND_MEMORY_META.important_facts || [];
      const connections = BACKGROUND_MEMORY_META.connections || [];
      res.json(buildMemoryNotes(entityIndex, facts, connections));
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // POST /v1/chat/completions — OpenAI-compatible chat endpoint (issue #95),
  // so external tools (Obsidian Copilot, etc.) can point at Mana directly
  // instead of only talking to Mana's own bespoke routes. Proxies straight
  // through to the persistent llama-server's own OpenAI endpoint; unlike
  // runLocalAssistantReply this does not inject Mana's persona system
  // prompt, since external clients bring their own messages.
  app.post("/v1/chat/completions", authMiddleware, async (req, res) => {
    if (!llamaServerRuntime.isEnabled()) {
      return res.status(503).json({
        error: {
          message:
            "llama-server mode is disabled; /v1/chat/completions requires MANA_LLAMA_SERVER to be enabled (see docs/API_KEYS.md).",
        },
      });
    }
    try {
      const upstream = await llamaServerRuntime.proxyChatCompletion(req.body);
      res.status(upstream.status);
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.type(contentType);
      if (!upstream.body) {
        return res.end();
      }
      // proxyChatCompletion already scheduled the idle-shutdown timer when
      // the request was dispatched, but that only covers the time-to-first-byte:
      // fetch() resolves once headers arrive, so a slow SSE stream (stream:
      // true) can still outlive that timer while this pipe is mid-flight,
      // killing the persistent llama-server process out from under the
      // client. Reschedule once the response is actually done so the idle
      // window is measured from real completion, not dispatch time.
      res.on("close", () => llamaServerRuntime.scheduleIdleShutdown());
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) {
      res.status(502).json({ error: { message: e?.message || String(e) } });
    }
  });

  // POST /v1/embeddings — OpenAI-compatible embeddings endpoint (issue #95),
  // backed by the same local sentence-transformers embedder
  // (tools/local_embedder.py) Mana's own memory retriever uses. See
  // docs/API_KEYS.md for USE_EMBEDDINGS/RETRIEVER_EMBEDDER_* setup.
  app.post("/v1/embeddings", authMiddleware, async (req, res) => {
    const inputRaw = req.body && req.body.input;
    const inputs = Array.isArray(inputRaw) ? inputRaw : [inputRaw];
    if (!inputs.length || inputs.some((t) => typeof t !== "string" || !t)) {
      return res.status(400).json({
        error: { message: "input must be a string or array of non-empty strings" },
      });
    }
    try {
      const retrieverIndex = require("./tools/retriever-index");
      const embeddings = await retrieverIndex.computeEmbeddings(inputs);
      if (embeddings.some((e) => !Array.isArray(e))) {
        return res.status(503).json({
          error: {
            message:
              "Local embedder unavailable. Set USE_EMBEDDINGS=1 and run node-bot/tools/local_embedder.py (see docs/API_KEYS.md).",
          },
        });
      }
      res.json({
        object: "list",
        data: embeddings.map((embedding, index) => ({
          object: "embedding",
          embedding,
          index,
        })),
        model: process.env.RETRIEVER_EMBEDDER_MODEL || "all-MiniLM-L6-v2",
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    } catch (e) {
      res.status(500).json({ error: { message: e?.message || String(e) } });
    }
  });

  // GET /v1/models — OpenAI-compatible model list (issue #95): the chat
  // model llama-server would load for the default profile, plus the
  // embedding model the local embedder serves.
  app.get("/v1/models", authMiddleware, (req, res) => {
    const data = [];
    try {
      const chatModel = llamaServerRuntime.findLlamaModel("default");
      if (chatModel) {
        data.push({
          id: path.basename(chatModel),
          object: "model",
          created: 0,
          owned_by: "mana",
        });
      }
    } catch (e) {
      // No local chat model configured/found -- omit rather than fail the whole list.
    }
    data.push({
      id: process.env.RETRIEVER_EMBEDDER_MODEL || "all-MiniLM-L6-v2",
      object: "model",
      created: 0,
      owned_by: "mana",
    });
    res.json({ object: "list", data });
  });

  // Admin only: POST /admin/accounts — create a new account
  app.post("/admin/accounts", authMiddleware, requireAdmin, (req, res) => {
    try {
      const { email, role = "user" } = req.body;
      if (!email) {
        return res.status(400).json({ error: "email is required" });
      }
      const result = authStore.createAccount({ email, role });
      res.status(201).json({
        userId: result.userId,
        email: result.email,
        role: result.role,
        apiKey: result.apiKey,
        message: "Save your API key somewhere safe; it will not be shown again",
      });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // Admin only: GET /admin/accounts — list all accounts
  app.get("/admin/accounts", authMiddleware, requireAdmin, (req, res) => {
    try {
      const accounts = authStore.listAccounts();
      res.json(accounts);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Admin only: DELETE /admin/accounts/:userId — revoke an account
  app.delete("/admin/accounts/:userId", authMiddleware, requireAdmin, (req, res) => {
    try {
      authStore.deleteAccount(req.params.userId);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // Watched inbox folder for passive multimodal memory ingestion (issue
  // #76). deps.startMemoryInboxWatcher lets tests inject a fake and verify
  // the wiring without a real fs watcher; otherwise this is skipped under
  // test the same way the background memory jobs are (see the
  // NODE_ENV/NODE_TEST_CONTEXT guard near the top of this file) -- real
  // usage would spin up a watcher that's never closed once per test.
  const inboxWatcherOptions = {
    inboxDir:
      process.env.MANA_MEMORY_INBOX_DIR ||
      path.join(acpMemoryStore.dataDir, "inbox"),
    appendTurn: (input) => acpMemoryStore.appendTurn(input),
    runVisionReply: (prompt, images) =>
      llamaServerRuntime.runVisionReply(prompt, images),
    runWhisper: (filePath) => runWhisper(filePath),
  };
  if (deps.startMemoryInboxWatcher) {
    deps.startMemoryInboxWatcher(inboxWatcherOptions);
  } else if (
    process.env.NODE_ENV !== "test" &&
    !process.env.NODE_TEST_CONTEXT
  ) {
    try {
      const { createMemoryInboxWatcher } = require("./memory-inbox");
      createMemoryInboxWatcher(inboxWatcherOptions);
    } catch (e) {
      console.warn(
        "Memory inbox watcher failed to start:",
        e && e.message ? e.message : e,
      );
    }
  }
}

async function waitForPythonService(
  url,
  retries = Number(process.env.RETRIEVER_HEALTH_RETRIES || 60),
  delayMs = Number(process.env.RETRIEVER_HEALTH_DELAY_MS || 2000),
) {
  const spinnerChars = ["|", "/", "-", "\\"];

  function sleepWithSpinner(ms, prefix) {
    return new Promise((resolve) => {
      const start = Date.now();
      let idx = 0;
      const iv = setInterval(() => {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        const spin = spinnerChars[idx % spinnerChars.length];
        process.stdout.write(`\r${prefix} ${spin} (elapsed ${elapsed}s) `);
        idx += 1;
      }, 200);
      setTimeout(() => {
        clearInterval(iv);
        process.stdout.write("\r");
        resolve();
      }, ms);
    });
  }

  for (let i = 0; i < retries; i++) {
    try {
      const attempt = i + 1;
      console.log(
        `[Mana Boot] Checking Python retriever health (attempt ${attempt}/${retries}) -> ${url}`,
      );
      const resp = await fetch(url, { method: "GET" });
      if (resp.ok) {
        try {
          const body = await resp.json();
          console.log(
            `[Mana Boot] Retriever healthy: index_loaded=${body.index_loaded} model_loaded=${body.model_loaded} tokenizer=${body.tokenizer_type}`,
          );
        } catch (e) {
          console.log("[Mana Boot] Retriever responded OK");
        }
        return true;
      } else {
        try {
          const body = await resp.json();
          console.log(
            `[Mana Boot] Retriever not ready: ${resp.status} - ${body.details || JSON.stringify(body)}`,
          );
        } catch (e) {
          console.log(`[Mana Boot] Retriever not ready: ${resp.status}`);
        }
      }
    } catch (e) {
      console.log(`[Mana Boot] Retriever health check failed: ${e.message}`);
    }

    // show a spinning wait line while delaying
    await sleepWithSpinner(
      delayMs,
      `[Mana Boot] Waiting for retriever (${i + 1}/${retries})`,
    );
  }
  return false;
}

async function startServer() {
  const port = process.env.PORT || 5005;

  // The retriever only enriches replies (retrieval context, token counts) and
  // every caller has a heuristic fallback, so by default the backend starts
  // without it and reports its health in the background. Set
  // RETRIEVER_REQUIRED=1 to restore the old block-until-healthy behavior.
  const retrieverHealthUrl =
    process.env.RETRIEVER_HEALTH_URL || "http://127.0.0.1:9000/health";
  if (process.env.RETRIEVER_REQUIRED === "1") {
    const ok = await waitForPythonService(retrieverHealthUrl);
    if (!ok) {
      console.error(
        "[Mana Boot CRITICAL] Python retriever failed to become healthy in time.",
      );
      process.exit(1);
    }
  } else {
    (async () => {
      const retries = Number(process.env.RETRIEVER_HEALTH_RETRIES || 24);
      const delayMs = Number(process.env.RETRIEVER_HEALTH_DELAY_MS || 5000);
      for (let i = 0; i < retries; i += 1) {
        try {
          const resp = await fetch(retrieverHealthUrl, { method: "GET" });
          if (resp.ok) {
            console.log("[Mana Boot] Python retriever is healthy");
            return;
          }
        } catch (e) {
          // keep waiting quietly
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      console.warn(
        `[Mana Boot] Python retriever not reachable at ${retrieverHealthUrl}; continuing with heuristic fallbacks (retrieval context disabled).`,
      );
    })().catch(() => {});
  }

  const app = createApp();

  // Ensure admin account exists on first startup
  authStore.ensureAdminAccount();

  const http = require("http");
  const server = http.createServer(app);

  // attach caption websocket server
  try {
    const captionServer = require("./caption-server");
    captionServer.registerCaptionServer(server, { path: "/ws/captions" });
  } catch (e) {
    console.warn("Failed to register caption server:", e?.message || e);
  }

  // attach tray websocket server for live tray notifications
  try {
    const trayServer = require("./tray-server");
    trayServer.registerTrayServer(server, { path: "/ws/tray" });
    // make broadcast available via app locals for other modules
    app.locals.broadcastTrayNotification = trayServer.broadcastTrayNotification;
    try {
      const trayNotifier = require("./tray-notifier");
      trayNotifier.setBroadcaster(trayServer.broadcastTrayNotification);
    } catch (e) {
      // ignore if notifier cannot be wired
    }
  } catch (e) {
    console.warn("Failed to register tray server:", e?.message || e);
  }

  // serve admin UI static files
  app.get("/admin/token-cache-ui", (req, res) => {
    try {
      const f = path.join(__dirname, "admin", "token_cache_ui.html");
      if (!fs.existsSync(f)) return res.status(404).send("not found");
      return res.sendFile(f);
    } catch (e) {
      console.error("Failed to serve admin UI file:", e);
      return res.status(500).send("internal error");
    }
  });

  app.get("/admin/background-memory-ui", (req, res) => {
    try {
      const f = path.join(__dirname, "admin", "background_memory_ui.html");
      if (!fs.existsSync(f)) return res.status(404).send("not found");
      return res.sendFile(f);
    } catch (e) {
      console.error("Failed to serve admin UI file:", e);
      return res.status(500).send("internal error");
    }
  });

  app.get("/admin/accounts-ui", (req, res) => {
    try {
      const f = path.join(__dirname, "admin", "accounts_ui.html");
      if (!fs.existsSync(f)) return res.status(404).send("not found");
      return res.sendFile(f);
    } catch (e) {
      console.error("Failed to serve admin UI file:", e);
      return res.status(500).send("internal error");
    }
  });

  return server.listen(port, () =>
    console.log("Node local bot listening on", port),
  );
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error(
      "[Mana Boot CRITICAL] Startup aborted:",
      err && err.message ? err.message : err,
    );
    process.exit(1);
  });
}

module.exports = {
  createApp,
  buildMemoryNotes,
  ensureDirectory,
  formatMemoryMarkdown,
  normalizeLlamaModelProfile,
  pickPreferredLlamaModel,
  selectLlamaModelProfileForPrompt,
  shouldUseRemoteAi,
  startServer,
};
