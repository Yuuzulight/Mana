/*
Node backend server (server.js)
- POST /transcribe : accepts multipart 'file' audio, runs whisper.cpp to transcribe, then llama.cpp to generate a reply.
- POST /synthesize : accepts JSON { text } and returns WAV audio from the configured TTS tool.
- POST /screen/read : accepts a screenshot data URL and returns local OCR text.
- GET /health : basic health check

Environment variables (node-bot/.env, loaded at startup -- its values win
over inherited ones -- or set before running):
- WHISPER_BIN : full path to whisper.cpp main executable (e.g. C:\whisper.cpp\main.exe)
- WHISPER_MODEL : full path to whisper model file (e.g. models/ggml-base.en.bin)
- WHISPER_LANGUAGE : spoken language passed to whisper.cpp; when unset,
  Settings > Voice picks "en" (default) or "auto" (issue #926)
- WHISPER_PROMPT : replaces the initial prompt that biases transcription
  toward Mana's wake words, your name and your frequent terms (issue #667)
- WHISPER_VOCABULARY : comma-separated words whisper should know, added to
  that prompt right after your name (e.g. "Imouto, Oneesan, Gigi Murin,
  Hololive, VTuber"; issue #901). Ignored when WHISPER_PROMPT is set
- WHISPER_BEAM_SIZE, WHISPER_NO_SPEECH_THRESHOLD, WHISPER_TEMPERATURE :
  whisper.cpp decoding tuning knobs, see docs/speech_recognition_improvement_plan.md
- WHISPER_SERVER_BIN, WHISPER_SERVER_PORT : the whisper-server kept loaded for
  transcription (default: next to WHISPER_BIN, port 8093); whisper-cli is the fallback
- MANA_WHISPER_RELOAD : 1/0 forces whisper-server's model reload after each
  request on or off (default: on for the CPU build, off for the CUDA build)
- LLAMA_BIN : full path to llama.cpp/main executable (e.g. C:\llama.cpp\main.exe)
- LLAMA_MODEL : full path to a GGUF model file, or an HF repo shorthand like user/model:Q4_K_M
- TTS_PROVIDER : "cli", "kokoro", or "fish" (default: "fish" on a CUDA GPU
  with room for it, "kokoro" otherwise -- see resolveTtsProvider in
  tts-runtime.js and docs/fish_speech_tts.md for the S1-mini checkpoint)
- TTS_BIN : full path to your TTS executable
- TTS_MODEL : model path or model id for your TTS executable
- TTS_ARGS_JSON : optional JSON array of CLI args with placeholders like {text}, {output}, {model}, {voice}, {speaker}
- TTS_VOICE : optional voice value used by your TTS args
- TTS_SPEAKER : optional speaker value used by your TTS args
- KOKORO_TTS_URL : local Kokoro TTS microservice URL
- MANA_KOKORO_IDLE_MS : Kokoro is started on demand and stopped after this
  long without use (default 600000; 0 keeps it running)
- FISH_TTS_URL : local Fish Speech server URL
- FISH_TTS_API_KEY : optional Fish Speech bearer token
- FISH_TTS_REFERENCE_ID : optional saved (server-side) Fish Speech reference voice id
- FISH_TTS_REF_AUDIO, FISH_TTS_REF_TEXT : optional local reference clip path
  + its exact transcript, for zero-shot in-context voice cloning on every
  request (takes priority over FISH_TTS_REFERENCE_ID when both are set)
- FISH_TTS_FALLBACK_PROVIDER : "none" (default) or "kokoro"
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

// First, before any module below reads process.env at require time (e.g.
// tools/retriever-index.js's USE_EMBEDDINGS). Only when run as the server:
// tests that require() this file keep their own environment.
if (require.main === module) {
  const loadedEnvKeys = require("./load-env").loadEnvFile();
  if (loadedEnvKeys.length) {
    console.log(`Loaded ${loadedEnvKeys.length} settings from node-bot/.env`);
  }
  // #670: before anything below can open a connection.
  const localOnly = require("./local-only");
  if (localOnly.isLocalOnly()) {
    localOnly.installLocalOnlyGuard();
    console.log("[Mana Boot] Local-only mode is on: nothing leaves this PC and your local network.");
  }
}

const express = require("express");
const multer = require("multer");
const { uploadDestination, uploadTmpDir } = require("./utils/live-dirs");
const cors = require("cors");
const { createRequestGuard } = require("./request-guard");
const rateLimit = require("express-rate-limit");
const { spawnSync, spawn, execFile } = require("child_process");
const { promisify } = require("util");
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
	const {
  registerCoreRoutes,
  isLocalRestartRequest,
  isLocalAdminRequest,
  registerModelRoutes,
  registerEditorRoutes,
  registerAdminStaticRoutes,
  registerPendingWritesRoutes,
} = require("./server-routes");
	const { ADMIN_KEY_REQUIRED_ERROR, checkAdminSecret, hasAdminKey, requireAdminKeyByDefault } = require("./admin-key");
	const {
	  handleGetAddonStatus,
	  handleGenerateVideo,
	  handleAddonConsent,
	} = require("./routes/addons");
	const {
	  buildCapabilityHealth,
	  contributePluginPromptContext,
	  registerCapabilities,
	  isPluginEnabled,
	} = require("./capabilities/registry");
	const dirScannerCapability = require("./capabilities/dir-scanner-capability");
const cloudSyncCapability = require("./capabilities/cloud-sync-capability");
const scheduledExportCapability = require("./capabilities/scheduled-export-capability");
const structuredConnectorsCapability = require("./capabilities/structured-connectors-capability");
const {
  webAccessCapability,
} = require("./capabilities/web-access-capability");
const { sessionsCapability } = require("./capabilities/sessions-capability");
const { promptCompositionCapability } = require("./capabilities/prompt-composition-capability");
const { presetsCapability } = require("./capabilities/presets-capability");
const { personalityCapability } = require("./capabilities/personality-capability");
const { moodCapability } = require("./capabilities/mood-capability");
const {
  createResearchJobStore,
  deepResearchCapability,
} = require("./capabilities/deep-research-capability");
const { backgroundTasksCapability } = require("./capabilities/background-tasks-capability");
const {
  backgroundMemoryCapability,
} = require("./capabilities/background-memory-capability");
const {
  memoryFactsCapability,
} = require("./capabilities/memory-facts-capability");
const { memoryVaultCapability } = require("./capabilities/memory-vault-capability");
const {
  retrieverAdminCapability,
} = require("./capabilities/retriever-admin-capability");
const { skillsCapability } = require("./capabilities/skills-capability");
const { createSkillsStore } = require("./skills-store");
const { createApprovalGate } = require("./approval-gate");
const { judgeActionRisk } = require("./ai/guardian-precheck");
const {
  buildTypingPrompt: buildEntityTypingPrompt,
  parseTypingResponse: parseEntityTypingResponse,
  findMergeCandidates: findEntityMergeCandidates,
  buildMergeJudgePrompt: buildEntityMergeJudgePrompt,
  parseMergeVerdict: parseEntityMergeVerdict,
} = require("./entity-ontology");
const { createRutDetector } = require("./rut-detection");
const { createPhrasingVariator, rewritePhrase } = require("./phrasing-variation");
const { approvalGateCapability } = require("./capabilities/approval-gate-capability");
const {
  RESEARCH_SYSTEM_PROMPT,
  SUB_QUERY_SYSTEM_PROMPT,
  REFLECT_SYSTEM_PROMPT,
  COMPRESS_SYSTEM_PROMPT,
} = require("./tools/deep-research");
const { fetchPage, isWebAccessEnabled, searchWeb, wikiLookup } = require("./tools/web-access");
const { readGgufMetadata } = require("./tools/gguf-metadata");
const {
  DEFAULT_BIND_HOST,
  getBindHost,
  isLoopbackBindHost,
  runDoctorChecksAsync,
} = require("./doctor");
const { plainTextSecretKeys } = require("./load-env");
	const { createDoctorTrayPoller } = require("./doctor-tray-poll");
	const { notifyTray } = require("./tray-notifier");
	const sessionTokenUsage = require("./session-token-usage");
	const {
	  recordPromptComposition,
	  finalizePromptComposition,
	  contextFullNote,
	  getPromptComposition,
	  getMostRecentComposition,
	} = require("./prompt-composition-report");
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
	const matrixBridgePlugin = require("../plugins/matrix-bridge");
	const videoWatchPlugin = require("../plugins/video-watch");
	const contextPushPlugin = require("../plugins/context-push");
	const screenSensingPlugin = require("../plugins/screen-sensing");
const { PluginStore, pluginStore } = require("./plugin-store");
const { createTtsRuntime, resolveTtsProvider } = require("./tts-runtime");
const { createKokoroRuntime } = require("./kokoro-runtime");
const { createAcpMemoryStore } = require("./acp-memory-store");
const { createSnapshotStore } = require("./snapshot-store");
const { createSessionSearchIndex } = require("./session-search-index");
const { createMemoryGraph } = require("./memory-graph");
const { createSkillProposalRunner } = require("./skill-proposal");
const persona = require("./persona");
const { createPresetsStore } = require("./presets-store");
const {
  createPersonalityStore,
  DEFAULT_FILE_PATH: DEFAULT_PERSONALITY_FILE,
} = require("./personality-store");
const { createMoodStore, levelWord, moodPromptBlock } = require("./mood-store");
const { createCheckIns, gentleHint } = require("./check-ins");
const {
  createRelationshipStore,
  createRelationshipToolSource,
  relationshipPromptBlock,
} = require("./relationship-store");
const {
  characterFilePath,
  DEFAULT_ID: DEFAULT_CHARACTER_ID,
  createCharacterStore,
  defaultPromptOf,
  perCharacter,
  personaOf,
} = require("./characters");
const { createCharactersCapability } = require("./capabilities/characters-capability");
const { createRelationshipCapability } = require("./capabilities/relationship-capability");
const { createPluginSettingsStore } = require("./plugin-settings-store");
const { createAuthStore } = require("./auth-store");
const { createToolPolicy } = require("./ai/tool-policy");
// Issue #267: one generic composer instead of a buildToolPolicyWithX per
// tool source -- see ai/tool-source.js. Each create*ToolSource() factory
// below already returns the {listToolSchemas, executeTool, isKnownToolName}
// shape buildToolPolicy expects.
const { buildToolPolicy } = require("./ai/tool-source");
const { resolveToolApprovalMode, wrapWithRiskGate } = require("./ai/tool-risk");
const { untrustedLinks, untrustedSources } = require("./ai/untrusted-content");
const { createMemoryToolSource, createMemoryWriteExecutor } = require("./ai/memory-tool-source");
const { createMemoryVault } = require("./memory-vault");
const {
  loadSessionSummaries,
  runCompactorStage,
  runConnectionsStage,
  mergeUnique,
  reviewPlan,
} = require("./dream-mode");
const { createSessionSearchToolSource } = require("./ai/session-search-tool-source");
const { createSkillToolSource } = require("./ai/skill-tool-source");
const { createSnapshotToolSource } = require("./ai/snapshot-tool-source");
const { createExpressionToolSource, isExpressionToolName } = require("./ai/expression-tool-source");
const { createSpeechToolSource } = require("./ai/speech-tool-source");
const { createVisionToolSource } = require("./ai/vision-tool-source");
const { createSessionGoalToolSource } = require("./ai/session-goal-tool-source");
const { createReminderToolSource } = require("./ai/reminder-tool-source");
const { briefingLines: mailCalendarBriefingLines, createMailCalendarToolSource } = require("./ai/mail-calendar-tool-source");
const { createMailCalendarSettingsStore } = require("./mail-calendar-settings-store");
const { checkMail } = require("./imap-client");
const { checkCalendar } = require("./calendar-client");
const { createDesktopToolSource, registerFileMoveRestorer } = require("./ai/desktop-tool-source");
const { createDeepThinkingState, createDeepThinkingToolSource } = require("./ai/deep-thinking-tool-source");
const { visionCaptureBridge } = require("./vision-capture-bridge");
const { createCodingToolSource } = require("./ai/coding-tool-source");
const { createTryPrToolSource } = require("./ai/try-pr-tool-source");
const { createReverter } = require("./revert-pr");
const { createFolioUpdater, JOB_ACTION: FOLIO_UPDATE_ACTION } = require("./folio-update");
const { createSelfWork } = require("./self-work");
const { createGitToolSource } = require("./ai/git-tool-source");
const { refuteEdit } = require("./ai/adversarial-verifier");
const { createMcpClientRegistry } = require("./mcp-client-registry");
const { mcpClientCapability } = require("./capabilities/mcp-client-capability");
const { createToolCallLog, wrapWithToolCallLog } = require("./tool-call-log");
const { createAgentActivity } = require("./agent-activity");
const { filterRelevantTools, wrapWithResultDigest } = require("./ai/tool-context-guard");
const { toolCallLogCapability } = require("./capabilities/tool-call-log-capability");
const { terminalCapability } = require("./capabilities/terminal-capability");
const { terminalFeed } = require("./terminal-feed");
const { createHooksStore, wrapWithHooks, wrapWithInputHooks } = require("./hooks-store");
const { hooksCapability } = require("./capabilities/hooks-capability");
const { createPronunciationLexiconStore } = require("./pronunciation-lexicon-store");
const {
  pronunciationLexiconCapability,
} = require("./capabilities/pronunciation-lexicon-capability");
const {
  createBrowserAutomationToolSource,
} = require("../plugins/browser-automation/browser-automation-tool-source");
const { createEditorIntegrations } = require("./zed-integration");
const { createModelManagement } = require("./model-management");
const { createLlamaBuildManager } = require("./llama-builds");
const { createModelSettingsStore } = require("./model-settings-store");
const whisperDiscovery = require("./whisper-discovery");
const { createWhisperPromptProvider } = require("./whisper-prompt");
const { createSpeechVocabulary, resolveWhisperLanguage } = require("./speech-vocabulary");
const { applyCorrectionToClips, voiceDataDir } = require("./voice-data");
const { createBriefing } = require("./briefing");
const { loadGameWikis } = require("./game-wikis");
const {
  normalizeLlamaModelProfile,
  pickPreferredLlamaModel,
  selectLlamaModelProfileForPrompt,
  shouldUseRemoteAi: shouldUseRemoteAiCore,
  wantsThinkHarder,
} = require("./ai/local-ai");
const {
  createLocalLlamaRuntime,
  cleanLlamaOutput,
} = require("./ai/local-llama-runtime");
const { createLlamaServerRuntime } = require("./ai/llama-server-runtime");
const { createReranker } = require("./ai/reranker-runtime");
const { createEmbedder } = require("./ai/embedder-runtime");
const { createRetrieverRuntime } = require("./ai/retriever-runtime");
const { createWhisperServer, belowNormal } = require("./ai/whisper-server-runtime");
const { createGamingWatch } = require("./utils/gaming-watch");
const { streamedMatchesFinal } = require("./utils/reply-stream-diff");
const { EMOTION_TAG_PROMPT, stripEmotionTags, replyEmotion } = require("./utils/emotion-tags");
const { crisisInstruction, withCrisisInstruction } = require("./utils/crisis-check");
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
  // Issue #670: Host (DNS rebinding) + Origin (CSRF) guard, and CORS only
  // for the origins it allows -- see request-guard.js.
  const requestGuard = createRequestGuard(appEnv);
  app.use(requestGuard.middleware);
  app.use(cors(requestGuard.corsOptions));
  // Default deny: every route below needs an admin key unless admin-key.js
  // lists it as public. After cors() so browsers' preflights still work.
  app.use(requireAdminKeyByDefault(appEnv));
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
  // A user turn is starting (voice upload, live partial transcript, typed
  // reply): start the memory embedder/reranker now if they're cold, so
  // they load while whisper and prompt building run instead of the turn's
  // fact recall falling back past its budget. Never waits.
  app.use(["/transcribe", "/transcribe-only", "/transcribe-partial", "/reply"], (req, res, next) => {
    if (req.method === "POST") warmMemoryModels();
    next();
  });
  // Voice uploads are recordings of me: each one, and whatever ffmpeg and
  // whisper wrote next to it, is deleted once its request is over --
  // success, error or a dropped connection alike (multer's own routes and
  // mobile-routes.js's share this tmp dir). A dropped request's handler may
  // still be running, so that case is swept once more a bit later.
  app.use((req, res, next) => {
    res.once("close", () => {
      if (!req.file) return;
      deleteUploadFiles(req.file.path);
      if (!res.writableFinished) setTimeout(() => deleteUploadFiles(req.file.path), 2 * 60 * 1000).unref();
    });
    next();
  });
  	const upload = multer({ storage: multer.diskStorage({ destination: uploadDestination }) });

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
// Issue #269: opt-in profile for Deep Research's short/structured subtask
// calls (decompose, reflect) -- see the fuller reasoning where these
// closures are built. Off by default ("quality", matching prior behavior)
// because llama-server's model swap is multi-second and a reflect-cycle
// pass alternates enough that switching by default could cost more time
// than it saves.
const DEEP_RESEARCH_SUBTASK_PROFILE =
  process.env.MANA_DEEP_RESEARCH_SUBTASK_PROFILES === "1" ? "fast" : "quality";
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
// whisper.cpp's initial prompt comes from getWhisperPrompt (below
// acpMemoryStore, which it reads): Mana's wake words plus the user's name
// and frequent terms (issue #667, see whisper-prompt.js). Its language
// comes from whisperLanguage(), next to it (#926).
const WHISPER_BEAM_SIZE = process.env.WHISPER_BEAM_SIZE || "5";
const WHISPER_NO_SPEECH_THRESHOLD =
  process.env.WHISPER_NO_SPEECH_THRESHOLD || "0.45";
const WHISPER_TEMPERATURE = process.env.WHISPER_TEMPERATURE || "0";
// Opt-in alternate ASR engine (NVIDIA Parakeet via the same tools/whisper
// build) -- faster and slightly more accurate on English/European speech,
// but has no equivalent to whisper's initial-prompt biasing (wake words,
// names, terms), so whisper stays the default.
const STT_PROVIDER = (process.env.STT_PROVIDER || "whisper").toLowerCase();
const LLAMA_THREADS = Number(process.env.LLAMA_THREADS || 4);
const LLAMA_MAX_TOKENS = Number(process.env.LLAMA_MAX_TOKENS || 180);
// Coding replies run long -- a function plus explanation plus a usage
// example routinely exceeds the 180-token budget sized for spoken
// conversation, cutting code off mid-example. Casual/everyday replies stay
// at LLAMA_MAX_TOKENS; only coding/developer mode gets the bigger budget.
const LLAMA_MAX_TOKENS_CODING = Number(process.env.LLAMA_MAX_TOKENS_CODING || 768);
// #914: a group-mode reaction is about 60 tokens.
const GROUP_REACTION_MAX_TOKENS = 60;
const VTUBE_STUDIO_URL = process.env.VTUBE_STUDIO_URL || "ws://127.0.0.1:8001";
const VTUBE_STUDIO_ENABLED = process.env.VTUBE_STUDIO_ENABLED !== "0";
const VTUBE_STUDIO_REACTIONS_JSON =
  process.env.VTUBE_STUDIO_REACTIONS_JSON || "{}";
// #1076: decided once here; ttsRuntime and /health (which the native
// launcher follows) both use this value.
const TTS_PROVIDER = resolveTtsProvider(process.env);
const DEFAULT_GAMING_PROCESS_NAMES = [
  "ffxiv_dx11.exe",
  "ffxiv.exe",
  "ffxivboot.exe",
  "ffxivboot64.exe",
  "ffxivlauncher.exe",
  "ffxivlauncher64.exe",
];
// #908: the wikis game questions are answered from (data/game-wikis.json on
// top of game-wikis.js's defaults). #945: every game listed there is watched too.
const gameWikis = loadGameWikis(path.join(__dirname, "data", "game-wikis.json"));
const GAMING_PROCESS_NAMES = [
  ...new Set([...parseGamingProcessNames(process.env.GAMING_PROCESS_NAMES), ...gameWikis.processes]),
];
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
  // whisper-server runs for every partial transcript, hundreds a session:
  // its lines buried everything else in backend.log and Settings > Logs.
  // Its numbers are still in /perf/status.
  if (label !== "whisper-server") console.log(`Mana perf: ${label} ${durationMs}ms`);
}

configureFfxivMarketTools({ nowMs, logPerf });

// #914: a call without its own system prompt speaks as the active
// character (characterStore is created below, before any call).
const activeDefaultPrompt = () => defaultPromptOf(characterStore.active());

const localLlamaRuntime = createLocalLlamaRuntime({
  env: process.env,
  systemPrompt: activeDefaultPrompt,
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
  systemPrompt: activeDefaultPrompt,
  threads: LLAMA_THREADS,
  nowMs,
  logPerf,
  modelSettingsStore,
  // #872: a mid-game image keeps the mmproj for the short gaming idle.
  gaming: () => gamingWatch.isGaming(),
});

// #889: the chat model llama-server is running, for the tray and Doctor.
function chatModelLabel() {
  const { model, gamingModel } = llamaServerRuntime.getStatus();
  return model ? `${path.basename(model)}${gamingModel ? " (gaming model)" : ""}` : null;
}

// #754/#760: stop the memory embedder (~2.3 GB VRAM) and reranker (RAM) as
// soon as a watched game starts -- a turn during the game used to wake them
// for the full 1-hour idle. Polled in the background with a non-blocking
// tasklist (full path, like kill-process-tree.js: a bare name is looked up
// in the cwd first); the runtimes read the cached answer on every turn.
const gamingWatch = createGamingWatch({
  check: async () => {
    if (process.platform !== "win32") return false;
    const tasklist = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe");
    const { stdout } = await promisify(execFile)(tasklist, ["/fo", "csv", "/nh"], {
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });
    // #908: which one, for currentGame().
    return parseTasklistNames(stdout).find((name) => GAMING_PROCESS_NAMES.includes(name)) || false;
  },
  onGameStart: () => {
    console.log("Watched game started: stopping the memory embedder, reranker and Python retriever");
    embedder.stop();
    reranker.stop();
    retrieverService.stop();
    // #872/#889: drops the vision mmproj, and swaps to MANA_GAMING_LLAMA_MODEL when it's set.
    llamaServerRuntime.setGaming(true);
    // #914: group mode pauses; after this poll has recorded the game.
    queueMicrotask(() => characterStore.gameChanged());
  },
  onGameEnd: () => {
    llamaServerRuntime.setGaming(false);
    queueMicrotask(() => characterStore.gameChanged());
  },
});
if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
  gamingWatch.poll();
  setInterval(gamingWatch.poll, 30 * 1000).unref();
  // #697: proactive remarks held during play go out after the game, or
  // one in a break -- alt-tabbed out of the game (foreground.js).
  require("./proactive").watchGaming(gamingWatch.isGaming, () =>
    require("./foreground").isAwayFromGame(GAMING_PROCESS_NAMES),
  );
  setInterval(require("./proactive").flush, 30 * 1000).unref();
}

// Issue #674: optional CPU-only reranker for memory recall -- off unless
// MANA_RERANKER_MODEL names a local .gguf file. Same llama-server binary.
const reranker = createReranker({
  env: process.env,
  threads: LLAMA_THREADS,
  findServerBin: llamaServerRuntime.findLlamaServerBin,
  gaming: gamingWatch.isGaming,
});

// Optional GPU text embedder (llama.cpp) for semantic memory search -- off
// unless MANA_EMBEDDER_MODEL names a local .gguf file, in which case it
// replaces the RETRIEVER_EMBEDDER_URL (local_embedder.py) service.
const embedder = createEmbedder({
  env: process.env,
  findServerBin: llamaServerRuntime.findLlamaServerBin,
  supportsLoadMode: llamaServerRuntime.supportsLoadMode,
  gaming: gamingWatch.isGaming,
});
require("./tools/retriever-index").useEmbedder(embedder);

// The Python retriever (coding-mode fallback): started by the coding turn
// that needs it, stopped when idle (ai/retriever-runtime.js).
const retrieverService = createRetrieverRuntime({ gaming: gamingWatch.isGaming });

// Start both in the background (never awaited). The cold starts (~1-1.5 s
// embedder, ~3.5 s reranker) are longer than recall's budgets, so a cold
// first use would fall back to keyword matching.
function warmMemoryModels() {
  reranker.warm();
  require("./tools/retriever-index").warmEmbedder();
}

// #693: llama.cpp build updates/rollback (Settings > Model). Resolves the
// active build through the runtime so both agree on what "current" means.
const llamaBuilds = createLlamaBuildManager({
  findLlamaServerBin: llamaServerRuntime.findLlamaServerBin,
  // The reranker and embedder run the same build, so a switch restarts
  // them too.
  stopServer: () => {
    llamaServerRuntime.stop();
    reranker.stop();
    embedder.stop();
  },
});

// Unified local reply helper: prefer the persistent llama-server (model loads
// once, no per-call process spawn, event loop stays free); fall back to the
// one-shot llama-cli path when the server is unavailable or fails.
async function runLocalLlamaReply(
  prompt,
  maxTokens = 256,
  profile = "default",
  overrideSystemPrompt = null,
  extraMessages = null,
  // #666: chat turns pass this to try their backup model on an empty reply
  // before llama-cli; it resolves to a reply, or null to fall through.
  onEmptyReply = null,
  // #675: true forces thinking on for this reply (a "think harder" turn).
  thinking = undefined,
) {
  if (llamaServerRuntime.isEnabled()) {
    try {
      return await llamaServerRuntime.runLocalAssistantReply(
        prompt,
        maxTokens,
        profile,
        overrideSystemPrompt,
        extraMessages,
        null,
        thinking,
      );
    } catch (e) {
      if (onEmptyReply && /returned an empty reply/.test(e && e.message)) {
        const backupReply = await onEmptyReply();
        if (backupReply) return backupReply;
      }
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

// Item 2: created before ttsRuntime so it can be wired straight into it --
// synthesizeReply needs the current lexicon entries on every call.
const pronunciationLexiconStore = createPronunciationLexiconStore({});

// Kokoro isn't kept running (user decision): started on first use, e.g.
// the gaming override below, and stopped after MANA_KOKORO_IDLE_MS idle.
const kokoroRuntime = createKokoroRuntime({ env: process.env });

// Issue #914: the active character (Mana by default, remembered across
// restarts; in memory under tests). Created before ttsRuntime, which speaks
// in her voice; the launcher hears of each switch on /ws/tray, and of the
// current one when it connects, so it can load her Live2D model.
const characterEvent = (character) => ({
  type: "character",
  id: character.id,
  title: character.name,
  model: character.live2dModel,
});
const characterStore = createCharacterStore({
  activeFilePath:
    process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT
      ? null
      : path.join(__dirname, "data", "active-character.json"),
  onSwitch: (character) => notifyTray(characterEvent(character)),
  // Group mode: the launcher shows (or hides, id null) the partner's avatar.
  isGaming: () => gamingWatch.isGaming(),
  onGroupChange: (partner) =>
    notifyTray({
      type: "group",
      id: partner?.id ?? null,
      title: partner?.name ?? null,
      model: partner?.live2dModel ?? null,
    }),
});

const ttsRuntime = createTtsRuntime({
  env: process.env,
  ttsProvider: TTS_PROVIDER,
  getVoice: () => characterStore.active().voice,
  baseDir: __dirname,
  nowMs,
  logPerf,
  pronunciationLexiconStore,
  ensureKokoro: kokoroRuntime.ensure,
});

// Full-text search over past conversation turns -- an independent SQLite
// FTS5 index, not the source of truth for session content
// (acp-memory-store.js's own per-session JSON files still are).
const sessionSearchIndex = createSessionSearchIndex();

// Issue #295 (round-2 scoping of #285): a Hebbian associative graph over
// entity keys, reinforced on every appendTurn() and consulted as a second
// pass after searchSessions()'s hybrid keyword/semantic results. Always on
// (not opt-in like hybrid vector search) -- reinforcement is a cheap local
// SQLite upsert with no model call, and every consumer of it degrades
// gracefully to today's behavior on any failure.
const memoryGraph = createMemoryGraph();

// #426 sub-project 1: one shared snapshot/rollback store, threaded into
// every subsystem below that owns undoable state (memory sessions/facts
// here, skills a bit further down, editor file-edits via
// getEditorIntegrations) -- one store means one place to eventually list
// "everything that's undoable right now", not three disconnected pools.
const snapshotStore = createSnapshotStore({});
// #911: undoing a desktop__move_files moves the files back.
registerFileMoveRestorer(snapshotStore, visionCaptureBridge);

// ACP memory store (conversation/session memory)
const acpMemoryStore = createAcpMemoryStore({
  snapshotStore,
  sessionSearchIndex,
  memoryGraph,
  // Issue #263 part 1: same computeEmbeddings the coding-mode/Deep Research
  // file retriever already uses (tools/retriever-index.js) -- off by
  // default (USE_EMBEDDINGS env var), so hybrid session search is a pure
  // opt-in enhancement over the FTS5 keyword search above.
  computeEmbeddingsFn: require("./tools/retriever-index").computeEmbeddings,
  embeddingModelIdFn: require("./tools/retriever-index").embeddingModelId,
  rerankFn: reranker.rerank,
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

      if (shouldUseRemoteAi() && typeof runOpenAIReplyPublic === "function") {
        // runOpenAIReplyPublic accepts a maxTokens parameter (for the
        // model's output).
        // Issue #421: this summarizeFn's own sessionId IS a real per-user
        // session (acp-memory-store.js triggers it automatically once that
        // session's running summary crosses ~90% of maxSummaryTokens) --
        // unlike the reviewer/connections background jobs elsewhere in this
        // file, which fold every session's summaries together with no single
        // session in scope. Forwarding it here is what makes the token meter
        // and MANA_SESSION_TOKEN_STOP actually cover this session's real
        // spend, instead of undercounting it and letting compaction bypass
        // a session that's already been stopped.
        //
        // Calls through runOpenAIReplyPublic rather than a bare
        // runOpenAIReply reference: acpMemoryStore (and this summarizeFn) is
        // built at module load time, outside registerRoutes, but
        // runOpenAIReply only exists inside registerRoutes's scope -- a bare
        // reference here always threw ReferenceError, silently caught below,
        // permanently falling back to the stale summary. Same trap already
        // documented and fixed for skill-proposal.js's runSkillProposalPublic
        // elsewhere in this file ("built here... because runOpenAIReply only
        // exists in this function's scope"); runOpenAIReplyPublic applies
        // that identical fix here.
        const res = await runOpenAIReplyPublic(prompt, Math.min(maxTokens, 512), null, sessionId);
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

// #923/#925/#926: my saved speech words, mishearing fixes and language
// (data/speech.json), from Settings > Voice or the speech__* tools.
// #1107: a new mishearing fix also corrects my kept voice clips.
const speechVocabulary = createSpeechVocabulary({
  filePath: path.join(acpMemoryStore.dataDir, "speech.json"),
  onCorrection: ({ heard, term }) =>
    applyCorrectionToClips(voiceDataDir(), heard, term).catch((e) =>
      console.warn(`[Mana] Couldn't correct kept voice clips: ${e.message}`),
    ),
});

// #914: proactive toasts name the character saying them when she isn't Mana.
require("./proactive").watchSpeaker(() => {
  const character = characterStore.active();
  return character.id === DEFAULT_CHARACTER_ID ? null : character.name;
});

// #986: held proactive remarks (data/proactive-held.json) survive a restart.
if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
  require("./proactive").persistTo(path.join(acpMemoryStore.dataDir, "proactive-held.json"));
}

// #906: the email/calendar accounts from Settings > Calendar & email.
const mailCalendarSettings = createMailCalendarSettingsStore();
// #907: the daily briefing (data/briefing.json, Settings > Briefing),
// through the proactive engine. The chat model writes it only when it's
// already loaded. #961: calendar and mail come from #906's accounts; the
// section is skipped while neither is set up.
const briefing = createBriefing({
  filePath: path.join(acpMemoryStore.dataDir, "briefing.json"),
  listFacts: () => acpMemoryStore.listFacts(),
  listJobs: () => cronSchedulerPlugin.getScheduler().listJobs(),
  searchWeb: (query, options) => {
    if (!isWebAccessEnabled()) throw new Error("web access is off");
    return searchWeb(query, options);
  },
  runLocalReply: (prompt, maxTokens) => llamaServerRuntime.runLocalReplyIfSafelyLoaded(prompt, maxTokens),
  calendar: () => mailCalendarBriefingLines({ store: mailCalendarSettings }),
  offer: (candidate) => require("./proactive").offer(candidate),
});
// "Sitting down": the launchers' idle report (every 60 s) saw input this recently.
const BRIEFING_ACTIVE_SECONDS = 120;
const briefingOnActive =
  process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT ? briefing.maybeRun : () => {};
// Part of #700: at most one gentle check-in a day after I've seemed down
// (check-ins.js), through the proactive engine; never mid-game.
const checkIns = createCheckIns({
  store: acpMemoryStore,
  offer: (candidate) => require("./proactive").offer(candidate),
  isGaming: () => gamingWatch.isGaming(),
});
if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
  setInterval(() => {
    try {
      checkIns.maybeCheckIn();
    } catch (e) {
      console.warn("Check-in failed:", e.message);
    }
  }, 5 * 60 * 1000).unref();
}
// #908: the game I'm playing, if its wiki is known: the one in front (the
// native launcher's foreground report), else the watched game that's running.
function currentGame() {
  const front = require("./foreground").getForeground();
  return gameWikis.gameFor(front && front.app) || gameWikis.gameFor(gamingWatch.game());
}

function whisperLanguage() {
  return resolveWhisperLanguage(process.env.WHISPER_LANGUAGE, speechVocabulary.language());
}

// Issue #667: whisper's initial prompt, rebuilt from memory every few
// minutes. WHISPER_PROMPT, when set, still replaces it entirely.
const getWhisperPrompt = createWhisperPromptProvider({
  memoryStore: acpMemoryStore,
  override: process.env.WHISPER_PROMPT || "",
  vocabulary: process.env.WHISPER_VOCABULARY || "",
  savedWords: speechVocabulary.words,
});

// #619: a loaded whisper-server for final and partial transcripts, with
// whisper-cli (runWhisperCli/runWhisperCliPartial) as the fallback.
// While a watched game runs, whisper keeps to 2 threads so it doesn't take
// CPU from the game; WHISPER_THREADS applies the rest of the time.
function whisperThreads() {
  return gamingWatch.isGaming() ? Math.min(WHISPER_THREADS, 2) : WHISPER_THREADS;
}

const whisperServer = createWhisperServer({
  env: process.env,
  findCliBin: () => whisperDiscovery.findWhisperBin({ env: process.env }),
  findModel: () => whisperDiscovery.findWhisperModel({ env: process.env, language: whisperLanguage() }),
  threads: whisperThreads,
  language: whisperLanguage,
  beamSize: WHISPER_BEAM_SIZE,
  noSpeechThreshold: WHISPER_NO_SPEECH_THRESHOLD,
});

async function transcribeWithWhisperServer(filePath) {
  const startedAt = nowMs();
  const text = await whisperServer.transcribe(filePath, {
    prompt: getWhisperPrompt(),
    temperature: WHISPER_TEMPERATURE,
  });
  if (text !== null) logPerf("whisper-server", startedAt);
  return text;
}

// Issue #295 (piece 2 of #285): folds a decay+threshold check into the
// existing periodic reviewer tick below (not just the idle-report handler)
// -- "hours since we last talked" needs to be checkable on a clock tick
// even while the launcher (idle-report's only source) isn't running at
// all. One real reflex, not a framework of hypothetical ones: fires a
// journal-style fact via the already-existing rememberFact() when the gap
// since the last real conversation crosses a threshold. Uses action:
// "patch" against a fixed key, so a threshold that stays crossed across
// several ticks updates the same fact in place instead of piling up
// duplicates (rememberFact's patch already falls back to insert on the
// first fire).
const LONELINESS_THRESHOLD_HOURS = Number(
  process.env.MANA_LONELINESS_THRESHOLD_HOURS || 48,
);
// store: defaults to the module's real acpMemoryStore singleton -- same
// pattern as this file's other deps-injectable helpers, overridden in
// tests so this never touches the real data directory.
async function checkEmotionalReflexes(store = acpMemoryStore) {
  const sessions = store.listSessions();
  const lastUpdatedAt = sessions[0]?.updatedAt;
  if (!lastUpdatedAt) return;
  const hoursSince = (Date.now() - new Date(lastUpdatedAt).getTime()) / 3600000;
  if (!Number.isFinite(hoursSince) || hoursSince < LONELINESS_THRESHOLD_HOURS) return;

  await store.rememberFact({
    key: "journal-loneliness",
    // Part of #700: the same counterweight as the mood block and persona.
    text: `It's been about ${Math.round(hoursSince)} hours since we last talked. If it comes up, mention missing them lightly and only once: no guilt-tripping, no asking why they were away, and be glad they had other plans and people.`,
    action: "patch",
    origin: { kind: "system" },
  });
}

// Named prompt/behavior presets (see presets-store.js)
const presetsStore = createPresetsStore({});
// Issue #357: the editable personality layer, persisted so an adjustment
// survives a restart. persona.js owns the immutable core and no storage.
// #914: each character has her own (and her own mood below); both delegate
// to the active character's store.
const personalityStore = perCharacter(
  characterStore,
  (id) => createPersonalityStore({ filePath: characterFilePath(DEFAULT_PERSONALITY_FILE, id) }),
  ["get", "set", "revert", "clear"],
);
// Issue #700: Mana's mood, persisted beside emotional-state.json (in memory
// under tests, so they never touch the real data dir).
const moodFilePath =
  process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT
    ? null
    : path.join(acpMemoryStore.dataDir, "mood-state.json");
const moodStore = perCharacter(
  characterStore,
  (id) => createMoodStore({ filePath: characterFilePath(moodFilePath, id) }),
  ["get", "record", "recordTurn", "reset", "setFrozen"],
);
// #914: each character's own notes on her relationship with me, beside
// the mood (in memory under tests). relationshipFor(id) is any character's
// (Settings lists them all); relationshipStore is the active one's.
const relationshipStores = new Map();
function relationshipFor(id) {
  if (!relationshipStores.has(id)) {
    relationshipStores.set(
      id,
      createRelationshipStore({
        filePath: characterFilePath(moodFilePath && path.join(acpMemoryStore.dataDir, "relationship.json"), id),
      }),
    );
  }
  return relationshipStores.get(id);
}
const relationshipStore = perCharacter(characterStore, relationshipFor, [
  "list",
  "add",
  "ensureFirstChat",
  "milestoneToMention",
]);
// When my oldest session began, or null.
function oldestSessionAt() {
  const times = acpMemoryStore.listSessions().map((s) => s.createdAt).filter(Boolean).sort();
  return times[0] || null;
}

// Procedural-memory skills store (see skills-store.js, issue #140)
const skillsStore = createSkillsStore({ snapshotStore });

// Approval gate for agent-authored content -- skill writes today, whatever
// #142's script-runner gets wired into next (see approval-gate.js, #152).
// Executor registration happens in createApp below, against whichever
// skillsStore/approvalGate that specific call actually uses.
// Content scanning (flagging a pending request for shell/fs/credential-like
// patterns) stays off by default -- opt in once the flagged-pending UI is
// something you actually want surfaced.
// Issue #284: Guardian pre-check, also off by default -- a small model
// judges one specific action's risk before it reaches the human queue.
// Reuses runLocalLlamaReply (already defined above) on the "fast" profile,
// same reasoning as #281's tool-catalogue filter/result digest.
const approvalGate = createApprovalGate({
  contentScanEnabled: process.env.MANA_APPROVAL_CONTENT_SCAN_ENABLED === "1",
  guardianEnabled: process.env.MANA_GUARDIAN_PRECHECK_ENABLED === "1",
  guardianPreCheck: (actionType, ctx) =>
    judgeActionRisk({ actionType, ...ctx, runLocalReply: runLocalLlamaReply }),
  onDeny: () => moodStore.record("approval_rejected"),
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

// Issue #426: user-configurable PreToolUse/PostToolUse-style hook rules
// (deny/ask/run-command), additive to the approval gate and tool-call-log
// above rather than replacing either -- see hooks-store.js's wrapWithHooks.
const hooksStore = createHooksStore({});

// Issue #188: browser-automation's navigate/click/type/snapshot as
// tool-calling schemas, sharing the plugin's own singleton browser session
// (see plugins/browser-automation/index.js's exported getSession) rather
// than opening a second Chromium instance.
const browserAutomationToolSource = createBrowserAutomationToolSource({
  getSession: browserAutomationPlugin.getSession,
  approvalGate,
  // #1137: her browser closes (or never starts) while I'm gaming.
  sessionDeps: { isGaming: () => gamingWatch.isGaming() },
  // #1139: "she needs you" in the Browser panel.
  requestHandOver: browserAutomationPlugin.requestHandOver,
  // #1157: look-and-click uses her own vision model (paused while gaming there too).
  runVisionReply: (prompt, images, maxTokens) => llamaServerRuntime.runVisionReply(prompt, images, maxTokens),
});

// Background memory block that can be refreshed periodically from ACP session files.
let BACKGROUND_MEMORY_BLOCK = "";
let BACKGROUND_MEMORY_LOCK = false;
let BACKGROUND_MEMORY_META = { files: {} };
// #1124: Dream Mode's compactor for the Background tasks panel -- when its
// refresh timer started, its interval, and since when a run is going.
const DREAM_MODE = { everyMs: 0, scheduledAt: null, runningSince: null };
// MANA_ACP_MEMORY_DIR moves these with the rest of memory (acp-memory-store).
const ACP_MEMORY_DIR = process.env.MANA_ACP_MEMORY_DIR || path.join(__dirname, "data", "acp-memory");
const BACKGROUND_META_PATH = path.join(ACP_MEMORY_DIR, "background_meta.json");

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
let runBackgroundEntityTypingPublic = null;
let runBackgroundConnectionsPublic = null;
let runSkillProposalPublic = null;
// Same trap as runSkillProposalPublic below, for the same reason:
// acpMemoryStore's summarizeFn (built at module load, well above this line)
// needs to call runOpenAIReply, which only exists inside registerRoutes's
// scope. Assigned once registerRoutes actually runs; summarizeFn calls
// through this indirection instead of referencing runOpenAIReply directly.
let runOpenAIReplyPublic = null;

// Always-visible index of every active skill's name+description, injected
// straight into the system prompt -- independent of
// contributePluginPromptContext's "first plugin wins" contest (registry.js),
// since unconditionally returning a non-empty result there would starve
// every other plugin's context on every single turn (see
// skills-capability.js's own contributePromptContext, kept unchanged as the
// keyword-matched full-body fallback). This is the cheap index tier only;
// skill__view (ai/skill-tool-source.js) is how Mana reads a matched skill's
// full body on demand, closer to how Claude's own Skills feature works --
// the model judges relevance from the description, not a regex heuristic.
const SKILLS_INDEX_MAX_CHARS = 2000;

function buildSkillsIndexBlock(skills) {
  if (!skills || !skills.length) return "";
  const allLines = skills.map((s) => `- ${s.name}: ${s.description}`);
  // Truncate at a whole-line boundary, never mid-line -- a flat char slice
  // would risk cutting a description mid-sentence with no indication it's
  // incomplete, which the model could otherwise misread as a full entry.
  const kept = [];
  let charCount = 0;
  for (const line of allLines) {
    if (charCount + line.length + 1 > SKILLS_INDEX_MAX_CHARS) break;
    kept.push(line);
    charCount += line.length + 1;
  }
  if (kept.length < allLines.length) {
    kept.push(`- (${allLines.length - kept.length} more skill(s) omitted for length)`);
  }
  return `[AVAILABLE SKILLS]\nNamed procedures you have memorized. If one clearly matches what's being asked, call skill__view with its exact name to read the full steps before acting -- don't guess at them from the description alone.\n${kept.join("\n")}\n[END AVAILABLE SKILLS]`;
}

// Human-readable counterpart to background_meta.json's internal bookkeeping
// (issue #69) -- written whenever a compaction/review pass actually changes
// the compacted summary or important facts, whether triggered by idle
// detection or the hourly timer.
const MEMORY_MD_PATH = path.join(ACP_MEMORY_DIR, "MEMORY.md");

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

function currentMemoryNotes() {
  const entityIndexPath = path.join(acpMemoryStore.dataDir, "entity-index.json");
  let entityIndex = {};
  if (fs.existsSync(entityIndexPath)) {
    entityIndex = JSON.parse(fs.readFileSync(entityIndexPath, "utf8") || "{}");
  }
  const facts = BACKGROUND_MEMORY_META.important_facts || [];
  const connections = BACKGROUND_MEMORY_META.connections || [];
  return buildMemoryNotes(entityIndex, facts, connections);
}

// #935: the vault's read-only Views/ -- the MEMORY.md summary, Mana's mood
// (level words only, so it changes when her mood does, not every minute)
// and the per-entity notes /api/memory/notes serves.
function buildVaultViews(mood) {
  let summary = "_(no summary yet)_\n";
  try {
    summary = fs.readFileSync(MEMORY_MD_PATH, "utf8");
  } catch (e) {
    // Not written yet.
  }
  const moodBody = [
    "# Mana's mood",
    "",
    `Right now: ${mood.summary}.`,
    "",
    `- Energy: ${levelWord(mood.energy)}`,
    `- Sociability: ${levelWord(mood.sociability)}`,
    `- Stress: ${levelWord(mood.stress)}`,
    "",
  ].join("\n");
  return [
    { rel: "Views/Summary.md", body: summary },
    { rel: "Views/Mood.md", body: moodBody },
    ...currentMemoryNotes().map((note) => ({ rel: `Views/Entities/${note.slug}.md`, body: note.body })),
  ];
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
      path.join(ACP_MEMORY_DIR, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      BACKGROUND_MEMORY_BLOCK = "";
      BACKGROUND_MEMORY_META = { files: {} };
      try {
        await persistBackgroundMeta();
      } catch (e) {}
      return { summaries: [], text: "", processed: 0, totalFiles: 0 };
    }

    // #673: the loader itself lives in dream-mode.js (unit tested there,
    // including that a pruned summary stays pruned).
    const { summaries, processedFiles, processed, totalFiles } = await loadSessionSummaries({
      sessionsDir,
      meta: BACKGROUND_MEMORY_META,
      maxFiles: Number(process.env.MANA_BACKGROUND_MEMORY_MAX_FILES || 200),
    });

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
        totalFiles,
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
      `Loaded BACKGROUND_MEMORY_BLOCK (${text.length} chars) from ${processed} processed files (${totalFiles} total)`,
    );
    try {
      await persistBackgroundMeta();
    } catch (e) {}
    return {
      summaries,
      text,
      processed,
      processedFiles,
      totalFiles,
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
        DREAM_MODE.runningSince = Date.now();
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

          // #673: dream-mode.js decides what to (re)summarize from the
          // compactor's cursor -- only new/changed summaries after the
          // first run, and no model call when there are none.
          const result = await runCompactorStage({
            processedFiles,
            meta: BACKGROUND_MEMORY_META,
            maxChars,
            now: () => new Date().toISOString(),
            summarize: async (prompt) => {
              let reply = null;
              try {
                if (shouldUseRemoteAi()) {
                  reply = await runOpenAIReply(prompt, Math.min(maxTokens, 512));
                }
              } catch (e) {
                console.warn(
                  "Background summarizer (remote) failed:",
                  e && e.message ? e.message : e,
                );
              }
              if (!reply && localLlamaReplyAvailable()) {
                try {
                  reply = await runLocalLlamaReply(prompt, Math.min(maxTokens, 256), "default");
                } catch (e) {
                  console.warn(
                    "Background summarizer (local) failed:",
                    e && e.message ? e.message : e,
                  );
                }
              }
              return reply;
            },
          });
          if (result.text) {
            BACKGROUND_MEMORY_BLOCK = `[BACKGROUND MEMORY]\n${result.text}\n[END BACKGROUND MEMORY]`;
          }
          if (result.changedMeta) {
            await persistBackgroundMeta();
          }
          if (result.called && result.text) {
            const compacted = result.text;
            try {
              await persistBackgroundMeta();
              await writeMemoryMarkdown();
            } catch (e) {}
            console.log(
              `Background memory compacted by summarizer (len=${compacted.length}, ${result.incremental ? `${result.summarized} new summaries merged` : "full"})`,
            );
            // Issue #423: surface the Dream Mode insight as a proactive toast,
            // not just a silent file write -- fire-and-forget, never blocks
            // the compaction itself on notification delivery. #697: through
            // the proactive budget and gaming hold; worth it for half a day.
            require("./proactive").offer({
              reason: "dream-insight",
              ttlMs: 12 * 60 * 60 * 1000,
              payload: {
                type: "dream",
                title: "Dream Mode",
                text: compacted.length > 200 ? `${compacted.slice(0, 200)}...` : compacted,
                at: new Date().toISOString(),
              },
            });
          }
        } catch (e) {
          console.warn(
            "Background compactor failed:",
            e && e.message ? e.message : e,
          );
        } finally {
          summarizerRunning = false;
          DREAM_MODE.runningSince = null;
        }
      }

      // Issue #432: ontology-typed entity extraction, as its own function
      // (not folded into runBackgroundCompactor above) -- a structurally
      // different job (batched classification, not prose summarization),
      // called at the same trigger sites so it shares Dream Mode's exact
      // cadence (hourly timer + idle-triggered + startup) and gaming-mode
      // pause without being coupled to session-summary compaction.
      let entityTypingRunning = false;
      const ENTITY_TYPING_BATCH_CAP = Number(
        process.env.MANA_ENTITY_TYPING_BATCH_CAP || 25,
      );
      async function runBackgroundEntityTyping() {
        if (entityTypingRunning) return;
        entityTypingRunning = true;
        try {
          const untyped = acpMemoryStore.listUntypedEntities(ENTITY_TYPING_BATCH_CAP);
          if (!untyped.length) return;

          // Fails closed exactly like #431's conflict judge -- this call
          // never loads or swaps a model; it only runs when one is already
          // resident, so a busy/idle-loaded system just skips this cycle
          // and picks the same untyped entities back up next time.
          const typingRaw = await llamaServerRuntime.runLocalReplyIfSafelyLoaded(
            buildEntityTypingPrompt(untyped),
            Math.max(64, untyped.length * 24),
          );
          if (!typingRaw) return;

          const typed = parseEntityTypingResponse(typingRaw, untyped);
          for (const entity of typed) {
            acpMemoryStore.setEntityType(entity.key, entity.type, entity.subcategory);
          }

          // Merge-candidate pass: only for entities that ARE real things
          // (not_an_entity has nothing to merge into), one same-type cheap
          // pre-filter + LLM confirmation per entity.
          for (const entity of typed) {
            if (entity.type === "not_an_entity") continue;
            const canonicalPool = acpMemoryStore.listCanonicalEntitiesOfType(entity.type);
            const newEntityWithDisplay = untyped.find((u) => u.key === entity.key);
            if (!newEntityWithDisplay) continue;
            const candidates = findEntityMergeCandidates(newEntityWithDisplay, canonicalPool);
            for (const candidate of candidates) {
              const verdictRaw = await llamaServerRuntime.runLocalReplyIfSafelyLoaded(
                buildEntityMergeJudgePrompt(newEntityWithDisplay, candidate),
                16,
              );
              if (verdictRaw && parseEntityMergeVerdict(verdictRaw)) {
                acpMemoryStore.setCanonicalAlias(newEntityWithDisplay.key, candidate.key);
                break;
              }
            }
          }
        } catch (e) {
          console.warn(
            "Background entity typing failed:",
            e && e.message ? e.message : e,
          );
        } finally {
          entityTypingRunning = false;
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

          // Scheduled runs skip the model call when nothing changed since the
          // last applied review; explicit route-triggered runs always proceed.
          const { numbered, hash: reviewHash, skip } = reviewPlan({
            processedFiles,
            meta: BACKGROUND_MEMORY_META,
            skipIfUnchanged: options.skipIfUnchanged,
          });
          if (skip) {
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
            // #673: merged into the list so far, not replacing it.
            BACKGROUND_MEMORY_META.important_facts = mergeUnique(
              importantFacts,
              BACKGROUND_MEMORY_META.important_facts || [],
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
          // #673: only runs when there are summaries new since its last
          // run, and only looks for connections involving them.
          const result = await runConnectionsStage({
            processedFiles,
            meta: BACKGROUND_MEMORY_META,
            minSummaries: Number(process.env.MANA_BACKGROUND_CONNECTIONS_MIN_SUMMARIES || 2),
            maxSummaries: Number(process.env.MANA_BACKGROUND_CONNECTIONS_MAX_SUMMARIES || 30),
            now: () => new Date().toISOString(),
            ask: async (prompt) => {
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
              if (!reply && localLlamaReplyAvailable()) {
                try {
                  reply = await runLocalLlamaReply(prompt, 300, "default");
                } catch (e) {
                  console.warn(
                    "Background connections (local) failed:",
                    e && e.message ? e.message : e,
                  );
                }
              }
              return reply;
            },
          });
          if (!result.ok) return result;
          try {
            await persistBackgroundMeta();
            await writeMemoryMarkdown();
          } catch (e) {}

          console.log(
            `Background connections pass found ${result.found.length} new connection(s)`,
          );
          return { ok: true, connections: result.connections };
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
        runBackgroundEntityTypingPublic = runBackgroundEntityTyping;
        runBackgroundConnectionsPublic = runBackgroundConnections;
        // runSkillProposalPublic is constructed in registerRoutes below,
        // not here -- runOpenAIReply only exists in that scope (unlike
        // shouldUseRemoteAi/runLocalLlamaReply/localLlamaReplyAvailable,
        // which really are module-level). Building it eagerly here with a
        // bare `runOpenAIReply` reference would throw immediately at
        // startup (ReferenceError), not just fail quietly when actually
        // invoked -- caught by this same eager-construction refactor.
      } catch (e) {}

      // Run compactor once now, and schedule periodic compaction. The
      // memory models are warmed here too -- not while a game runs, since
      // the GPU embedder takes ~2.3 GB of VRAM.
      if (!backgroundJobsPausedForGaming()) {
        warmMemoryModels();
        runBackgroundCompactor().catch((err) =>
          console.warn(
            "Compactor initial run failed:",
            err && err.message ? err.message : err,
          ),
        );
        runBackgroundEntityTyping().catch((err) =>
          console.warn(
            "Entity typing initial run failed:",
            err && err.message ? err.message : err,
          ),
        );
      }

      if (refreshMs > 0) {
        // The compactor reloads background memory itself, so one call per tick
        // is enough; reviewing runs on its own (slower) schedule below.
        Object.assign(DREAM_MODE, { everyMs: refreshMs, scheduledAt: Date.now() });
        setInterval(() => {
          if (backgroundJobsPausedForGaming()) return;
          runBackgroundCompactor().catch((err) =>
            console.warn(
              "Background memory refresh failed:",
              err && err.message ? err.message : err,
            ),
          );
          runBackgroundEntityTyping().catch((err) =>
            console.warn(
              "Background entity typing refresh failed:",
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
          checkEmotionalReflexes().catch((err) =>
            console.warn(
              "Emotional reflex check failed:",
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

function parseTasklistNames(stdout) {
  return (stdout || "")
    .split(/\r?\n/)
    .map((line) => parseTasklistCsvLine(line)[0])
    .filter(Boolean)
    .map((name) => name.toLowerCase());
}

// The gaming watch's cached answer (polled every 30 s with a non-blocking
// tasklist), never a fresh tasklist: this runs on every spoken reply and
// every launcher status poll, and a spawnSync here stalled the event loop.
function getGamingStatus() {
  const game = gamingWatch.game();
  return {
    gamingAppRunning: gamingWatch.isGaming(),
    matchedProcesses: game ? [game] : [],
    watchedProcesses: GAMING_PROCESS_NAMES,
  };
}

// /perf/status is polled by the launcher, and the PowerShell process
// listing takes a second or more: it runs in the background at most every
// 15 s, and the route answers with the last result (the backend's own RSS
// until the first one lands). It used to be a spawnSync on every poll.
const MANA_PROCESS_SNAPSHOT_MS = 15 * 1000;
let manaProcessSnapshot = null;
let manaProcessSnapshotAt = 0;
let manaProcessSnapshotPending = false;

function getManaProcessSnapshot() {
  const ownOnly = {
    totalMemoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    processes: [],
  };
  if (process.platform !== "win32") {
    return ownOnly;
  }
  if (!manaProcessSnapshotPending && Date.now() - manaProcessSnapshotAt >= MANA_PROCESS_SNAPSHOT_MS) {
    manaProcessSnapshotPending = true;
    readManaProcessSnapshot()
      .then((snapshot) => {
        manaProcessSnapshot = snapshot;
      })
      .catch(() => {})
      .finally(() => {
        manaProcessSnapshotAt = Date.now();
        manaProcessSnapshotPending = false;
      });
  }
  return manaProcessSnapshot || ownOnly;
}

// The Win32_Process rows running something under root, the checkout this
// server runs from wherever it is: root plus a separator, so D:\Mana
// doesn't also match D:\Mana-worktrees\...
function manaProcessesUnder(rows, root) {
  const winPath = (text) => String(text || "").toLowerCase().replaceAll("/", "\\");
  const prefix = `${winPath(root).replace(/\\+$/, "")}\\`;
  return rows
    .filter((row) => winPath(row.CommandLine).includes(prefix))
    .map((row) => ({
      pid: row.ProcessId,
      name: row.Name,
      memoryMb: Math.round((row.WorkingSetSize || 0) / 1024 / 1024),
      role: getManaProcessRole(row.CommandLine || row.Name || ""),
    }));
}

async function readManaProcessSnapshot() {
  const command = [
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } |",
    "Select-Object ProcessId,Name,WorkingSetSize,CommandLine |",
    "ConvertTo-Json -Compress -Depth 3",
  ].join(" ");
  // Full path, like the gaming watch's tasklist: a bare name is looked up
  // in the cwd first.
  const powershell = path.win32.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const { stdout } = await promisify(execFile)(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (!stdout.trim()) {
    return null;
  }

  const parsed = JSON.parse(stdout);
  const processes = manaProcessesUnder(Array.isArray(parsed) ? parsed : [parsed], path.resolve(__dirname, ".."));

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

// An upload's temp files are its multer name (32 random hex, no extension)
// plus whatever ffmpeg/whisper appended: .wav, .out.json, .partial-out.json.
// Both multer instances (here and mobile-routes.js) write to node-bot/tmp
// (or MANA_UPLOAD_TMP_DIR).
function deleteUploadFiles(uploadPath) {
  const dir = path.dirname(uploadPath);
  const name = path.basename(uploadPath);
  if (!/^[0-9a-f]{32}$/.test(name)) return;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(name)) fs.rmSync(path.join(dir, entry), { force: true });
    }
  } catch (e) {
    console.warn(`[Mana] Couldn't delete voice upload ${name}: ${e.message}`);
  }
}

// On start: anything left in tmp/ from before (a crash, or builds that
// kept every voice upload) that's over an hour old. Files only -- tmp/
// also holds the OCR model cache in tmp/tesseract.
function sweepStaleTmpFiles(dir = uploadTmpDir(), maxAgeMs = 60 * 60 * 1000, now = Date.now()) {
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
          fs.rmSync(file, { force: true });
          removed += 1;
        }
      } catch (e) {
        console.warn(`[Mana] Couldn't delete old temp file ${entry.name}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`[Mana] Couldn't clean ${dir}: ${e.message}`);
  }
  return removed;
}

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
      if (typeof runBackgroundEntityTypingPublic === "function") {
        await runBackgroundEntityTypingPublic().catch((err) =>
          console.warn(
            "Idle-triggered entity typing failed:",
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
      // #935: the vault journal's entry for this session, written after
      // the compactor above (idle is the session's end). It never loads a
      // model and skips while gaming.
      if (memoryVault) await memoryVault.writeJournal();
      // Issue #663: unconfirmed facts age into archived. No model call.
      try {
        (deps.acpMemoryStore || acpMemoryStore).archiveExpiredPendingFacts({
          maxAgeDays: Number(process.env.MANA_PENDING_FACT_MAX_AGE_DAYS) || undefined,
        });
      } catch (err) {
        console.warn(
          "Idle-triggered pending-fact expiry failed:",
          err && err.message ? err.message : err,
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

  // #697 part 1: the native launcher reports each foreground-window change.
  app.post("/internal/foreground-report", (req, res) => {
    try {
      require("./foreground").reportForeground(req.body || {});
      return res.json({ ok: true });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  // Reported by windows-launcher's powerMonitor.getSystemIdleTime() poll.
  // Fires consolidation once per idle period (resets when the user is seen
  // active again below the threshold), so staying idle for hours doesn't
  // re-trigger it on every ~60s report.
  app.post("/internal/idle-report", (req, res) => {
    const idleSeconds = Number(req.body?.idleSeconds) || 0;
    if (idleSeconds < BRIEFING_ACTIVE_SECONDS) briefingOnActive();
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
    // #1007: 20 minutes away is also when Mana may pick up one of her
    // issues. Not in tests, unless they bring their own runner: the real
    // one asks gh about the real repo.
    if (deps.selfWork || (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT)) {
      selfWork.startIdle().catch(() => {});
    }
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
      editorIntegrations = createEditorIntegrations({ snapshotStore });
    }
    return editorIntegrations;
  }
  // Issue #622: adversarial review of agent-proposed edits, on by default
  // (MANA_ADVERSARIAL_VERIFY=0 turns it off), on whatever model is already
  // loaded -- never a swap.
  const reviewEdit =
    deps.reviewEdit ||
    ((proposal) =>
      refuteEdit({ ...proposal, runLocalReply: llamaServerRuntime.runLocalReplyIfSafelyLoaded }));
  const modelManagement =
    deps.modelManagement ||
    createModelManagement({
      env: deps.env || process.env,
      modelSettingsStore,
      // #1086: the recommendation subtracts what these hold in VRAM.
      ttsProvider: TTS_PROVIDER,
      whisperModel: whisperDiscovery.findWhisperModel({ env: deps.env || process.env }),
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

  // #842: no secret no longer means open -- see checkAdminSecret.
  function checkAdminAuth(req, res) {
    return checkAdminSecret(req, res, ADMIN_SECRET);
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
    matrixBridgePlugin,
    videoWatchPlugin,
    contextPushPlugin,
    screenSensingPlugin,
    dirScannerCapability,
    webAccessCapability,
    sessionsCapability,
    promptCompositionCapability,
    deepResearchCapability,
    presetsCapability,
    personalityCapability,
    moodCapability,
    createCharactersCapability(characterStore),
    createRelationshipCapability(characterStore, relationshipFor),
    backgroundMemoryCapability,
    memoryFactsCapability,
    memoryVaultCapability,
    retrieverAdminCapability,
    skillsCapability,
    approvalGateCapability,
    mcpClientCapability,
    toolCallLogCapability,
    terminalCapability,
    hooksCapability,
    pronunciationLexiconCapability,
    backgroundTasksCapability,
    // Yellowlight enhancements (#496-#489) — optional plugins wired into capability system
    cloudSyncCapability,
    scheduledExportCapability,
    structuredConnectorsCapability,
  ];
  const activePresetsStore = deps.presetsStore || presetsStore;
  const activePersonalityStore = deps.personalityStore || personalityStore;
  const activeMoodStore = deps.moodStore || moodStore;
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
  // Issue #663: refuses (and asks again) when the fact changed since the
  // request, instead of writing over what the approver reviewed.
  activeApprovalGate.registerExecutor(
    "memory-write",
    createMemoryWriteExecutor({ acpMemoryStore, approvalGate: activeApprovalGate }),
  );
  // #935: two-way sync with the Obsidian vault (MANA_VAULT_DIR). A new
  // note asks for the user's OK under its own action type, so denying one
  // never counts against (or grants) Mana's own memory writes.
  activeApprovalGate.registerExecutor("memory-vault-note", (payload) => acpMemoryStore.rememberFact(payload));
  activeApprovalGate.registerExecutor("memory-vault-pin", (payload) =>
    acpMemoryStore.setFactPinned(payload.key, payload.pinned === true),
  );
  let memoryVault = null;
  if (process.env.MANA_VAULT_DIR && process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
    try {
      memoryVault = createMemoryVault({
        store: acpMemoryStore,
        vaultDir: process.env.MANA_VAULT_DIR,
        approvalGate: activeApprovalGate,
        buildViews: () => buildVaultViews(activeMoodStore.get()),
        runModel: (prompt, maxTokens) => llamaServerRuntime.runLocalReplyIfSafelyLoaded(prompt, maxTokens),
        isGaming: () => gamingWatch.isGaming(),
      });
      memoryVault.start();
    } catch (e) {
      console.warn("Memory vault sync failed to start:", e?.message || e);
    }
  }
  const memoryVaultStatus = () => (memoryVault ? memoryVault.getStatus() : { vaultDir: null });

  // Lets acpMemoryStore's summarizeFn (built at module load time, long
  // before registerRoutes ever runs) reach the real runOpenAIReply --
  // same trap and same fix shape as runSkillProposalPublic just below.
  // Rebuilt on every registerRoutes call (once per real server start, once
  // per test's createApp()), same as everything else in this block.
  runOpenAIReplyPublic = runOpenAIReply;

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
  const activeHooksStore = deps.hooksStore || hooksStore;
  const activePronunciationLexiconStore = deps.pronunciationLexiconStore || pronunciationLexiconStore;
  const activeBrowserAutomationToolSource = deps.browserAutomationToolSource || browserAutomationToolSource;
  const agentActivity = createAgentActivity();
  // #675 Q12b: deep thinking Mana turned on herself, per session.
  const deepThinking = createDeepThinkingState();
  // Deep research's job list, shared with the Background tasks panel.
  const researchJobs = createResearchJobStore();
  const isGamingNow = deps.isGaming || gamingWatch.isGaming;
  const capabilityContext = {
    acpMemoryStore: deps.acpMemoryStore || acpMemoryStore,
    jobs: researchJobs,
    // #1124: what GET /background-tasks lists. selfWork is built further
    // down, hence the getter.
    backgroundTaskSources: {
      cron: () => cronSchedulerPlugin.getScheduler(),
      heartbeat: () => cronSchedulerPlugin.getHeartbeat(),
      heartbeatEnabled: () => isPluginEnabled(cronSchedulerPlugin, activePluginSettingsStore),
      isGaming: isGamingNow,
      proactive: require("./proactive"),
      briefing,
      dreamMode: () => DREAM_MODE,
      embeddings: { status: () => require("./tools/embedding-worker").status() },
      memoryVault: memoryVaultStatus,
      researchJobs,
      selfWork: () => selfWork,
      agentActivity,
      llama: llamaServerRuntime,
      llamaBuilds: deps.llamaBuilds || llamaBuilds,
      fishWarmup: () => ttsRuntime.getFishWarmupStatus(),
    },
    // #1265: the cron scheduler's script jobs. folioUpdater is built
    // further down; the job only runs after startup.
    scriptActions: {
      [FOLIO_UPDATE_ACTION]: async () => {
        await folioUpdater.run();
        return null;
      },
    },
    // Only cron-scheduler's agent-job executor uses this today -- every
    // other capability builds its own scoped model-reply function above.
    buildAssistantReply: deps.buildAssistantReply || buildAssistantReply,
    // Only browser-automation's routes use this today -- everywhere else
    // that needs a loopback-only guard builds it inline (e.g. the
    // brain-provider test route above).
    isLocalRestartRequest: deps.isLocalRestartRequest || isLocalRestartRequest,
    // #670: loopback plus an admin key (admin-key.js) -- skill import.
    isLocalAdminRequest: deps.isLocalAdminRequest || isLocalAdminRequest,
    approvalGate: activeApprovalGate,
    // #699: heartbeat checks pause while gaming and snapshot their writes.
    isGaming: isGamingNow,
    snapshotStore,
    mcpClientRegistry: activeMcpClientRegistry,
    toolCallLog: deps.toolCallLog || toolCallLog,
    terminalFeed,
    hooksStore: activeHooksStore,
    pronunciationLexiconStore: activePronunciationLexiconStore,
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
    // #690: screen-sensing's text glances -- a short reply from whichever
    // model is already loaded, or null (never loads or swaps one).
    runLocalReply:
      deps.runLocalReply ||
      ((prompt, maxTokens) => llamaServerRuntime.runLocalReplyIfSafelyLoaded(prompt, maxTokens)),
    pluginSettingsStore: activePluginSettingsStore,
    skillsStore: activeSkillsStore,
    env: deps.env || process.env,
    synthesize:
      deps.synthesize ||
      ((prompt) => runLocalLlamaReply(prompt, 800, "quality", RESEARCH_SYSTEM_PROMPT)),
    // Issue #269: decompose/reflect are short, structured triage calls
    // (a handful of search-query lines, or one line naming a gap) -- a
    // materially different shape from synthesize/compress's long-form,
    // citation-fidelity-sensitive output, and "fast" (a smaller model) is
    // the intended fit per LLAMA_MODEL_PROFILES' own labels. Left off by
    // default (DEEP_RESEARCH_SUBTASK_PROFILE stays "quality" throughout,
    // matching prior behavior exactly) because the swap it would cause is a
    // real cost -- llama-server-runtime.js's swap is a multi-second
    // kill/respawn, and a reflect-cycle pass alternates decompose/reflect
    // with synthesize/compress enough times that switching profiles by
    // default could spend more of maxTotalMs swapping than the smaller
    // model saves. Opt in via MANA_DEEP_RESEARCH_SUBTASK_PROFILES=1 on
    // hardware where the swap cost is low (fast storage, small models, or
    // LLAMA_SERVER_SWAP_DEBOUNCE_MS tuned down).
    decompose:
      deps.decompose ||
      ((prompt) => runLocalLlamaReply(prompt, 200, DEEP_RESEARCH_SUBTASK_PROFILE, SUB_QUERY_SYSTEM_PROMPT)),
    reflect:
      deps.reflect ||
      ((prompt) => runLocalLlamaReply(prompt, 100, DEEP_RESEARCH_SUBTASK_PROFILE, REFLECT_SYSTEM_PROMPT)),
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
    personalityStore: activePersonalityStore,
    moodStore: activeMoodStore,
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
    getMemoryVault: () => memoryVault,
    runBackgroundReviewerPublic: deps.runBackgroundReviewerPublic || runBackgroundReviewerPublic,
    runSkillProposalPublic: deps.runSkillProposalPublic || runSkillProposalPublic,
    asyncLoadBackgroundMemory: deps.asyncLoadBackgroundMemory || asyncLoadBackgroundMemory,
    persistBackgroundMeta: deps.persistBackgroundMeta || persistBackgroundMeta,
    getBackgroundMemoryMeta: () => BACKGROUND_MEMORY_META,
    setBackgroundMemoryBlock: (block) => {
      BACKGROUND_MEMORY_BLOCK = block;
    },
    getPromptComposition: deps.getPromptComposition || getPromptComposition,
  };
  // Bug found while restoring node-bot/plugin-store.js: this call passed a
  // stray, incomplete 4-item literal and a bare { pluginSettingsStore }
  // instead of the real `capabilities` array (line 2004) and the full
  // `capabilityContext` (line 2085) -- silently unregistering the routes
  // for every capability except dirScanner and the three newest ones, and
  // starving whichever of those did register of the rest of their deps
  // (e.g. prompt-composition's context.getPromptComposition). Both
  // `capabilities` and `capabilityContext` are the exact objects
  // buildCapabilityHealth()/the /plugins listing already use, so this is
  // the one place route registration had drifted from them.
  registerCapabilities(app, capabilities, capabilityContext);

  app.get("/doctor", async (req, res) => {
    try {
      const doctor = deps.doctor || runDoctorChecksAsync;
      let memoryGraphHistory = null;
      try {
        memoryGraphHistory = (deps.acpMemoryStore || acpMemoryStore).memoryGraph?.getHistorySize?.() || null;
      } catch (e) {
        console.warn("Memory graph size check failed:", e?.message || e);
      }
      const result = await doctor({
        modelManagement, // #1086: same recommendation as /models/status
        fishTtsWarmup: ttsRuntime.getFishWarmupStatus(),
        sessionSearchVectorEnabled: sessionSearchIndex.vectorEnabled(),
        promptComposition: getMostRecentComposition(),
        // Q18 (#645): named here, not warned about on every start.
        plainTextSecrets: (deps.plainTextSecretKeys || plainTextSecretKeys)(),
        memoryGraphHistory,
        memoryVault: memoryVaultStatus(),
        chatModel: chatModelLabel(),
        findLlamaServerBin: llamaServerRuntime.findLlamaServerBin,
        whisperLanguage: whisperLanguage(),
      });
      return res.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  });

  // Issue #325: periodic Doctor poll so a warn/fail check reaches the user
  // proactively (tray tooltip + balloon in windows-launcher) instead of
  // only being visible when the Doctor popup happens to be opened.
  const doctorTrayPoller = createDoctorTrayPoller({
    doctor: deps.doctor || runDoctorChecksAsync,
    notifyTray: deps.notifyTray || notifyTray,
    doctorOptions: () => ({
      modelManagement,
      fishTtsWarmup: ttsRuntime.getFishWarmupStatus(),
      sessionSearchVectorEnabled: sessionSearchIndex.vectorEnabled(),
      memoryVault: memoryVaultStatus(),
      findLlamaServerBin: llamaServerRuntime.findLlamaServerBin,
      whisperLanguage: whisperLanguage(),
    }),
  });
  if (!(process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT))) {
    doctorTrayPoller.start();
  }

  // Issue #500: /zed/* and /editors/* routes (previously inline here)
  // moved to server-routes.js's registerEditorRoutes.
  registerEditorRoutes(app, { checkAdminAuth, getEditorIntegrations, zed: deps.zed, reviewEdit });

  // Issue #500: the 9 /models/* routes (previously inline here, minus the
  // two unrelated routes -- /browser-automation/activity and
  // /persona/override* below -- that just happened to sit physically
  // between them) moved to server-routes.js's registerModelRoutes.
  registerModelRoutes(app, {
    modelManagement,
    readGgufMetadata: deps.readGgufMetadata || readGgufMetadata,
    llamaBuilds: deps.llamaBuilds || llamaBuilds,
    checkAdminAuth,
  });

  // Issue #418: transient, human-facing "what's browser automation doing
  // right now" feed for the launcher to poll -- no auth, same as
  // /models/status (a read-only status readout, not a file-system-touching
  // admin action like /editors/workspace/*).
  app.get("/browser-automation/activity", (req, res) => {
    // #1139: plus whether I've taken over, or she's asking me to.
    return res.json({ ...activeBrowserAutomationToolSource.activityLog.getActivity(), takeOver: browserAutomationPlugin.takeOverStatus() });
  });

  // #1161: the latest "Test this site" report, in /web/read's shape so the
  // Browser panel's reader draws it with Folio.
  app.get("/browser-automation/site-test", (req, res) => {
    const report = activeBrowserAutomationToolSource.activityLog.getSiteTest();
    if (!report) return res.status(404).json({ error: "no site test yet" });
    return res.json({ url: "", title: report.title, text: report.text, images: report.images, truncated: false, needsBrowser: null });
  });

  // #646: the chat tool loop's live runs (current tool, elapsed), polled
  // by the launcher's activity panel -- read-only, no auth, same as above.
  app.get("/agent/activity", (req, res) => {
    return res.json({ runs: agentActivity.list() });
  });

  // #646: Stop from that panel, by run id.
  app.post("/agent/stop", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return res.json({ stopped: agentActivity.stop(String(req.body?.id ?? "")) });
  });

  // #1011: an issue and a revert PR for a merged PR that broke something;
  // the launcher then rolls its build back (try-pr.ps1 -Previous).
  const reverter = deps.reverter || createReverter();
  app.post("/updates/revert", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return res.json(await reverter.revert(req.body?.pr, req.body?.reason));
  });

  // #1182: git and GitHub in my chat and her self-work. One instance, so a
  // repo I "allow once" stays allowed until restart.
  const gitTools =
    deps.gitTools ||
    createGitToolSource({ approvalGate: activeApprovalGate, isGaming: deps.isGaming || gamingWatch.isGaming });
  // #1006: Mana works one of my issues in her own worktree and opens a PR.
  const selfWork =
    deps.selfWork ||
    createSelfWork({
      runLoop: (...args) => llamaServerRuntime.runToolAwareReply(...args),
      reviewEdit,
      gitTools,
      isGaming: deps.isGaming || gamingWatch.isGaming,
      // #1008: starts and ends go to the chat and a toast; a ready PR's link comes along.
      onEvent: (run, text, notice) => {
        console.log(`[self-work #${run.issue}] ${text}`);
        if (notice) notifyTray({ type: "self-work", title: "Mana's own code", text, url: run.prUrl || undefined });
      },
    });
  // #1265: Mana keeps Folio up to date: an hourly job (Folio looked at
  // daily, an open bump PR checked hourly), and "Check now".
  const folioUpdater =
    deps.folioUpdater ||
    createFolioUpdater({
      approvalGate: activeApprovalGate,
      isGaming: deps.isGaming || gamingWatch.isGaming,
      statePath: path.join(acpMemoryStore.dataDir, "folio-update.json"),
      notify: ({ text, url }) => notifyTray({ type: "self-work", title: "Folio update", text, url }),
    });
  if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) folioUpdater.ensureJob(cronSchedulerPlugin.getScheduler());
  app.get("/folio-update", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return res.json(folioUpdater.status());
  });
  app.post("/folio-update", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    folioUpdater.setEnabled(req.body?.enabled === true);
    return res.json(folioUpdater.status());
  });
  app.post("/folio-update/run", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      return res.json(await folioUpdater.run({ force: true }));
    } catch (e) {
      return res.json({ status: "error", error: e.message });
    }
  });
  app.get("/self-work", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return res.json(selfWork.status());
  });
  app.post("/self-work/start", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    // #1009: "Allow guardrail changes" is only ever this route's, with my admin key.
    return res.json(await selfWork.start(req.body?.issue, { allowGuardrails: req.body?.allowGuardrails === true }));
  });
  // #1194: bring one of her own open PRs up to date with main.
  app.post("/self-work/refresh", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return res.json(await selfWork.refresh(req.body?.pr));
  });
  app.post("/self-work/stop", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return res.json({ stopped: selfWork.stop() });
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
      whisperModel: whisperDiscovery.findWhisperModel({ env, language: whisperLanguage() }),
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

  // Barge-in interruption classifier, required once at startup (matches the
  // classifyIntent pattern above) so a module-resolution failure surfaces
  // at startup instead of as a per-request 500.
  const { classifyBargeIn } = require("./utils/barge-in-classifier");

  app.post("/barge-in/classify", (req, res) => {
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
      const evaluation = classifyBargeIn(text);
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
        "🚨 [/barge-in/classify] Router checkpoint failed:",
        err?.message || err,
      );
      return res.status(500).json({
        success: false,
        error: "Internal Server Error",
      });
    }
  });

  // Issue #500: pending-writes approval/rejection routes (previously
  // inline here) moved to server-routes.js's registerPendingWritesRoutes.
  registerPendingWritesRoutes(app, { checkAdminAuth });

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
    if (!checkAdminSecret(req, res, process.env.MANA_ADMIN_SECRET || "")) return;
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

  // #923/#925/#926: Settings > Voice's speech words, mishearing fixes and
  // language. envLanguage: WHISPER_LANGUAGE, which wins over language.
  const speechState = () => ({
    ok: true,
    ...speechVocabulary.state(),
    envLanguage: process.env.WHISPER_LANGUAGE || null,
  });

  app.get("/speech", (req, res) => res.json(speechState()));

  // One of: { addWord }, { removeWord }, { heard, term, confirm },
  // { removeCorrection }, { language }. 409 + needsConfirm when heard may
  // be an ordinary word.
  app.post("/speech", (req, res) => {
    const body = req.body || {};
    try {
      if (body.addWord !== undefined) speechVocabulary.addWord(body.addWord);
      else if (body.removeWord !== undefined) speechVocabulary.removeWord(body.removeWord);
      else if (body.heard !== undefined) speechVocabulary.addCorrection(body.heard, body.term, { confirm: body.confirm === true });
      else if (body.removeCorrection !== undefined) speechVocabulary.removeCorrection(body.removeCorrection);
      else if (body.language !== undefined) speechVocabulary.setLanguage(body.language);
      else return res.status(400).json({ ok: false, error: "nothing to change" });
    } catch (e) {
      return res.status(e.needsConfirm ? 409 : 400).json({ ok: false, error: e.message, needsConfirm: Boolean(e.needsConfirm) });
    }
    return res.json(speechState());
  });

  // #906: Settings > Calendar & email. Credentials go in and never come
  // back out (describe() shows hosts and usernames only). This PC with the
  // admin key only: the body carries an app password, and Test logs in to
  // the saved server.
  function allowMailCalendarRequest(req, res) {
    if (!checkAdminAuth(req, res)) return false;
    if (isLocalAdminRequest(req)) return true;
    res.status(403).json({ ok: false, error: ADMIN_KEY_REQUIRED_ERROR });
    return false;
  }

  app.get("/mail-calendar", (req, res) => {
    if (!allowMailCalendarRequest(req, res)) return;
    return res.json({ ok: true, ...mailCalendarSettings.describe() });
  });

  // { kind: "email", host, port, user, password, mailbox } or { kind:
  // "calendar", url, user, password }; a blank password or url keeps the
  // saved one. { kind, clear: true } removes that account.
  app.post("/mail-calendar", (req, res) => {
    if (!allowMailCalendarRequest(req, res)) return;
    const { kind, clear, ...fields } = req.body || {};
    try {
      const state = clear === true ? mailCalendarSettings.clear(kind) : mailCalendarSettings.set(kind, fields);
      return res.json({ ok: true, ...state });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  });

  // #907: Settings > Briefing. POST takes any of { enabled, time, sections,
  // topics, games }.
  app.get("/briefing", (req, res) => res.json({ ok: true, ...briefing.settings() }));
  app.post("/briefing", (req, res) => {
    try {
      return res.json({ ok: true, ...briefing.update(req.body || {}) });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  });

  // { kind }: log in to the saved account and report what went wrong.
  app.post("/mail-calendar/test", async (req, res) => {
    if (!allowMailCalendarRequest(req, res)) return;
    const kind = req.body?.kind;
    try {
      if (kind !== "email" && kind !== "calendar") throw new Error("kind must be email or calendar");
      const account = mailCalendarSettings.get(kind);
      if (!account) throw new Error(`${kind} isn't set up`);
      const result = kind === "email" ? await checkMail(account) : await checkCalendar(account);
      return res.json({ ok: true, ...(typeof result === "object" ? result : {}) });
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }
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
      // Issue #421: only present when there's a session to report on and
      // remote AI is actually on -- a local-only session has no cost to
      // meter, so the field is omitted entirely rather than sent as zeros.
      let tokenUsage;
      const sessionIdParam = req.query && req.query.sessionId;
      if (sessionIdParam && shouldUseRemoteAi()) {
        const usage = sessionTokenUsage.getUsage(String(sessionIdParam));
        const warnThreshold = Number(process.env.MANA_SESSION_TOKEN_WARN);
        const stopThreshold = Number(process.env.MANA_SESSION_TOKEN_STOP);
        tokenUsage = {
          ...usage,
          warnThreshold: Number.isFinite(warnThreshold) && warnThreshold > 0 ? warnThreshold : null,
          stopThreshold: Number.isFinite(stopThreshold) && stopThreshold > 0 ? stopThreshold : null,
          warnExceeded:
            Number.isFinite(warnThreshold) && warnThreshold > 0 && usage.totalTokens >= warnThreshold,
          stopExceeded:
            Number.isFinite(stopThreshold) && stopThreshold > 0 && usage.totalTokens >= stopThreshold,
        };
      }
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
          chatModel: chatModelLabel(),
        },
        gaming,
        process: getManaProcessSnapshot(),
        operations: perfMetrics.operations,
        ...(tokenUsage ? { tokenUsage } : {}),
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
    // whenever a watched game is running, and back once it closes. Kokoro
    // is started on demand by that switch (kokoro-runtime.js) and stops
    // again after MANA_KOKORO_IDLE_MS without use. Qwen3-TTS has no such
    // switch: it stays loaded and keeps speaking while a game runs.
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
      const audio = await ttsRuntime.synthesizeReply(text, opts.emotion);
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

  // #925: heard is what whisper wrote, transcript the same with my
  // mishearing fixes applied -- what every caller uses. #1107: model and
  // language go into a kept voice clip's sidecar.
  async function runWhisperHeard(filePath) {
    const parakeet = STT_PROVIDER === "parakeet";
    const heard = parakeet
      ? await runParakeet(filePath)
      : ((await transcribeWithWhisperServer(filePath)) ?? runWhisperCli(filePath));
    const model = parakeet
      ? whisperDiscovery.findParakeetModel({ env: process.env })
      : whisperDiscovery.findWhisperModel({ env: process.env });
    return {
      heard,
      transcript: speechVocabulary.correct(heard),
      model: model ? path.basename(model) : null,
      language: whisperLanguage(),
    };
  }

  async function runWhisper(filePath) {
    return (await runWhisperHeard(filePath)).transcript;
  }

  async function runWhisperPartial(filePath) {
    return speechVocabulary.correct(
      (await transcribeWithWhisperServer(filePath)) ?? (await runWhisperCliPartial(filePath)),
    );
  }

  function findParakeetBin() {
    const found = whisperDiscovery.findParakeetBin({ env: process.env });
    if (found) {
      return found;
    }
    throw new Error(
      "Parakeet executable not found under tools/whisper. Set PARAKEET_BIN to a valid parakeet-cli.exe path.",
    );
  }

  function runParakeet(filePath) {
    const parakeetModel = whisperDiscovery.findParakeetModel({ env: process.env });
    if (!parakeetModel) {
      throw new Error(
        "Parakeet model not found under tools/whisper. Set PARAKEET_MODEL to a valid ggml-parakeet-*.bin path.",
      );
    }
    const parakeetBin = findParakeetBin();
    const startedAt = nowMs();
    const outBase = filePath + ".out";
    const outTxt = outBase + ".txt";
    const args = [
      "-m",
      parakeetModel,
      "-f",
      filePath,
      "-t",
      String(whisperThreads()),
      "-otxt",
      "-of",
      outBase,
      "-np",
    ];
    console.log("Running parakeet:", parakeetBin, args.join(" "));
    const r = spawnSync(parakeetBin, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      console.error("parakeet stderr:", r.stderr);
      throw new Error("parakeet failed: " + r.stderr);
    }
    logPerf("parakeet", startedAt);
    let attempts = 0;
    while (!fs.existsSync(outTxt) && attempts < 5) {
      attempts += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (!fs.existsSync(outTxt)) {
      return r.stdout ? r.stdout.trim() : "";
    }
    const text = fs.readFileSync(outTxt, "utf8").trim();
    try {
      fs.unlinkSync(outTxt);
    } catch (e) {}
    return text;
  }

  function runWhisperCli(filePath) {
    const whisperModel = whisperDiscovery.findWhisperModel({ env: process.env, language: whisperLanguage() });
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
      String(whisperThreads()),
      "-l",
      whisperLanguage(),
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
    args.push("--prompt", getWhisperPrompt(), "--carry-initial-prompt");
    console.log("Running whisper:", whisperBin, args.join(" "));
    const r = spawnSync(whisperBin, args, {
      encoding: "utf8",
      // Issue #388: runs on every spoken utterance -- a console flash here
      // would be constant.
      windowsHide: true,
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

  // Runs whisper-cli asynchronously (spawn, not spawnSync) so it doesn't
  // block the event loop -- unlike runWhisperCli above, this is called
  // repeatedly (every ~1.2s) while the user is still speaking, to produce
  // a live partial transcript. A separate function rather than converting
  // runWhisperCli in place: several existing callers (memory-inbox.js
  // explicitly documents "whisper.cpp is sync") assume the synchronous
  // contract, and converting it would risk silently breaking them.
  function spawnWhisperCliAsync(whisperBin, args) {
    return new Promise((resolve, reject) => {
      const child = belowNormal(spawn(whisperBin, args, { windowsHide: true }));
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ status: code, stdout, stderr });
      });
    });
  }

  async function runWhisperCliPartial(filePath) {
    const whisperModel = whisperDiscovery.findWhisperModel({ env: process.env, language: whisperLanguage() });
    if (!whisperModel) {
      throw new Error(
        "Whisper model not found under tools/whisper. Set WHISPER_MODEL to a valid ggml *.bin path.",
      );
    }
    const whisperBin = findWhisperBin();
    const startedAt = nowMs();
    // A distinct suffix from runWhisperCli's ".out" -- self-documents this
    // as the partial-transcription artifact, even though a filename
    // collision isn't actually possible (each upload gets its own tmp path).
    const outBase = filePath + ".partial-out";
    const outJson = outBase + ".json";
    const args = [
      "-m",
      whisperModel,
      "-f",
      filePath,
      "-t",
      String(whisperThreads()),
      "-l",
      whisperLanguage(),
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
    args.push("--prompt", getWhisperPrompt(), "--carry-initial-prompt");
    const r = await spawnWhisperCliAsync(whisperBin, args);
    if (r.status !== 0) {
      console.error("whisper (partial) stderr:", r.stderr);
      throw new Error("whisper (partial) failed: " + r.stderr);
    }
    logPerf("whisper-partial", startedAt);
    // Wait briefly for the JSON file to appear -- async setTimeout, not
    // runWhisperCli's blocking Atomics.wait, since blocking here would
    // defeat the entire point of using spawn over spawnSync.
    let attempts = 0;
    while (!fs.existsSync(outJson) && attempts < 5) {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!fs.existsSync(outJson)) {
      return r.stdout ? r.stdout.trim() : "";
    }
    try {
      const j = JSON.parse(fs.readFileSync(outJson, "utf8"));
      if (j && j.transcription && j.transcription.length > 0) {
        return j.transcription
          .map((s) => s.text)
          .join(" ")
          .trim();
      }
      return r.stdout ? r.stdout.trim() : "";
    } catch (e) {
      console.warn("failed to parse whisper (partial) json", e);
      return r.stdout ? r.stdout.trim() : "";
    } finally {
      // Runs on every path once outJson exists -- an empty transcription
      // (routine on early, mostly-silent polls) or a parse failure must not
      // leak the temp file; this endpoint is polled ~every 1.2s per
      // recording, so a leak here compounds much faster than
      // runWhisperCli's one-shot equivalent.
      try {
        fs.unlinkSync(outJson);
      } catch (e) {}
      try {
        fs.unlinkSync(outBase + ".txt");
      } catch (e) {}
    }
  }

  // Async counterpart to normalizeUploadedAudio -- that function
  // unconditionally spawnSync's ffmpeg on every call (no format
  // short-circuit), which would block the event loop just as badly as the
  // old synchronous whisper call did, defeating the point of
  // runWhisperCliPartial being async. Used only by /transcribe-partial;
  // normalizeUploadedAudio itself and its other callers (/transcribe-only,
  // /transcribe) are untouched, same reasoning as spawnWhisperCliAsync
  // above.
  function normalizeUploadedAudioAsync(file) {
    return new Promise((resolve) => {
      if (!file) {
        throw new Error("no file");
      }
      const tmpPath = file.path;
      const ext = path.extname(file.originalname).toLowerCase();
      const wavPath = tmpPath + ".wav";

      const child = spawn("ffmpeg", ["-y", "-i", tmpPath, wavPath], {
        windowsHide: true,
      });
      child.on("error", () => resolve(fallbackToCopy()));
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ tmpPath, audioPath: wavPath });
        } else {
          resolve(fallbackToCopy());
        }
      });

      function fallbackToCopy() {
        let audioPath = tmpPath;
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
    });
  }

  const runLocalAssistantReply =
    deps.runLocalAssistantReply ||
    (async function runLocalAssistantReply(
      prompt,
      maxTokens = 256,
      profile = "default",
      overrideSystemPrompt = null,
      extraMessages = null,
      onEmptyReply = null,
      thinking = undefined,
    ) {
      return runLocalLlamaReply(prompt, maxTokens, profile, overrideSystemPrompt, extraMessages, onEmptyReply, thinking);
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
  // Issue #331: lets tests swap in a fake llamaServerRuntime (isEnabled,
  // streamLocalAssistantReply, ...) the same way every other local-model
  // call in this function is already overridable via deps.
  const activeLlamaServerRuntime = deps.llamaServerRuntime || llamaServerRuntime;
  // Shared by tool-calling and best-of-N (issue #70): both require
  // llama-server specifically, not the llama-cli fallback.
  const isLlamaServerAvailable =
    deps.isLlamaServerEnabled || (() => activeLlamaServerRuntime.isEnabled());

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
        // Issue #388: no console flash on audio conversion.
        windowsHide: true,
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
    // Issue #421: only passed by call sites that have a REAL per-user
    // session in scope -- the main chat-turn reply path, and
    // acp-memory-store.js's automatic per-session summarization. The
    // background reviewer/connections jobs fold every session's summaries
    // together with no single session in scope, so they're left untracked
    // rather than polluting a "default" bucket with unrelated global usage.
    sessionId = null,
  ) {
    if (!shouldUseRemoteAi()) {
      return null; // no key configured; fall back to local
    }

    if (sessionId) {
      const stopThreshold = Number(process.env.MANA_SESSION_TOKEN_STOP);
      if (
        Number.isFinite(stopThreshold) &&
        stopThreshold > 0 &&
        sessionTokenUsage.getUsage(sessionId).totalTokens >= stopThreshold
      ) {
        console.warn(
          `Remote AI call blocked for session ${sessionId}: token stop threshold (${stopThreshold}) reached.`,
        );
        return null; // falls back to local, same as remote AI being disabled
      }
    }

    const systemPrompt = systemPromptOverride || activeDefaultPrompt();

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
            if (sessionId && j?.usage) {
              sessionTokenUsage.recordUsage(sessionId, j.usage);
            }
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
    // Issue #253: optional out-parameter -- a caller that cares about the
    // model's own expression__set tool call passes a fresh {} and reads
    // `.expression` back off it after the await, instead of this function's
    // return type (a plain string, unchanged, everywhere else) needing to
    // grow a second shape for the one caller that wants it.
    replyMeta = null,
    // Issue #331: optional streaming callback, called with each completed
    // sentence during the first plain local-completion attempt only. See
    // the firstPassStreamed comment below for why it's first-attempt-only.
    onSentence = null,
  ) {
    const prompt = buildScreenAwarePrompt(transcript, screenText, marketText);
    // let: #666's wait below may switch this turn to the fallback profile.
    let normalizedModelProfile = selectLlamaModelProfileForPrompt(
      transcript,
      modelProfile,
    );
    // #675: "think harder" turns thinking on for this turn's replies (tool
    // loop, streamed or plain, and regenerations) with its own bigger
    // budget -- asked for in words, or by the client's thinkHarder request
    // field (the native launcher's deep-thinking toggle). Best-of-N never
    // thinks, so such a turn skips it. undefined (not false) otherwise:
    // the profile's own default then decides.
    // Q12b: or Mana's own deep thinking (deep_thinking__set) is on for this
    // session; a literal thinkHarder: false (the user clicked the lit Think
    // button off) ends it first. Only for callers with a replyMeta (the
    // user's own chat routes), never cron/Discord or other scheduled jobs
    // (#780's replyMeta.scheduled). let: her tool call can switch it
    // mid-reply.
    const userChat = Boolean(replyMeta && !replyMeta.scheduled);
    let manaThinking = false;
    if (userChat) {
      if (replyMeta.thinkHarder === false) deepThinking.set(sessionId, false);
      manaThinking = deepThinking.takeReply(sessionId);
      replyMeta.deepThinking = deepThinking.isOn(sessionId);
    }
    const askedThinkHarder = (replyMeta && replyMeta.thinkHarder === true) || wantsThinkHarder(transcript);
    let thinkHarder = askedThinkHarder || manaThinking || undefined;

    // Determine assistant mode and system prompt
    const inferred = pickAssistantMode(transcript, normalizedModelProfile); // { mode, reason }
    // Use explicit assistantMode if provided; otherwise use inferred.mode
    const mode =
      assistantMode ||
      (inferred && inferred.mode) ||
      (normalizedModelProfile === "coding" ? "coding" : "everyday");
    // Same coding/developer check the system-prompt selection below uses --
    // every actual reply-generation call site in this function should use
    // this instead of LLAMA_MAX_TOKENS directly, so coding replies stop
    // getting cut off mid-example.
    const effectiveMaxTokens =
      mode === "coding" || mode === "developer"
        ? LLAMA_MAX_TOKENS_CODING
        : LLAMA_MAX_TOKENS;
    // #914: group mode adds a second reply only to casual turns.
    if (replyMeta) replyMeta.mode = mode;

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

    // Identity ("who Mana is") comes from persona.js, layered with each
    // mode's own task-specific operational instructions -- these three
    // used to each redefine Mana's personality from scratch, drifting
    // slightly from one another and from persona.js's other consumers.
    let selectedSystemPrompt = persona.buildPersonaPrompt(
      sessionId,
      personalityStore.get().traits,
      personaOf(characterStore.active()),
    );
    // Issue #623: per-sentence emotion tags for the avatar. Static text, so
    // it sits in the cached prefix; every reply path below strips the tags.
    selectedSystemPrompt = `${selectedSystemPrompt}\n\n${EMOTION_TAG_PROMPT}`;
    // Issue #660: the mode is picked per message, so its text is appended
    // last (after the session goal below) -- spliced in right after the
    // persona, a mode switch changed the prompt prefix and cost
    // llama-server its prompt cache for everything after it.
    const CASUAL_MODE_TEXT = `Use short paragraphs and natural conversational phrasing; include occasional friendly flourishes (e.g. "You got this!"). Ask one clarifying question only when necessary. If the user requests professional or safety-sensitive information, politely indicate you cannot provide it and offer to look up resources or recommend professionals.`;
    const EVERYDAY_MODE_TEXT = `Provide clear, concise, and practical guidance. When giving instructions, present them as short numbered steps and include expected outcomes or simple checks when helpful. Use plain language accessible to non-technical users. Offer follow-up actions and ask clarifying questions only when required. For health, legal, or hazardous topics, recommend professional resources.`;
    const CODING_MODE_TEXT = `In this mode, be focused, precise, and technical: start with a one-line summary of intent, then provide minimal, runnable code examples in fenced blocks, followed by a short explanation and a suggested test or verification step. Avoid small talk entirely. Ask only necessary clarifying questions. When the user requests structured output (JSON, patch, or commands), return exactly the machine-readable block unless commentary is explicitly requested. Include assumptions and environment notes when relevant.`;

    let modeText;
    if (mode === "casual" || mode === "chat") {
      modeText = CASUAL_MODE_TEXT;
    } else if (mode === "coding" || mode === "developer") {
      modeText = CODING_MODE_TEXT;
    } else {
      modeText = EVERYDAY_MODE_TEXT;
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

    // Foundational tool-calling (issue #51), on by default (opt out with
    // MANA_TOOL_CALLING_ENABLED=0) and scoped to the "default" profile, the
    // one verified to emit reliable tool_calls (see
    // docs/roadmap/issue-51-tool-calling.md).
    // Hoisted above the skills-index block below: that block must not
    // advertise skill__view unless this same condition lets the model
    // actually call it (see the block's own comment for why).
    const toolCallingEnabled =
      String(process.env.MANA_TOOL_CALLING_ENABLED || "1") !== "0";

    // Always-visible skill index (see buildSkillsIndexBlock above) -- but
    // only when tool-calling can actually act on it. The index advertises
    // skill__view; outside the exact condition replyMaybeWithTools checks
    // below, no reply path can invoke it, and a model told about a tool it
    // can't call tends to narrate the call as plain text instead of either
    // answering normally or invoking nothing (observed: "Skill needed:
    // X\nCalling skill__view with name: X" leaking into a plain reply).
    // activeSkillsStore, not the module-level skillsStore singleton --
    // otherwise this would silently bypass a test's (or any future caller's)
    // deps.skillsStore override, the exact trap already called out where
    // activeSkillsStore is defined above.
    // Issue #401: the session's user-stated goal (if any) -- read
    // unconditionally here since the tool-array construction further
    // below also needs it, but only actually surfaced to the model (as
    // system-prompt text, and as the session_goal__finish tool) when
    // tool-calling is enabled for this reply. Outside that path (a plain
    // conversational reply, remote AI, etc.) there's no way for the model
    // to act on a goal at all, so mentioning it would just be misleading.
    // See ai/session-goal-tool-source.js's own header comment for why the
    // goal itself is never model-writable, only user-settable.
    let sessionGoal = null;
    if (sessionId) {
      try {
        const session = acpMemoryStore.getSession(sessionId);
        sessionGoal = session && session.goal ? session.goal : null;
      } catch (e) {
        // ignore -- goal context is best-effort, never blocks a reply
      }
    }
    // Issue #676: goal mode (opt in with MANA_GOAL_MODE=1) keeps the tool
    // loop going until the goal is done. It needs tools, which coding-routed
    // turns never get, so a goal-mode turn stays on the default profile.
    const goalMode =
      Boolean(sessionGoal) &&
      String((deps.env || process.env).MANA_GOAL_MODE || "0") === "1" &&
      toolCallingEnabled &&
      isLlamaServerAvailable();
    if (goalMode) normalizedModelProfile = "default";

    // Issue #400: buildSkillsIndexBlock already computes how many skills it
    // left out, but only as a line of text baked into the block -- read
    // back out here rather than changing that function's return shape,
    // which other callers/tests still depend on as a bare string.
    let skillsOmittedCount = 0;
    let skillsIndexText = "";
    if (
      toolCallingEnabled &&
      normalizedModelProfile === "default" &&
      isLlamaServerAvailable()
    ) {
      try {
        const skillsIndexBlock = buildSkillsIndexBlock(activeSkillsStore.listSkills());
        if (skillsIndexBlock) {
          skillsIndexText = skillsIndexBlock;
          selectedSystemPrompt = `${selectedSystemPrompt}\n\n${skillsIndexBlock}`;
          const omittedMatch = skillsIndexBlock.match(/\((\d+) more skill\(s\) omitted for length\)/);
          if (omittedMatch) skillsOmittedCount = Number(omittedMatch[1]) || 0;
        }
      } catch (e) {
        // ignore failures here
      }
      if (sessionGoal) {
        selectedSystemPrompt = `${selectedSystemPrompt}\n\nSession goal: ${sessionGoal}\nIf you believe this goal has been fully achieved, call session_goal__finish instead of continuing to use more tools.`;
      }
    }
    selectedSystemPrompt = `${selectedSystemPrompt}\n\n${modeText}`;
    // Issue #677: plugin onUserInput system patches are per turn, so they go
    // after the mode text for the same prompt-cache reason (#660).
    if (replyMeta && replyMeta.systemPatch) {
      selectedSystemPrompt = `${selectedSystemPrompt}\n\n${replyMeta.systemPatch}`;
    }
    // A message about suicide or self-harm gets a care-and-hotlines note for
    // this turn -- per turn, so last, like the mode text. Every chat path
    // (typed, voice, stream, mobile) builds its prompt here.
    const crisisNote = crisisInstruction(transcript, deps.env || process.env);
    if (crisisNote) selectedSystemPrompt = `${selectedSystemPrompt}\n\n${crisisNote}`;

    // Issue #282: memory (session summary/recent-turns, cross-session
    // facts) becomes its own positionable system-role messages -- "early"
    // (right after the persona) or "late" (right before the live user
    // turn, the higher-salience slot) -- for the two reply paths that can
    // take a real messages array (runToolAwareReply, runLocalAssistantReply
    // below). Paths that only take a flat system-prompt string (the OpenAI
    // proxy, Best-of-N) fall back to the old flattened text via
    // flatMemorySuffix so they don't lose memory context entirely.
    //
    // Issue #660: every memory entry built below changes turn to turn, so
    // all of them default to "late" -- anything per-turn placed early would
    // change the prompt prefix and defeat llama-server's prompt cache. The
    // system prompt above stays per-turn-free for the same reason (persona,
    // background memory, name-sorted skills index, session goal), except for
    // the per-message mode text, which goes last so a mode switch only
    // changes its tail; screen and market text already ride on the user
    // message itself.
    const memoryExtraMessages = { early: [], late: [] };
    // #679: images the chat model can see itself (server-routes.js decided);
    // buildMessages puts them on the live user message on every path below.
    if (replyMeta?.images?.length) memoryExtraMessages.images = replyMeta.images;
    let flatMemorySuffix = "";
    let promptMemoryChars = 0;
    let promptMemoryText = "";
    let promptMemoryTruncated = false;
    let turnsDroppedByAge = 0;
    try {
      if (sessionId) {
        const result = await acpMemoryStore.buildPromptMemoryEntries(sessionId);
        for (const entry of result.entries) {
          memoryExtraMessages[entry.position].push({ role: entry.role, content: entry.content });
          flatMemorySuffix += `\n\n${entry.content}`;
          promptMemoryChars += entry.content.length;
          promptMemoryText += `\n\n${entry.content}`;
          if (entry.truncated) promptMemoryTruncated = true;
        }
        turnsDroppedByAge = result.turnsDroppedByAge || 0;
      }
    } catch (memErr) {
      console.warn("Failed to build session memory:", memErr.message);
    }

    // Issue #141: the larger, on-demand tier -- only pulled in when the
    // current message actually names something previously discussed in a
    // *different* session. Bounded by maxChars in getRelatedFactsEntries,
    // so it never grows with total memory volume.
    let relatedFactsChars = 0;
    let relatedFactsText = "";
    let relatedFactsTruncated = false;
    // Issue #674: candidate/kept counts and any recall fallback, for #400.
    let relatedFactsRecall = null;
    try {
      if (typeof acpMemoryStore.getRelatedFactsEntries === "function") {
        const { entries, recall } = await acpMemoryStore.getRelatedFactsEntries(transcript, {
          excludeSessionId: sessionId,
          // Q27: a scheduled job (replyMeta.scheduled) sees confirmed facts only.
          confirmedOnly: Boolean(replyMeta && replyMeta.scheduled),
        });
        relatedFactsRecall = recall || null;
        for (const entry of entries) {
          memoryExtraMessages[entry.position].push({ role: entry.role, content: entry.content });
          flatMemorySuffix += `\n\n${entry.content}`;
          relatedFactsChars += entry.content.length;
          relatedFactsText += `\n\n${entry.content}`;
          if (entry.truncated) relatedFactsTruncated = true;
        }
      }
    } catch (relErr) {
      console.warn("Failed to look up related facts:", relErr.message);
    }

    // Issue #700: her mood, as tone guidance only -- "late" like memory,
    // since it changes turn to turn. It never touches the token budget,
    // tools or mode, and moodPromptBlock leaves coding replies alone.
    // Part of #700: plus "be gentle, don't pry" while I've seemed down for
    // several turns (even with her mood frozen -- that's about me, not her).
    let moodText = "";
    try {
      activeMoodStore.recordTurn(transcript);
      moodText = [moodPromptBlock(activeMoodStore.get(), mode), gentleHint(acpMemoryStore.getUserAffectState(), mode)]
        .filter(Boolean)
        .join("\n");
      if (moodText) {
        memoryExtraMessages.late.push({ role: "system", content: moodText });
        flatMemorySuffix += `\n\n${moodText}`;
      }
    } catch (moodErr) {
      console.warn("Failed to apply mood:", moodErr.message);
    }
    // #914: her own notes on how we get along, same place and rules; in my
    // own chat, now and then one of her milestones (our first chat is one:
    // for Mana, the day of the oldest session).
    try {
      const relationshipText = relationshipPromptBlock(relationshipStore.list(), mode);
      if (userChat) {
        relationshipStore.ensureFirstChat(() =>
          characterStore.active().id === DEFAULT_CHARACTER_ID ? oldestSessionAt() : null,
        );
      }
      const milestoneText = userChat ? relationshipStore.milestoneToMention(mode) : null;
      for (const text of [relationshipText, milestoneText].filter(Boolean)) {
        memoryExtraMessages.late.push({ role: "system", content: text });
        flatMemorySuffix += `\n\n${text}`;
      }
    } catch (relationshipErr) {
      console.warn("Failed to apply relationship notes:", relationshipErr.message);
    }

    // Issue #400: makes the composition of the prompt this reply actually
    // used observable (GET /prompt-composition), instead of only
    // discoverable by reading the code the way #364's truncation bug was.
    // Covers the three blocks gathered unconditionally above (system-prompt
    // folds in persona/preset/background-memory/skills-index/session-goal/mode,
    // since those are all concatenated into one string by this point),
    // before the reply-path branches below diverge; tool schemas and the
    // live turns differ per reply path (tool-aware vs. streaming vs. plain)
    // and aren't included here (#642 adds them once the reply is done).
    //
    // Issue #642: the skills index is its own block now, and each block's
    // text is kept (compositionTexts) so the end of the turn can count its
    // real tokens -- see finalizePromptComposition below.
    const systemPromptText = skillsIndexText
      ? selectedSystemPrompt.replace(`\n\n${skillsIndexText}`, "")
      : selectedSystemPrompt;
    const compositionTexts = {
      "system-prompt": systemPromptText,
      "skills-index": skillsIndexText,
      "prompt-memory": promptMemoryText,
      "related-facts": relatedFactsText,
      mood: moodText,
    };
    let compositionRecord = null;
    try {
      compositionRecord = recordPromptComposition(sessionId, [
        { name: "system-prompt", chars: systemPromptText.length, dropped: null },
        { name: "skills-index", chars: skillsIndexText.length, dropped: { skillsOmitted: skillsOmittedCount } },
        { name: "prompt-memory", chars: promptMemoryChars, dropped: { truncated: promptMemoryTruncated, turnsDroppedByAge } },
        {
          name: "related-facts",
          chars: relatedFactsChars,
          dropped: { truncated: relatedFactsTruncated, ...(relatedFactsRecall ? { recall: relatedFactsRecall } : {}) },
        },
        { name: "mood", chars: moodText.length, dropped: null },
      ]);
    } catch (compErr) {
      // Diagnostic-only; never blocks a reply.
      console.warn("Failed to record prompt composition:", compErr.message);
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
                      await retrieverIndex.computeEmbedding(transcript, { query: true });
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
          await retrieverService.ensure().catch((e) =>
            console.warn("Python retriever unavailable:", e?.message || e),
          );
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
            // NODE_ENV/NODE_TEST_CONTEXT guard (same convention used
            // throughout this file): this fallback is otherwise gated only
            // by fs.existsSync(vectorDir/retrieverScript), both real files
            // present in this repo, so without it a real `spawnSync` to a
            // real (but test-irrelevant) Python vector index runs on every
            // coding-mode reply a test exercises -- ~20s and fails anyway
            // since there's no matching index.
            const skipUnderTest =
              process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
            if (!skipUnderTest && fs.existsSync(vectorDir) && fs.existsSync(retrieverScript)) {
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
                // Issue #388: no console flash on the retriever call.
                windowsHide: true,
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

    // Issue #623: the reply without its emotion tags, applied wherever a
    // pass produces one; replyMeta.emotion is the face for a client that
    // speaks it as one clip (not streamed, or rewritten after streaming).
    const untag = (text) => {
      if (typeof text !== "string") return text;
      const { text: clean, emotions } = stripEmotionTags(text);
      if (replyMeta) replyMeta.emotion = replyEmotion(emotions);
      return clean;
    };

    // Try OpenAI/proxy only when explicitly allowed.
    if (shouldUseRemoteAi()) {
      try {
        const openAiReply = untag(await runOpenAIReply(
          finalPrompt,
          effectiveMaxTokens,
          selectedSystemPrompt + flatMemorySuffix,
          sessionId,
        ));
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
                  // #914: history lines are labelled with who said them.
                  speaker: characterStore.active().name,
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

    // toolCallingEnabled is declared earlier, alongside the skills-index
    // gate above -- both need the same condition. Any failure or empty
    // result from the tool-aware attempt below falls straight back to the
    // plain path rather than surfacing a broken reply.
    // Captured here rather than threaded through replyMaybeWithBestOfN's and
    // the verify/retry loop's return values (both currently just `string`)
    // -- issue #153 needs whatever tool calls actually produced the reply
    // that gets appended to session memory, and a closure-scoped variable
    // gets that without changing any other reply path's signature.
    let lastToolCalls = [];
    // Issue #673: every tool that has returned so far this turn (across
    // regeneration attempts too), so a memory write can tell whether it may
    // be repeating content a tool brought in (memory-tool-source.js).
    const turnTools = [];

    // Issue #331: onSentence streams only the very first plain local-
    // completion attempt. Regeneration (rut-detection nudge, verify/retry)
    // reuses replyMaybeWithBestOfN/replyMaybeWithTools too, but must not
    // stream again -- multiple overlapping sentence streams from separate
    // generation attempts would be nonsensical to a client. This flag makes
    // "first call only" explicit rather than relying on call order.
    let firstPassStreamed = false;
    const streamedSentences = [];
    // Issue #623: each sentence goes out without its emotion tags, with the
    // face it's said with. An untagged sentence keeps the previous one's;
    // a bare tag (the chunker cut it off as its own "sentence") only sets
    // the face for the next.
    let sentenceEmotion = null;
    const wrappedOnSentence = onSentence
      ? async (tagged) => {
          const { text: sentence, emotions } = stripEmotionTags(tagged);
          if (emotions.length) sentenceEmotion = emotions[0];
          if (!sentence) return;
          streamedSentences.push(sentence);
          await onSentence(sentence, sentenceEmotion);
        }
      : null;

    // Issue #642: what the reply's own completion was sent -- the user turn
    // and, on the tool-aware path, the tool schemas -- and llama-server's
    // real size of that prompt. A regeneration pass calls this again and
    // the last one wins, same as lastToolCalls. Compared by identity: the
    // runtime keeps a fresh object per completion, so an unchanged one
    // means this pass never reached llama-server (llama-cli fallback).
    let turnToolSchemas = [];
    let turnPromptUsage = null;
    // #646: this pass's entry in GET /agent/activity; its stop flag is
    // read by the executeTool wrapper below.
    let activityRun = null;
    async function replyMaybeWithTools(promptText) {
      turnToolSchemas = [];
      const usageBefore = activeLlamaServerRuntime.getLastPromptUsage?.();
      activityRun = agentActivity.start();
      // #1122: the Browser tool lists the web pages this turn took in.
      activeBrowserAutomationToolSource.activityLog.recordTurnPages(untrustedLinks(promptText));
      let reply;
      try {
        reply = await replyMaybeWithToolsUnmetered(promptText);
      } finally {
        agentActivity.finish(activityRun);
        // #1159: her task is over; only the tab she's on stays open.
        browserAutomationPlugin.closeExtraTabs().catch(() => {});
      }
      const usageAfter = activeLlamaServerRuntime.getLastPromptUsage?.();
      turnPromptUsage = usageAfter && usageAfter !== usageBefore ? usageAfter : null;
      compositionTexts["user-turn"] = promptText;
      return reply;
    }

    async function replyMaybeWithToolsUnmetered(promptText) {
      lastToolCalls = [];
      if (
        toolCallingEnabled &&
        normalizedModelProfile === "default" &&
        isLlamaServerAvailable()
      ) {
        try {
          // Issue #169/#267: merged fresh per reply, not cached -- MCP tool
          // discovery is async and the registered-server list is small
          // enough that re-listing costs little once a connection is
          // already established (see mcp-client-registry.js). One generic
          // buildToolPolicy call folds in every source at once instead of
          // a hand-rolled buildToolPolicyWithX chain.
          //
          // Memory (issue #198): bound to this reply's sessionId (not
          // model-supplied), built fresh per reply for the same reason --
          // cheap, and the session the fact should be attributed to only
          // exists per-call. approvalGate: a model-asserted memory write is
          // agent-authored content same as a skill write (issue #152) --
          // gated the same way, see ai/memory-tool-source.js.
          //
          // Session search: full-text search across past conversations,
          // independent of the curated memory summary above.
          //
          // Skill creation (issue #262 follow-up): user-requested mid-
          // conversation ("make a skill that does X") -- distinct from the
          // idle-triggered autonomous proposal pass, which nobody
          // explicitly asked for. Despite the direct ask, this still stays
          // genuinely pending like the idle pass does, not auto-approved
          // like the Settings UI's own create flow -- the drafted content
          // is the model's own text, not the user's verbatim words, and a
          // page Mana read earlier in the same turn could otherwise talk
          // it into staging attacker-authored content (see
          // ai/skill-tool-source.js).
          //
          // Browser automation (issue #188): only offered when the plugin
          // is actually enabled (Settings > Plugins) -- same gate every
          // other browser-automation entry point (its own HTTP routes,
          // GET /plugins) already respects.
          // #1158: files whose full path I write in my own chat message are
          // the ones her browser may upload (never ones she picks herself).
          if (userChat) browserAutomationPlugin.offerFilesFromMessage(transcript);
          let mergedToolPolicy = await buildToolPolicy(activeToolPolicy, [
            activeMcpClientRegistry,
            createMemoryToolSource({
              acpMemoryStore,
              sessionId,
              approvalGate: activeApprovalGate,
              // Issue #317: deliberately `transcript` (the raw user turn),
              // not `prompt`/`finalPrompt` -- both of those are already
              // blended with screen OCR, market data, and retrieved web
              // content by this point, which would let a memory__remember
              // call "attribute" itself to injected content instead of
              // something the user actually said.
              userMessage: transcript,
              // Issue #431: LLM-confirmed conflict judging -- never loads
              // or swaps a model, see llamaServerRuntime's own comment on
              // isProfileAlreadyLoaded/runLocalReplyIfSafelyLoaded.
              runLocalReply: llamaServerRuntime.runLocalReplyIfSafelyLoaded,
              turnTools,
            }),
            createSessionSearchToolSource({ acpMemoryStore, sessionId }),
            createSkillToolSource({ approvalGate: activeApprovalGate, skillsStore: activeSkillsStore }),
            createSnapshotToolSource({
              approvalGate: activeApprovalGate,
              snapshotStore,
              // Issue #475 whole-branch review: without this, a file-kind
              // restore skips the workspace-containment check that
              // getEditorIntegrations().restoreEditSnapshot already
              // enforces for the REST/UI restore path.
              restoreFileSnapshot: (id, opts) => getEditorIntegrations().restoreEditSnapshot(id, opts),
            }),
            // Issue #253: lets Mana pick her own Live2D expression for this
            // reply, alongside (not instead of) reply-emotion.js's automatic
            // detection. No approvalGate/store needed -- see
            // ai/expression-tool-source.js's own header comment for why.
            createExpressionToolSource(),
            // #923/#925: speech words and mishearing fixes I ask for;
            // only words from this turn's own text (see the source).
            createSpeechToolSource({ speechVocabulary, userMessage: transcript }),
            // Issue #417: lets Mana decide mid-reply that seeing the screen
            // would help, instead of vision only being reachable via the
            // hotkey or the ambient screen-sensing loop. Same
            // deps.X || fallback resolution registerCoreRoutes's deps use
            // for these two below (server.js:4742-4747) -- no single
            // shared local exists at this point in registerRoutes to reuse.
            createVisionToolSource({
              getVisionStatus:
                deps.getVisionStatus || (() => llamaServerRuntime.getVisionStatus()),
              runVisionReply:
                deps.runVisionReply ||
                ((prompt, images, maxTokens) =>
                  llamaServerRuntime.runVisionReply(prompt, images, maxTokens)),
              visionCaptureBridge,
              screenSensingPlugin,
              pluginSettingsStore: activePluginSettingsStore,
            }),
            // Issue #276: draft a proposed code change as a diff file
            // instead of editing live -- reuses the existing editor
            // workspace/proposal machinery (zed-integration.js) that
            // already backs the /editors/* admin routes, just stops short
            // of ever calling approveEditProposal.
            // #787: approvalGate enables coding__run_tests (asks first).
            createCodingToolSource({ editors: getEditorIntegrations(), approvalGate: activeApprovalGate, reviewEdit }),
            ...(isPluginEnabled(browserAutomationPlugin, activePluginSettingsStore)
              ? [activeBrowserAutomationToolSource]
              : []),
            // Issue #401: only offered when this session actually has a
            // goal set -- there's nothing to finish otherwise, and no
            // reason to spend schema tokens advertising it on every reply.
            ...(sessionGoal ? [createSessionGoalToolSource()] : []),
            // #675 Q12b: Mana turns deep thinking on/off herself; the rest
            // of this reply's tool rounds follow it at once.
            // #905: reminders the user asks for in chat -- not offered to
            // scheduled replies, which nobody is asking in.
            ...(userChat ? [createReminderToolSource({ getScheduler: cronSchedulerPlugin.getScheduler, sessionId })] : []),
            // #1010: "let me try your PR" / "back to main" -- a PR number
            // only from my own message. #1194: "update to main" asks me first.
            ...(userChat
              ? [
                  createTryPrToolSource({
                    userMessage: transcript,
                    revert: reverter.revert,
                    approvalGate: activeApprovalGate,
                    isGaming: deps.isGaming || gamingWatch.isGaming,
                  }),
                ]
              : []),
            // #1008: "work on #N" -- only a number from my own message.
            ...(userChat ? [selfWork.chatToolSource(transcript)] : []),
            // #1182: git and GitHub, only in my own chat.
            ...(userChat ? [gitTools] : []),
            // #906: my email and calendar, only in my own chat (never a
            // scheduled reply or a Discord/Telegram bridge).
            ...(userChat
              ? [createMailCalendarToolSource({ store: mailCalendarSettings, approvalGate: activeApprovalGate })]
              : []),
            // #911: media keys, volume, apps, audio output, file moves --
            // only when I'm asking.
            ...(userChat
              ? [
                  createDesktopToolSource({
                    bridge: visionCaptureBridge,
                    isGaming: deps.isGaming || gamingWatch.isGaming,
                    voice: replyMeta.voice === true,
                    snapshotStore,
                  }),
                ]
              : []),
            // #907: "brief me".
            ...(userChat ? [briefing.toolSource] : []),
            // #914: her own notes on our relationship.
            // Each new note is a chat line (replyMeta.onNoted), so I see it.
            ...(userChat
              ? [
                  createRelationshipToolSource({
                    store: relationshipStore,
                    onNoted: ({ kind, id, text, date }) => {
                      const character = characterStore.active();
                      replyMeta.onNoted?.({ kind, id, text, date, character: character.id, characterName: character.name });
                    },
                  }),
                ]
              : []),
            ...(userChat
              ? [
                  createDeepThinkingToolSource({
                    onSet: (on) => {
                      // Already on for this reply: asking again mustn't
                      // restart the 10-reply cap.
                      if (!(on && manaThinking)) deepThinking.set(sessionId, on);
                      replyMeta.deepThinking = deepThinking.isOn(sessionId);
                      thinkHarder = askedThinkHarder || on || undefined;
                    },
                  }),
                ]
              : []),
          ]);
          // Issue #281: on the "fast" (small) profile, protect its limited
          // context from a large tool catalogue and from raw tool-result
          // payloads -- both reuse this same already-loaded model rather
          // than a dedicated filter model, and both are pure best-effort
          // (any failure falls back to the unfiltered/uncompressed
          // behavior, never blocks the reply). Skipped entirely on
          // "quality"/"coding" profiles, which have the context headroom
          // to not need either pass.
          if (modelManagement.getActiveProfile() === "fast") {
            mergedToolPolicy.tools = await filterRelevantTools({
              tools: mergedToolPolicy.tools,
              queryText: promptText,
              runLocalReply: runLocalLlamaReply,
            });
            mergedToolPolicy = wrapWithResultDigest(mergedToolPolicy, {
              runLocalReply: runLocalLlamaReply,
            });
          }
          // Issue #426: the user's own PreToolUse/PostToolUse-style hook
          // rules (deny/ask/run-command), applied *before* (wrapped inside)
          // wrapWithToolCallLog below -- so a denied or ask-gated call still
          // lands in the audit trail as its own logged event, additive to
          // both existing gates rather than replacing either.
          mergedToolPolicy = wrapWithHooks(mergedToolPolicy, activeHooksStore, activeApprovalGate, {
            snapshotStore,
          });
          // Issue #669: per-call risk tiers. Destructive calls (rm -rf,
          // registry edits, iwr | iex, credential files...) always go to a
          // human; the mode (Settings > Approvals, else MANA_TOOL_APPROVAL,
          // else "smart") decides the rest. Outside
          // wrapWithHooks so a destructive call is reviewed before any hook
          // runs; inside wrapWithToolCallLog so the outcome is logged.
          // #699: a heartbeat check brings its own gate (its grants and
          // scope) in place of this one.
          mergedToolPolicy =
            typeof replyMeta?.wrapToolPolicy === "function"
              ? replyMeta.wrapToolPolicy(mergedToolPolicy, activeApprovalGate)
              : wrapWithRiskGate(mergedToolPolicy, activeApprovalGate, {
                  mode: resolveToolApprovalMode(
                    activeApprovalGate.getToolApprovalMode(),
                    (deps.env || process.env).MANA_TOOL_APPROVAL,
                  ),
                  // A web page, search/wiki results or the browser tab
                  // (framed by ai/untrusted-content.js) came in with the turn.
                  untrustedSources: untrustedSources(promptText),
                });
          // Issue #188: applied last so it catches every tool call from
          // every source (local read_file, browser-automation, MCP) in one
          // shared audit/trace log.
          mergedToolPolicy = wrapWithToolCallLog(mergedToolPolicy, activeToolCallLog, () =>
            activeMoodStore.record("task_failed"),
          );
          // #486: modify-input hook rules rewrite args first, so every gate
          // above and the audit log see the rewritten call, never the original.
          mergedToolPolicy = wrapWithInputHooks(mergedToolPolicy, activeHooksStore);
          const executeLoggedTool = mergedToolPolicy.executeTool;
          // #661: /reply/stream relays tool start/end so the avatar can
          // show she's working. expression__set is her face, not work.
          const onToolCall =
            replyMeta && typeof replyMeta.onToolCall === "function" ? replyMeta.onToolCall : null;
          const run = activityRun;
          const reportTool = (name, phase) => {
            if (isExpressionToolName(name)) return;
            if (phase === "start") agentActivity.toolStarted(run, name);
            else agentActivity.toolEnded(run, name);
            if (!onToolCall) return;
            try {
              onToolCall({ name, phase });
            } catch (e) {}
          };
          mergedToolPolicy.executeTool = async (name, args) => {
            // #646: Stop from the activity panel. The tool already running
            // finishes; every later call is refused, so the model answers
            // or the loop's own 3-consecutive-errors cap makes it.
            // ponytail: no runtime change (it's mid-edit in #770/#787) --
            // a stop check in runToolAwareReply's budget test would end
            // the loop without those extra refused rounds.
            if (run.stopRequested) {
              throw new Error("Stopped by the user. Don't call any more tools; answer with what you have.");
            }
            reportTool(name, "start");
            try {
              // #1121: a command this call runs is stopped by this loop's Stop.
              const result = await terminalFeed.runWith({ stop: () => agentActivity.stop(run.id) }, () =>
                executeLoggedTool(name, args),
              );
              turnTools.push(name);
              return result;
            } finally {
              reportTool(name, "end");
            }
          };
          const toolResult = await runToolAwareReply(
            promptText,
            mergedToolPolicy,
            {
              maxTokens: effectiveMaxTokens,
              profile: normalizedModelProfile,
              overrideSystemPrompt: selectedSystemPrompt,
              extraMessages: memoryExtraMessages,
              thinking: () => thinkHarder,
              goal: goalMode ? sessionGoal : null,
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
              // Issue #253: reported via the replyMeta out-parameter, not a
              // return-value change -- buildAssistantReply's return type
              // stays a plain string for every one of its 5 call sites
              // (mana-acp-agent.js, mobile-routes.js x2, server-routes.js x2),
              // same reasoning already documented above for lastToolCalls.
              if (replyMeta) {
                // Last successful call wins, not first -- runToolAwareReply
                // supports multiple tool-calling rounds, so a model that
                // calls expression__set more than once in one reply is
                // revising its choice; the final pick is the one that
                // reflects "Mana's expression for this reply."
                const expressionCall = [...toolResult.toolCalls]
                  .reverse()
                  .find((call) => isExpressionToolName(call.name) && call.ok);
                if (expressionCall) {
                  const name = String(expressionCall.args?.name || "").trim();
                  if (name) replyMeta.expression = name;
                }
              }
            }
            turnToolSchemas = mergedToolPolicy.tools;
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
      if (wrappedOnSentence && !firstPassStreamed && isLlamaServerAvailable()) {
        // Set before the attempt, not just on success -- sentences may
        // already have been emitted (and possibly spoken client-side)
        // before a failure, so a later regeneration must not stream again.
        firstPassStreamed = true;
        try {
          return await activeLlamaServerRuntime.streamLocalAssistantReply(promptText, {
            maxTokens: effectiveMaxTokens,
            profile: normalizedModelProfile,
            overrideSystemPrompt: selectedSystemPrompt,
            extraMessages: memoryExtraMessages,
            onSentence: wrappedOnSentence,
            thinking: thinkHarder,
          });
        } catch (e) {
          console.warn(
            "Streaming local reply failed, falling back to non-streaming:",
            e && e.message ? e.message : e,
          );
        }
      }
      return runLocalAssistantReply(
        promptText,
        effectiveMaxTokens,
        normalizedModelProfile,
        selectedSystemPrompt,
        memoryExtraMessages,
        () => replyWithBackup(promptText),
        thinkHarder,
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
        !goalMode &&
        // #679: Best-of-N builds its own messages without the images.
        !replyMeta?.images?.length &&
        mode === "coding" &&
        !thinkHarder &&
        isLlamaServerAvailable()
      ) {
        try {
          const n = Number(process.env.MANA_BEST_OF_N_COUNT || 3);
          const result = await runBestOfNReply(promptText, {
            n,
            maxTokens: effectiveMaxTokens,
            profile: normalizedModelProfile,
            overrideSystemPrompt: selectedSystemPrompt + flatMemorySuffix,
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

    const BACKUP_NOTICE = "My main model isn't answering, so I'm using my backup.";
    let usedBackup = false;
    // #666: wait out a llama-server (re)start instead of failing the turn,
    // telling a streaming client once, as a spoken sentence. Not in
    // streamedSentences, so it never counts against streamedMatchesFinal.
    // If nothing comes up, the paths below fall back to llama-cli as before.
    // Gated on the runtime's own isEnabled (false under the test runner), not
    // the deps.isLlamaServerEnabled override: a test that only stubs that
    // override must never reach a real llama-server start from here.
    if (
      activeLlamaServerRuntime.waitForServer &&
      activeLlamaServerRuntime.isEnabled()
    ) {
      try {
        const readyProfile = await activeLlamaServerRuntime.waitForServer(
          normalizedModelProfile,
          onSentence ? () => onSentence("Give me a second, I'm waking up.") : null,
          memoryExtraMessages.images,
        );
        if (readyProfile !== normalizedModelProfile) {
          console.warn(`Mana: ${normalizedModelProfile} model unavailable, answering with ${readyProfile}`);
          if (onSentence) onSentence(BACKUP_NOTICE);
          normalizedModelProfile = readyProfile;
          usedBackup = true;
        }
      } catch (e) {
        console.warn("llama-server still unavailable after waiting:", e && e.message ? e.message : e);
      }
    }

    // #666: an empty reply (after the runtime's own retry) gets one try on
    // the backup model before llama-cli -- once per turn, including a switch
    // the wait above already made, so the notice is said at most once.
    async function replyWithBackup(promptText) {
      if (usedBackup) return null;
      usedBackup = true;
      try {
        const backup = activeLlamaServerRuntime.backupProfileFor?.(normalizedModelProfile);
        if (!backup) return null;
        const backupReply = await activeLlamaServerRuntime.runLocalAssistantReply(
          promptText,
          effectiveMaxTokens,
          backup,
          selectedSystemPrompt,
          memoryExtraMessages,
        );
        console.warn(`Mana: ${normalizedModelProfile} model gave an empty reply, answered with ${backup}`);
        if (onSentence) onSentence(BACKUP_NOTICE);
        normalizedModelProfile = backup;
        return backupReply;
      } catch (e) {
        console.warn("Backup model reply failed, falling back to llama-cli:", e && e.message ? e.message : e);
        return null;
      }
    }

    // Fall back to local llama
    let reply = untag(await replyMaybeWithBestOfN(finalPrompt));

    // Conversational rut detection (issue #159), general reply path: the
    // Best-of-N branch above already prefers a less-repetitive candidate
    // when one exists, but every reply -- Best-of-N or not -- funnels
    // through here, so this is where casual/everyday replies (where
    // verbal-tic repetition actually shows up) get covered too. Only one
    // regeneration attempt, with an explicit nudge -- if that's still a
    // rut, send it rather than looping.
    try {
      const rutEnabled = String(process.env.MANA_RUT_DETECTION_ENABLED || "1") === "1";
      // #676: never regenerate a goal-mode reply -- that reruns the whole loop, tool calls included.
      if (rutEnabled && !goalMode && sessionId && acpMemoryStore && typeof reply === "string") {
        const recentReplies = (acpMemoryStore.getSession(sessionId)?.turns || [])
          .map((t) => t.assistant)
          .filter(Boolean);
        const check = rutDetector.checkReply(sessionId, reply, recentReplies);
        if (check.isRut) {
          const nudgedPrompt = `${finalPrompt}\n\nYour last several replies have repeated similar phrasing. Say this differently -- vary your wording and sentence structure instead of reusing recent lines.`;
          const regenerated = await replyMaybeWithBestOfN(nudgedPrompt);
          if (typeof regenerated === "string" && regenerated.trim()) {
            reply = untag(regenerated);
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
          if (autoRetry && !goalMode && attempts <= maxRetries) {
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
              reply = untag(await replyMaybeWithBestOfN(fixPrompt));
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
            speaker: characterStore.active().name,
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
    if (replyMeta) {
      replyMeta.streamedMatchesFinal = streamedMatchesFinal(streamedSentences, reply);
    }
    // #642 (Q33c): once per conversation, at 90% of the context window,
    // Mana ends this reply by suggesting a fresh chat. Added after the
    // stream check (like #666's notice, it's an extra sentence, not a
    // changed reply) and after the turn went to memory. Rides on a reply
    // the user asked for, so it's fine while gaming too.
    const contextSize = turnPromptUsage ? await activeLlamaServerRuntime.getContextSize?.() : null;
    const fullNote = turnPromptUsage && typeof reply === "string"
      ? contextFullNote(sessionId, turnPromptUsage.promptTokens, contextSize)
      : "";
    if (fullNote) {
      reply = `${reply.trimEnd()} ${fullNote}`;
      // Streamed and unchanged: speak it as one more sentence. Otherwise the
      // client speaks the final reply, which now ends with it.
      if (onSentence && replyMeta?.streamedMatchesFinal) await onSentence(fullNote);
    }
    // Issue #642: the context meter (GET /prompt-composition/:sessionId).
    // Not awaited -- a few local /tokenize calls are never worth delaying
    // the reply for; until they land the record shows char/4 estimates.
    if (compositionRecord) {
      const isMcp = (tool) => String(tool?.function?.name || "").startsWith("mcp__");
      const localTools = turnToolSchemas.filter((tool) => !isMcp(tool));
      const mcpTools = turnToolSchemas.filter(isMcp);
      (async () =>
        finalizePromptComposition(compositionRecord, {
          texts: {
            ...compositionTexts,
            "tool-schemas": localTools.length ? JSON.stringify(localTools) : "",
            "mcp-tool-schemas": mcpTools.length ? JSON.stringify(mcpTools) : "",
          },
          promptUsage: turnPromptUsage,
          contextSize: contextSize ?? (await activeLlamaServerRuntime.getContextSize?.()),
          countTokens: activeLlamaServerRuntime.countTokens,
        }))().catch((e) => console.warn("Failed to finalize prompt composition:", e?.message || e));
    }
    return reply;
  }

  registerCoreRoutes(app, upload, {
    UNIVERSALIS_DEFAULT_WORLD,
    TTS_PROVIDER,
    SCREEN_CONTEXT_MAX_CHARS,
    currentGame: deps.currentGame || currentGame,
    restartController: deps.restartController || createRestartController(),
    buildAssistantReply: deps.buildAssistantReply || buildAssistantReply,
    characters: characterStore,
    buildGroupReaction: deps.buildGroupReaction || buildGroupReaction,
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
                speaker: characterStore.active().name,
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
      }),
    runVisionReply:
      deps.runVisionReply ||
      ((prompt, images, maxTokens, overrideSystemPrompt) =>
        llamaServerRuntime.runVisionReply(prompt, images, maxTokens, overrideSystemPrompt)),
    getVisionStatus:
      deps.getVisionStatus || (() => llamaServerRuntime.getVisionStatus()),
    // #679: false under the test runner (runtime disabled), so route tests
    // take the describe-first path unless they pass their own.
    chatAcceptsImages:
      deps.chatAcceptsImages ||
      ((profile) => llamaServerRuntime.isEnabled() && llamaServerRuntime.chatAcceptsImages(profile)),
    resolveVisionCapture:
      deps.resolveVisionCapture || visionCaptureBridge.resolveCapture,
    rejectVisionCapture:
      deps.rejectVisionCapture || visionCaptureBridge.rejectCapture,
    runWhisper: deps.runWhisper || runWhisper,
    runWhisperHeard: deps.runWhisperHeard || runWhisperHeard,
    runWhisperPartial: deps.runWhisperPartial || runWhisperPartial,
    normalizeUploadedAudioAsync:
      deps.normalizeUploadedAudioAsync || normalizeUploadedAudioAsync,
    synthesizeReply: deps.synthesizeReply || synthesizeReply,
  });

  // #914 group mode: the partner's short reaction to her sister's reply,
  // run inside speakAs(partner) so the persona, personality and mood are
  // hers. Same chat model, one short call; no tools and no emotion tags.
  // The route saves it (only if it's still wanted).
  async function buildGroupReaction({ sessionId, userText, sister, reply }) {
    const me = characterStore.active();
    const system = [
      persona.buildPersonaPrompt(sessionId, personalityStore.get().traits, personaOf(me)),
      moodPromptBlock(activeMoodStore.get(), "casual"),
    ]
      .filter(Boolean)
      .join("\n\n");
    const prompt = `I said: "${userText}"\n\nYour sister ${sister.name} answered: "${reply}"\n\nAdd one short reaction to her, one or two short sentences, as yourself. Don't repeat what she said.`;
    const raw = shouldUseRemoteAi()
      ? await runOpenAIReply(prompt, GROUP_REACTION_MAX_TOKENS, system, sessionId)
      : await runLocalAssistantReply(prompt, GROUP_REACTION_MAX_TOKENS, "default", system);
    return cleanLlamaOutput(stripEmotionTags(String(raw || "")).text).trim();
  }

  // Test-only hook (same pattern as app.locals.broadcastTrayNotification
  // below): exposes the real buildAssistantReply closure -- with its
  // deps-aware isLlamaServerAvailable/runLocalAssistantReply/etc. already
  // bound -- so tests can call it directly without going through the /reply
  // HTTP route, which is the only other way to reach it.
  app.locals.buildAssistantReply = deps.buildAssistantReply || buildAssistantReply;
  // Same pattern, for tests that need to drive the real acpMemoryStore
  // directly (e.g. triggering its automatic summarizeFn compaction) rather
  // than going through an HTTP route.
  app.locals.acpMemoryStore = deps.acpMemoryStore || acpMemoryStore;

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
    mobileTotpSecret: deps.mobileTotpSecret,
    verifyTotpCode: deps.verifyTotpCode,
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
  // an extra layer beyond just "the API key has role=admin": ADMIN_TOKEN,
  // or the native launcher's per-run key from this PC (#670, admin-key.js),
  // so a leaked admin API key alone isn't enough to manage accounts.
  function requireAdmin(req, res, next) {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin role required" });
    }
    if (hasAdminKey(req, { local: isLocalRestartRequest(req) })) {
      return next();
    }
    return res.status(403).json({ error: ADMIN_KEY_REQUIRED_ERROR });
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
      res.json(currentMemoryNotes());
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // POST /v1/chat/completions — OpenAI-compatible chat endpoint (issue #95),
  // so external tools (Obsidian Copilot, etc.) can point at Mana directly
  // instead of only talking to Mana's own bespoke routes. Proxies straight
  // through to the persistent llama-server's own OpenAI endpoint; unlike
  // runLocalAssistantReply this does not inject Mana's persona system
  // prompt, since external clients bring their own messages -- apart from
  // the crisis note (utils/crisis-check.js) when the last user message needs it.
  app.post("/v1/chat/completions", authMiddleware, async (req, res) => {
    if (!activeLlamaServerRuntime.isEnabled()) {
      return res.status(503).json({
        error: {
          message:
            "llama-server mode is disabled; /v1/chat/completions requires MANA_LLAMA_SERVER to be enabled (see docs/API_KEYS.md).",
        },
      });
    }
    try {
      const upstream = await activeLlamaServerRuntime.proxyChatCompletion(withCrisisInstruction(req.body, deps.env || process.env));
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
      res.on("close", () => activeLlamaServerRuntime.scheduleIdleShutdown());
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

  // Plugin store API endpoints. Previously lived in startServer() (bolted
  // onto `app` after createApp() had already returned), which meant no
  // test using this codebase's actual pattern -- createApp(deps) +
  // withServer() -- could ever reach them; moved here so deps.pluginStore/
  // deps.pluginSettingsStore/deps.fetchAvailablePlugins can be injected
  // like every other route in this function, and CI actually exercises
  // them. Also fixes real bugs found in the process:
  // - referenced a separate, independently-buggy plugin-manager.js
  //   instead of the already-hardened plugin-store.js (pluginStore) --
  //   swapped to that.
  // - the consent routes shadowed the correct module-scope
  //   pluginSettingsStore (line 674-ish, aliased here as
  //   activePluginSettingsStore) with `require("./plugin-settings-store")
  //   .pluginSettingsStore`, which doesn't exist (that module only
  //   exports createPluginSettingsStore) -- always undefined, so both
  //   routes threw on every call. Removed the shadowing require.
  // - toggle used to call a togglePlugin() that doesn't exist on
  //   pluginStore; now uses activePluginSettingsStore.setEnabled(), the
  //   same enable/disable mechanism every other plugin/capability in this
  //   file already uses (see GET /plugins).
  const activePluginStore = deps.pluginStore || pluginStore;
  const fetchAvailablePlugins =
    deps.fetchAvailablePlugins ||
    (() =>
      new Promise((resolve, reject) => {
        https
          .get(
            "https://api.github.com/repos/Yuuzulight/Mana/contents/tools/plugins",
            (res) => {
              let data = "";
              res.on("data", (chunk) => (data += chunk));
              res.on("end", () => {
                try {
                  resolve(JSON.parse(data));
                } catch (e) {
                  reject(e);
                }
              });
              res.on("error", reject);
            },
          )
          .on("error", reject);
      }));

  app.get("/plugins/store", async (req, res) => {
    try {
      const installed = activePluginStore.list();
      const available = await fetchAvailablePlugins();

      const githubPlugins = Array.isArray(available)
        ? available
            .filter((item) => item.name.endsWith("/"))
            .map((item) => ({
              name: item.name.replace("/", ""),
              url: `https://github.com/Yuuzulight/Mana/tree/main/tools/plugins/${item.name}`,
              description: "Official Mana plugin from GitHub",
              category: "Core",
            }))
        : [];

      const allPlugins = [
        ...installed.map((plugin) => ({
          name: plugin.name,
          url: `https://github.com/Yuuzulight/Mana/tree/main/tools/plugins/${plugin.name}`,
          description: plugin.description || "Installed plugin",
          category: "User Installed",
          enabled: activePluginSettingsStore.isEnabled(plugin.name),
        })),
        ...githubPlugins,
      ];

      // Segment by tier (plugin vs addon) -- default to "plugin" if not specified
      const plugins = allPlugins.filter((p) => p.tier === "plugin" || !p.tier);
      const addons = allPlugins.filter((p) => p.tier === "addon");

      res.json({
        installed,
        available: githubPlugins,
        all: allPlugins,
        plugins,
        addons,
      });
    } catch (error) {
      console.error("[PluginStore] Failed to fetch plugins:", error.message);
      res.status(500).json({ error: `Failed to fetch plugins: ${error.message}` });
    }
  });

  app.get("/addons/consent/:name", (req, res) => {
    try {
      const name = req.params.name;
      const consentKey = `addon_consent_${name}`;
      const consented = activePluginSettingsStore.getConsent(consentKey);

      res.json({
        consented: consented === true,
        required: name.startsWith("@mana/"), // Add-Ons require explicit consent
      });
    } catch (error) {
      console.error("[PluginStore] Failed to check addon consent:", error.message);
      res.status(500).json({ error: `Failed to check consent: ${error.message}` });
    }
  });

  app.post("/addons/consent/:name", (req, res) => {
    try {
      const name = req.params.name;

      if (!req.body || typeof req.body.consented !== "boolean") {
        return res.status(400).json({ error: "consented field is required" });
      }

      const consentKey = `addon_consent_${name}`;
      activePluginSettingsStore.setConsent(consentKey, req.body.consented);

      res.json({ ok: true, name });
    } catch (error) {
      console.error("[PluginStore] Failed to record addon consent:", error.message);
      res.status(500).json({ error: `Failed to record consent: ${error.message}` });
    }
  });

  app.post("/plugins/store/install", async (req, res) => {
    // CodeQL review: installFromLocal can read an arbitrary local file path
    // -- a legitimate admin capability (same trust level as e.g. the
    // /admin/plugins_install.html UI this backs), not something any
    // unauthenticated caller should be able to trigger. Same
    // checkAdminAuth gate every other sensitive route in this file already
    // uses.
    if (!checkAdminAuth(req, res)) return;
    try {
      const { sourceType, urlOrPath } = req.body || {};

      if (!sourceType || !urlOrPath) {
        return res.status(400).json({ error: "sourceType and urlOrPath are required" });
      }

      let result;
      if (sourceType === "github") {
        result = await activePluginStore.installFromGitHub(urlOrPath);
      } else if (sourceType === "local") {
        result = await activePluginStore.installFromLocal(urlOrPath);
      } else {
        return res.status(400).json({ error: `Unknown source type: ${sourceType}` });
      }

      res.json(result);
    } catch (error) {
      console.error("[PluginStore] Install failed:", error.message);
      res.status(500).json({ error: `Install failed: ${error.message}` });
    }
  });

  app.post("/plugins/store/toggle", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const { name, enabled } = req.body || {};

      if (!name || typeof enabled !== "boolean") {
        return res.status(400).json({ error: "name and enabled are required" });
      }
      if (!activePluginStore.get(name)) {
        return res.status(404).json({ error: `Plugin ${name} not found` });
      }

      const result = activePluginSettingsStore.setEnabled(name, enabled);
      res.json({ success: true, name, enabled: result });
    } catch (error) {
      console.error("[PluginStore] Toggle failed:", error.message);
      res.status(500).json({ error: `Toggle failed: ${error.message}` });
    }
  });

  // Issue #492: short-video-gen add-on tier routes (routes/addons.js),
  // previously written but never registered on `app`. Registered here
  // (registerRoutes), not inside startServer() where they were first
  // wired -- checkAdminAuth is a closure private to this function, out of
  // scope in startServer(), so gating them there would throw
  // ReferenceError on the first request. checkAdminAuth-gated like this
  // file's other sensitive routes (/admin/*, /zed/open, /editors/*):
  // node-bot listens on all interfaces with CORS wide open, and /generate
  // spawns real ffmpeg processes (will eventually trigger OAuth-gated
  // publish calls too), so leaving these open would let anyone who can
  // reach this machine's port trigger them.
  app.get("/api/v1/addons/short-video-gen/status/:id", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return handleGetAddonStatus(req, res);
  });
  app.post("/api/v1/addons/short-video-gen/generate", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return handleGenerateVideo(req, res);
  });
  app.post("/api/v1/addons/short-video-gen/consent/:id", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return handleAddonConsent(req, res);
  });
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
  const sweptTmpFiles = sweepStaleTmpFiles();
  if (sweptTmpFiles) console.log(`[Mana Boot] Deleted ${sweptTmpFiles} old voice upload/temp file(s) from tmp/.`);

  // The retriever only enriches replies (retrieval context, token counts) and
  // every caller has a heuristic fallback, so the backend starts without it;
  // a coding turn starts it on demand (ai/retriever-runtime.js). Set
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
  }

  const app = createApp();

  // Ensure admin account exists on first startup
  authStore.ensureAdminAccount();

  const http = require("http");
  const server = http.createServer(app);
  // Issue #670: WebSocket upgrades skip express, so each ws server checks
  // Host/Origin itself.
  const requestGuard = createRequestGuard();

  // attach caption websocket server
  try {
    const captionServer = require("./caption-server");
    captionServer.registerCaptionServer(server, { path: "/ws/captions", requestGuard });
  } catch (e) {
    console.warn("Failed to register caption server:", e?.message || e);
  }

  // attach tray websocket server for live tray notifications
  try {
    const trayServer = require("./tray-server");
    trayServer.registerTrayServer(server, {
      path: "/ws/tray",
      requestGuard,
      greeting: () => characterEvent(characterStore.active()),
    });
    // make broadcast available via app locals for other modules
    app.locals.broadcastTrayNotification = trayServer.broadcastTrayNotification;
    try {
      const trayNotifier = require("./tray-notifier");
      trayNotifier.setBroadcaster(trayServer.broadcastTrayNotification, trayServer.hasTrayClients);
    } catch (e) {
      // ignore if notifier cannot be wired
    }
  } catch (e) {
    console.warn("Failed to register tray server:", e?.message || e);
  }

  // attach vision-capture websocket server (issue #417: lets the model
  // request a fresh screenshot mid-reply)
  try {
    const { registerVisionCaptureServer } = require("./vision-capture-server");
    registerVisionCaptureServer(server, {
      path: "/ws/vision-capture",
      bridge: visionCaptureBridge,
      requestGuard,
    });
  } catch (e) {
    console.warn("Failed to register vision-capture server:", e?.message || e);
  }

  // Issue #500: 5 near-identical static-file routes (admin UI pages, the
  // plugin store UI, and the plugin install UI), collapsed into
  // server-routes.js's registerAdminStaticRoutes.
  registerAdminStaticRoutes(app);

  return listenOnBindHost(server, port);
}

// Issue #670: loopback only by default, so other devices on the network
// can't drive /reply (and its tools). MANA_BIND_HOST=0.0.0.0 (or a LAN IP)
// restores LAN access for setups that need it -- loudly.
function listenOnBindHost(server, port, env = process.env) {
  const bindHost = getBindHost(env);
  if (!isLoopbackBindHost(bindHost)) {
    console.warn(
      `[Mana Boot] WARNING: MANA_BIND_HOST=${bindHost} -- the backend is reachable from other devices on your network, and anything that can reach it can make Mana reply and run tools. Unset MANA_BIND_HOST to keep it on this PC only.`,
    );
  }
  return server.listen(port, bindHost, () => {
    const boundPort = server.address().port;
    console.log("Node local bot listening on", `${bindHost}:${boundPort}`);
    if (bindHost !== DEFAULT_BIND_HOST) return;
    // "localhost" resolves to ::1 first on Windows, and before #670 the
    // backend answered on ::1 too (the old all-interfaces bind). Mirror the
    // default 127.0.0.1 listener on ::1 so localhost clients (the Electron
    // launcher's default URL, the Obsidian plugin) never fall back through a
    // refused IPv6 connect. Its sockets feed the same HTTP server, so the
    // WebSocket upgrade handlers see them too. Best-effort: a host without
    // IPv6 just skips it.
    const ipv6Loopback = require("net")
      .createServer((socket) => server.emit("connection", socket))
      .on("error", (e) =>
        console.warn("[Mana Boot] ::1 listener unavailable:", e?.message || e),
      )
      .listen(boundPort, "::1");
    server.once("close", () => ipv6Loopback.close());
  });
}

if (require.main === module) {
  require("./utils/unhandled-rejection").keepRunningOnUnhandledRejection();
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
  manaProcessesUnder,
  buildMemoryNotes,
  buildVaultViews,
  buildSkillsIndexBlock,
  checkEmotionalReflexes,
  DEEP_RESEARCH_SUBTASK_PROFILE,
  ensureDirectory,
  formatMemoryMarkdown,
  listenOnBindHost,
  normalizeLlamaModelProfile,
  pickPreferredLlamaModel,
  selectLlamaModelProfileForPrompt,
  shouldUseRemoteAi,
  startServer,
  sweepStaleTmpFiles,
};
