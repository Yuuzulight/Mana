const { registerPluginRoutes } = require('./routes/plugins');
const { createChatReply } = require('./ai/chat-reply');
const { createSpeechRuntime } = require('./ai/speech-runtime');
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
	const { ADMIN_KEY_REQUIRED_ERROR, checkAdminSecret, requireAdminKeyByDefault } = require("./admin-key");
	const { registerOpenAiCompatRoutes } = require("./openai-compat-routes");
	const { registerAdminAccountsRoutes } = require("./admin-accounts-routes");
	const { registerAdminTokenCacheRoutes } = require("./admin-token-cache-routes");
	const { registerPluginStoreRoutes } = require("./plugin-store-routes");
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
const { privacyDataCapability } = require("./capabilities/privacy-data-capability");
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
const { createMemoryMaintenance } = require("./memory-maintenance");
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
const { createScreenIntents } = require("./screen-intents");
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
const { createLifecycle } = require("./self-improvement");
const { visibleEntities, buildFactsIndex, buildPendingReview, buildEntitiesIndex } = require("./memory-views");
// Issue #267: one generic composer instead of a buildToolPolicyWithX per
// tool source -- see ai/tool-source.js. Each create*ToolSource() factory
// below already returns the {listToolSchemas, executeTool, isKnownToolName}
// shape buildToolPolicy expects.
const { buildToolPolicy } = require("./ai/tool-source");
const { TOOL_NARRATION_PROMPT, launchedTask, sanitizeDescription, stepInfo, trimResult, withStepDescriptions } = require("./ai/step-description");
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
const { createProactiveToolSource } = require("./ai/proactive-tool-source");
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
const { createSelfWork, systemRamPercent } = require("./self-work");
const { createPostDeployEval } = require("./post-deploy-eval");
const { createApiSpending } = require("./api-spending");
const { createEscalation } = require("./self-work-escalation");
const { createLessons } = require("./self-work-lessons");
const { createTraceStore } = require("./self-work-traces");
const { createGitToolSource } = require("./ai/git-tool-source");
const { createImprovementToolSource, createIssueProposals } = require("./issue-proposals");
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
const { createProjectsStore } = require("./projects-store");
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
const { createCodingSessionManager } = require("./ai/coding-session");
const { streamedMatchesFinal } = require("./utils/reply-stream-diff");
const { createSentenceChunker } = require("./utils/sentence-chunker");
const { EMOTION_TAG_PROMPT, stripEmotionTags, replyEmotion } = require("./utils/emotion-tags");
const { crisisInstruction } = require("./utils/crisis-check");
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
function openAiFallbackConfig() {
  if (require('./local-only').isLocalOnly()) return null;
  const fallback = modelSettingsStore.getFallbackSettings();
  if (!fallback.enabled) return null;
  const config = {
    apiKey: fallback.apiKey || process.env.OPENAI_API_KEY || null,
    baseUrl: fallback.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com",
    model: fallback.model || process.env.OPENAI_MODEL || '',
    timeoutSeconds: fallback.timeoutSeconds,
    allowRemoteAi: '1',
  };
  return config.model && shouldUseRemoteAiCore({
    apiKey: config.apiKey,
    allowRemoteAi: config.allowRemoteAi,
    baseUrl: config.baseUrl,
  })
    ? config
    : null;
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
const resourceCoordinator = process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT ? null
  : require('./utils/resource-service').initializeResourceService();
let nativeResourceBridge = null;

const llamaServerRuntime = createLlamaServerRuntime({
  resourceCoordinator,
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
    // #1343: lock out heavy coding engine immediately
    codingSessionManager.stopAll("game_started");
    // #914: group mode pauses; after this poll has recorded the game.
    queueMicrotask(() => characterStore.gameChanged());
  },
  onGameEnd: () => {
    llamaServerRuntime.setGaming(false);
    queueMicrotask(() => characterStore.gameChanged());
  },
});
// #1343 Phase 3: Tri-mode sticky coding session manager
const codingSessionManager = createCodingSessionManager({
  isGaming: () => gamingWatch.isGaming(),
  onSessionExit: (sessionId, reason) => {
    console.log(`[Coding Session] Exited session [${sessionId || "default"}]: ${reason}`);
  },
  onSessionTimeout: (sessionId) => {
    console.log(`[Coding Session] Session [${sessionId || "default"}] timed out after 15 minutes idle`);
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
  resourceCoordinator,
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
  extraMessages?.signal?.throwIfAborted();
  if (extraMessages?.requireCancellable && !llamaServerRuntime.isEnabled()) throw new Error('Timed fallback requires the cancellable llama-server runtime');
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
      if (e?.code === 'LOCAL_CLEANUP_FAILED' || e?.code?.startsWith('RESOURCE_')) throw e;
      extraMessages?.signal?.throwIfAborted();
      if (extraMessages?.requireCancellable) throw e;
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
  let lease;
  if (resourceCoordinator) {
  const model = localLlamaRuntime.findLlamaModel(profile);
  const memory = Math.ceil(fs.statSync(model).size / 1048576 * 1.2 + Number(process.env.LLAMA_CONTEXT || process.env.LLAMA_CONTEXT_CAP || 4096) / 1024 * 128);
  lease = await resourceCoordinator.acquire({ owner: 'One-shot chat inference',
    estimate: { ramMb: memory, vramMb: process.env.LLAMA_NGL === '0' ? 0 : memory, cpu: Number(process.env.LLAMA_THREADS || 4) },
    signal: extraMessages?.signal });
  }
  try { return localLlamaRuntime.runLocalAssistantReply(
    prompt,
    maxTokens,
    profile,
    overrideSystemPrompt,
  ); } finally { lease?.release(); }
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
  resourceCoordinator,
  finishFishResourceTransfer: (...args) => nativeResourceBridge?.finishFishTransfer(...args),
  env: process.env,
  ttsProvider: TTS_PROVIDER,
  getVoice: () => characterStore.active().voice,
  baseDir: __dirname,
  nowMs,
  logPerf,
  pronunciationLexiconStore,
  ensureKokoro: kokoroRuntime.ensure,
  useKokoro: kokoroRuntime.use,
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
  approvalGate: () => approvalGate,
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
      // #1337: background-task notices aren't conversation.
      const recent = (turns || []).filter((t) => t?.role !== "event")
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
// #1283 (part of #698): standing intents also fire on what's on screen --
// the foreground window (foreground-report) and the glance text -- through
// the proactive engine; never mid-game or on a private window.
const screenIntents = createScreenIntents({
  matchIntents: (text) => acpMemoryStore.matchIntents(text),
  offer: (candidate) => require("./proactive").offer(candidate),
  isGaming: () => gamingWatch.isGaming(),
});
function checkScreenIntents(screen) {
  screenIntents
    .check({ ...require("./foreground").getForeground(), ...screen })
    .catch((e) => console.warn("Screen intent check failed:", e.message));
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
  resourceCoordinator,
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
// #1387: only entities memory-views.js keeps get a note (aliases folded into
// their canonical one), so nothing links to a note that isn't there.
function buildMemoryNotes(rawIndex, facts, connections, types = {}) {
  const notes = [];
  const { entities } = visibleEntities(rawIndex, types);
  const entityIndex = Object.fromEntries(Object.entries(entities).map(([k, e]) => [k, e.mentions]));
  const entityNames = Object.keys(entityIndex);
  const slugFor = {};
  for (const key of entityNames) {
    slugFor[key] = slugifyEntityName(key);
  }
  // A fact names an entity by its canonical key or any of its aliases.
  const namesFor = Object.fromEntries(entityNames.map((k) => [k, [k]]));
  for (const [alias, meta] of Object.entries(types)) {
    if (meta?.canonicalKey && namesFor[meta.canonicalKey]) namesFor[meta.canonicalKey].push(alias);
  }

  for (const key of entityNames) {
    const mentions = entityIndex[key] || [];
    if (!mentions.length) continue;
    const display = entities[key].display || key;
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
        namesFor[key].some((name) => String(f).toLowerCase().includes(name)),
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

function readMemoryJson(name) {
  const file = path.join(acpMemoryStore.dataDir, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8") || "{}") : {};
}

function currentMemoryNotes() {
  const facts = BACKGROUND_MEMORY_META.important_facts || [];
  const connections = BACKGROUND_MEMORY_META.connections || [];
  return buildMemoryNotes(readMemoryJson("entity-index.json"), facts, connections, readMemoryJson("entity-types.json"));
}

// #1387: what didn't get a note, and why.
function excludedMemoryEntities() {
  return visibleEntities(readMemoryJson("entity-index.json"), readMemoryJson("entity-types.json")).excluded;
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
  // #1388: indexes of the facts, the pending ones and the entities above.
  const types = readMemoryJson("entity-types.json");
  const { entities } = visibleEntities(readMemoryJson("entity-index.json"), types);
  const facts = acpMemoryStore.listFacts();
  return [
    { rel: "Views/Summary.md", body: summary },
    { rel: "Views/Mood.md", body: moodBody },
    { rel: "Views/Facts Index.md", body: buildFactsIndex(facts) },
    { rel: "Views/Pending Review.md", body: buildPendingReview(facts) },
    { rel: "Views/Entities Index.md", body: buildEntitiesIndex(entities, types, slugifyEntityName) },
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
  if (typeof uploadPath !== "string") return;
  const dir = path.resolve(uploadTmpDir());
  const resolved = path.resolve(uploadPath);
  const name = path.basename(resolved);
  if (!/^[0-9a-f]{32}$/.test(name) || resolved !== path.join(dir, name)) return;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry === name || entry.startsWith(`${name}.`)) {
        fs.rmSync(path.join(dir, entry), { force: true });
      }
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
  // #1390: retention and compaction across the memory stores. Not built in
  // tests unless one is injected: the real one works on node-bot/data.
  const memoryMaintenance =
    deps.memoryMaintenance ||
    (process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT
      ? null
      : createMemoryMaintenance({
          store: deps.acpMemoryStore || acpMemoryStore,
          searchIndex: sessionSearchIndex,
          memoryGraph: (deps.acpMemoryStore || acpMemoryStore).memoryGraph,
          isGaming: () => gamingWatch.isGaming(),
        }));
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
      // #1390: the permitted (auto) maintenance steps, at most once a day;
      // anything destructive waits for approval in /admin/memory/maintenance.
      if (memoryMaintenance) {
        try {
          const lastRun = Date.parse(memoryMaintenance.status().lastRunAt) || 0;
          if (Date.now() - lastRun >= 24 * 60 * 60 * 1000) {
            const job = () => memoryMaintenance.run({ mode: "auto" });
            await (resourceCoordinator
              ? resourceCoordinator.run({ owner: "Memory maintenance", background: true, estimate: {} }, job)
              : job());
          }
        } catch (err) {
          console.warn(
            "Idle-triggered memory maintenance failed:",
            err && err.message ? err.message : err,
          );
        }
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
      checkScreenIntents({});
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
    // #1282: away past the same threshold holds proactive remarks until I'm back.
    require("./proactive").setAway(idleSeconds >= thresholdSeconds);

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
      // #1407: a deployed merge's evals go first; her own work waits for them.
      postDeployEval
        .maybeRun()
        .catch(() => false)
        .then((evaluating) => evaluating || selfWork.startIdle())
        .catch(() => {});
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
  const activeProjectsStore =
    deps.projectsStore || createProjectsStore({
      dataDir: (deps.env || process.env).MANA_PROJECTS_DIR || path.join((deps.acpMemoryStore || acpMemoryStore).dataDir || path.join(__dirname, 'data'), 'projects'),
      getSession: id => (deps.acpMemoryStore || acpMemoryStore).getSession?.(id),
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
    // #1336: Export all my data and delete all of it
    privacyDataCapability,
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
  const documentAccess = deps.documentAccess || require('./document-access').createDocumentAccess({ approvalGate: activeApprovalGate });
  const projectReferences = require('./project-references').createProjectReferences({ projectsStore: activeProjectsStore, approvalGate: activeApprovalGate });
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
  // #1337: a background task started from a chat has ended: a line in that
  // chat's history (her next reply sees it) and on /ws/tray for the open chat.
  function backgroundTaskDone({ sessionId, taskId, title, status }) {
    if (!sessionId) return;
    const event = { kind: "background_task", taskId, title: sanitizeDescription(title), status };
    try {
      (deps.acpMemoryStore || acpMemoryStore).appendEvent({
        sessionId,
        ...event,
        text: status === "done" ? "Background task completed" : "Background task failed",
      });
    } catch (e) {
      console.warn("Failed to save a background task notice:", e?.message || e);
    }
    (deps.notifyTray || notifyTray)({ type: "background_task_done", sessionId, ...event });
  }
  const capabilityContext = {
    documentAccess,
    projectsStore: activeProjectsStore,
    acpMemoryStore: deps.acpMemoryStore || acpMemoryStore,
    jobs: researchJobs,
    onBackgroundTaskDone: backgroundTaskDone,
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
    // #1283: glance text checked against standing intents.
    checkScreenIntents: deps.checkScreenIntents || checkScreenIntents,
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
    getMemoryMaintenance: () => memoryMaintenance,
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
        memoryMaintenance: memoryMaintenance?.status(),
        memoryVault: memoryVaultStatus(),
        chatModel: chatModelLabel(),
        findLlamaServerBin: llamaServerRuntime.findLlamaServerBin,
        whisperLanguage: whisperLanguage(),
        gamingWatch,
        stickyCodingSession: codingSessionManager,
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
      gamingWatch,
      stickyCodingSession: codingSessionManager,
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

  require('./routes/projects').registerProjectRoutes(app, { projectsStore: activeProjectsStore, projectReferences, checkAdminAuth, isLocalAdminRequest: deps.isLocalAdminRequest || isLocalAdminRequest });

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
  // by the launcher's activity panel -- read-only, admin-key protected.
  app.get("/agent/activity", (req, res) => {
    // #1318: plus the current (else last) reply's steps for the chat.
    return res.json({ runs: agentActivity.list(), ...agentActivity.latestSteps() });
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
    const result = await reverter.revert(req.body?.pr, req.body?.reason);
    // #1287: a reverted PR's training record says so.
    if (result.ok) {
      try {
        selfWork.traces?.mark(Number(req.body?.pr), { reverted: true });
        // #1385: a lesson on the issue that PR was for (only a PR with a training record is hers).
        const mine = selfWork.traces?.list().find((t) => t.pr === Number(req.body?.pr));
        if (mine) selfWork.lessons?.record({ issue: mine.issue.number, title: mine.issue.title }, "reverted", String(req.body?.reason || "no reason given"), { kind: "revert", pr: Number(req.body.pr), baseCommit: result.mergeCommit });
      } catch {}
    }
    return res.json(result);
  });

  // #1182: git and GitHub in my chat and her self-work. One instance, so a
  // repo I "allow once" stays allowed until restart.
  const gitTools =
    deps.gitTools ||
    createGitToolSource({ approvalGate: activeApprovalGate, isGaming: deps.isGaming || gamingWatch.isGaming });
  // #1406: what her API use costs (DeepSeek and others), for Settings and her chat.
  const apiSpending = deps.apiSpending || createApiSpending({ file: path.join(acpMemoryStore.dataDir, "api-spending.json") });
  // #1385: her failed runs' lessons; promoting one to a rule goes through my approval.
  const lessons = createLessons({ file: path.join(acpMemoryStore.dataDir, "self-work-lessons.json"), approvalGate: activeApprovalGate });
  // #1386: her improvement lifecycle, kept across restarts; an issue out of tries quotes its lesson (#1407).
  const selfImprovement = deps.selfImprovement || createLifecycle({ file: path.join(acpMemoryStore.dataDir, "self-improvement.json"), lessons });
  // #1384: her improvement issues: duplicate check (her open lessons too), evidence, approval bound to the reviewed text.
  const improvementTools =
    deps.improvementTools ||
    createImprovementToolSource(
      createIssueProposals({ approvalGate: activeApprovalGate, lessons: { listOpen: () => lessons.list().filter((l) => l.status === "open") } }),
    );
  // #1006: Mana works one of my issues in her own worktree and opens a PR.
  const selfWork =
    deps.selfWork ||
    createSelfWork({
      lifecycle: selfImprovement,
      resourceCoordinator,
      approvalGate: activeApprovalGate,
      runLoop: (...args) => llamaServerRuntime.runToolAwareReply(...args),
      reviewEdit,
      gitTools,
      // #1398: she watches CI on her own PR and fixes red checks (twice at most).
      watchCi: true,
      // #1287: her successful local runs, kept for a later fine-tune (MANA_SELF_WORK_TRACES=0 turns it off).
      traces: createTraceStore({ dir: path.join(acpMemoryStore.dataDir, "self-work-traces") }),
      lessons,
      // #1406: DeepSeek when her own attempts fail; off until I switch it on with a key.
      escalation: createEscalation({
        file: path.join(acpMemoryStore.dataDir, "self-work-escalation.json"),
        settings: () => modelSettingsStore.getEscalationSettings(),
        env: deps.env || process.env,
      }),
      remoteLoop: (config) => llamaServerRuntime.remoteToolReply(config),
      spending: apiSpending,
      isGaming: deps.isGaming || gamingWatch.isGaming,
      // #1008: starts and ends go to the chat and a toast; a ready PR's link comes along.
      onEvent: (run, text, notice) => {
        console.log(`[self-work #${run.issue}] ${text}`);
        if (notice) notifyTray({ type: "self-work", title: "Mana's own code", text, url: run.prUrl || undefined });
        if (notice && run.endedAt) {
          try {
            selfImprovement.onRunEnd(run);
          } catch {}
          backgroundTaskDone({
            sessionId: run.sessionId,
            taskId: "self-work",
            title: `#${run.issue}: ${run.title}`,
            status: ["pr-open", "pr-updated", "up-to-date", "no-change", "stopped"].includes(run.state) ? "done" : "failed",
          });
        }
      },
    });
  // #1407: her behaviour evals once per deployed merge of hers, in an idle
  // period when she isn't working, no game, RAM under 90% and her chat model
  // unloaded. A failed gate holds the issue and tells me; nothing reverts.
  const postDeployEval =
    deps.postDeployEval ||
    createPostDeployEval({
      lifecycle: selfImprovement,
      repoRoot: path.join(__dirname, ".."),
      stateFile: path.join(acpMemoryStore.dataDir, "post-deploy-eval.json"),
      blocked: async () => {
        if (selfWork.status().state === "running") return "she's working";
        if ((deps.isGaming || gamingWatch.isGaming)()) return "a game is running";
        if (systemRamPercent() > 90) return "RAM is high";
        if (llamaServerRuntime.getStatus().running) return "her chat model is loaded";
        return null;
      },
      notify: (text) => {
        console.log(`[post-deploy eval] ${text}`);
        notifyTray({ type: "self-work", title: "Mana's own code", text });
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
  app.get('/resources/status', (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    res.json(resourceCoordinator?.status() || { active: [], queued: [], history: [] });
  });
  nativeResourceBridge = require('./utils/native-resource-bridge').registerNativeResourceRoutes({ app, coordinator: resourceCoordinator,
    checkAuth: checkAdminAuth, launcherPid: Number(process.env.MANA_LAUNCHER_PID) });
  if (resourceCoordinator) {
    activeApprovalGate.registerExecutor('resource-cpu-execution', async ({ requestId }) => {
      resourceCoordinator.chooseCpu(requestId);
      return { ok: true, execution: 'cpu', requestId };
    });
    const offered = new Set();
    resourceCoordinator.subscribe(event => {
      if (event.state === 'released' || event.state === 'refused') { offered.delete(event.id); return; }
      if (event.state !== 'queued' || !event.cpuAlternative || !/GPU-memory|vramMb/.test(event.reason) || offered.has(event.id)) return;
      offered.add(event.id);
      activeApprovalGate.requestApproval('resource-cpu-execution', {
        forceReview: true, summary: `${event.owner}: GPU execution is queued. Run on CPU instead? This can be slower and uses RAM and CPU.`,
        payload: { requestId: event.id }, details: { reason: event.reason, cpuEstimate: event.cpuAlternative },
      }).catch(error => console.warn('CPU alternative approval unavailable:', error.message));
    });
  }
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
  // #1385: her lessons from failed runs; a rule only after my approval.
  // #1406: API spending for Settings, and self-work's DeepSeek escalation.
  // The key goes in and never comes back out: only whether there is one.
  app.get("/api-spending", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return res.json(apiSpending.summary());
  });
  const escalationView = () => {
    const { enabled, baseUrl, apiKey } = modelSettingsStore.getEscalationSettings();
    return { enabled, baseUrl, hasKey: Boolean(apiKey), localOnly: require("./local-only").isLocalOnly(deps.env || process.env) };
  };
  app.get("/self-work/escalation", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return res.json(escalationView());
  });
  app.post("/self-work/escalation", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const { enabled, apiKey } = req.body || {};
    if (enabled !== undefined && typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
    if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 512)) return res.status(400).json({ error: "apiKey must be a string" });
    modelSettingsStore.setEscalationSettings({ enabled, apiKey });
    return res.json(escalationView());
  });
  app.get("/self-work/lessons", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return selfWork.lessons ? res.json({ lessons: selfWork.lessons.list() }) : res.status(404).json({ error: "lessons are off" });
  });
  app.post("/self-work/lessons/:id/promote", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    if (!selfWork.lessons) return res.status(404).json({ error: "lessons are off" });
    return res.json(await selfWork.lessons.promote(req.params.id, req.body?.rule));
  });
  app.post("/self-work/lessons/:id/supersede", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    if (!selfWork.lessons) return res.status(404).json({ error: "lessons are off" });
    return res.json(selfWork.lessons.supersede(req.params.id, String(req.body?.by ?? "")));
  });

  // #1386: her improvement lifecycle -- every issue's state and why.
  app.get("/self-improvement", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return res.json({ records: selfImprovement.list() });
  });
  // "Try that again": clears a hold and the retry budget.
  app.post("/self-improvement/:issue/retry", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const record = selfImprovement.retry(req.params.issue);
    // #1406: a fresh try gets DeepSeek's tiers back too.
    if (record) selfWork.escalation?.reset(req.params.issue);
    return record ? res.json({ record }) : res.status(404).json({ error: "No record for that issue." });
  });
  // A merged change checked by an eval/bench report (bench/results/<label>).
  app.post("/self-improvement/:issue/verify", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const label = String(req.body?.label || "");
    if (!/^[\w.-]+$/.test(label) || label.includes("..")) return res.status(400).json({ error: "label must be a bench/results folder name" });
    const file = path.join(__dirname, "bench", "results", label, "report.json");
    if (!fs.existsSync(file)) return res.status(404).json({ error: "No report.json in that folder." });
    let report;
    try {
      report = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      return res.status(400).json({ error: `report.json didn't parse: ${e.message}` });
    }
    const record = selfImprovement.verify(req.params.issue, { ...report, label });
    return record ? res.json({ record }) : res.status(404).json({ error: "No record for that issue." });
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
  app.post("/admin/shutdown", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      llamaServerRuntime.stop();
    } catch (e) {
      console.error("Error stopping llama-server during shutdown:", e?.message || e);
    }
    try { await browserAutomationPlugin.closeSession(); }
    catch (e) { console.error("Error closing browser during shutdown:", e?.message || e); }
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

  // #1343 Phase 3: Coding session state and control endpoints
  app.get("/coding-session/status", (req, res) => {
    const sessionId = req.query?.sessionId || null;
    return res.json({
      active: codingSessionManager.isActive(sessionId),
      isGaming: gamingWatch.isGaming(),
      game: gamingWatch.game(),
    });
  });

  app.post("/coding-session/start", (req, res) => {
    const sessionId = req.body?.sessionId || null;
    const result = codingSessionManager.start(sessionId);
    return res.json(result);
  });

  app.post("/coding-session/stop", (req, res) => {
    const sessionId = req.body?.sessionId || null;
    const reason = req.body?.reason || "user_exit";
    const stopped = codingSessionManager.stop(sessionId, reason);
    return res.json({ ok: stopped });
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

  // Issue #500: admin token-cache routes moved out of server.js.
  registerAdminTokenCacheRoutes(app, { checkAdminAuth });

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

  // #1282: quiet hours, "not now" and muted remark kinds.
  require("./proactive").registerRoutes(app);

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

  // #1382: what she's measured, for her planner and for me. Admin-key
  // protected like every non-public route. Recommendations are advice:
  // cloud models are never eligible here (no approved fallbacks passed).
  app.get("/telemetry", (req, res) => {
    const { buildTelemetry, recommendRoute, plannerSummary, loadReports } = require("./telemetry");
    const telemetry = buildTelemetry({
      toolCalls: activeToolCallLog.readRecent(5000),
      reports: loadReports(path.join(__dirname, "bench", "results")),
      operations: perfMetrics.operations,
    });
    const current = String(activeLlamaServerRuntime.getStatus?.()?.model || "").split(/[\\/]/).pop() || null;
    const kinds = [...new Set(telemetry.models.map((m) => m.kind))];
    const recommendations = kinds.map((kind) =>
      recommendRoute(telemetry, {
        kind,
        current,
        candidates: [...new Set(telemetry.models.filter((m) => m.kind === kind).map((m) => m.model))].map((model) => ({ model, local: !/gemini|deepseek/i.test(model) })),
        localOnly: require("./local-only").isLocalOnly(),
      }),
    );
    res.json({ ...telemetry, recommendations, planner: plannerSummary(telemetry) });
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
  registerPluginRoutes({
    get activePluginSettingsStore() { return activePluginSettingsStore; },
    get app() { return app; },
    get capabilities() { return capabilities; },
  });



  const turnArbiter = require("./utils/turn_arbiter");

  const speechRuntime = createSpeechRuntime({
    get resourceCoordinator() { return resourceCoordinator; },
    get Atomics() { return Atomics; },
    get belowNormal() { return belowNormal; },
    get clampText() { return clampText; },
    get createWorker() { return createWorker; },
    get fs() { return fs; },
    get getGamingStatus() { return getGamingStatus; },
    get getWhisperPrompt() { return getWhisperPrompt; },
    get Int32Array() { return Int32Array; },
    get localLlamaRuntime() { return localLlamaRuntime; },
    get logPerf() { return logPerf; },
    get nowMs() { return nowMs; },
    get path() { return path; },
    get SCREEN_CONTEXT_ENABLED() { return SCREEN_CONTEXT_ENABLED; },
    get SCREEN_CONTEXT_MAX_CHARS() { return SCREEN_CONTEXT_MAX_CHARS; },
    get SCREEN_OCR_CACHE_PATH() { return SCREEN_OCR_CACHE_PATH; },
    get screenOcrWorkerPromise() { return screenOcrWorkerPromise; },
    set screenOcrWorkerPromise(value) { screenOcrWorkerPromise = value; },
    get SharedArrayBuffer() { return SharedArrayBuffer; },
    get spawn() { return spawn; },
    get spawnSync() { return spawnSync; },
    get speechVocabulary() { return speechVocabulary; },
    get STT_PROVIDER() { return STT_PROVIDER; },
    get transcribeWithWhisperServer() { return transcribeWithWhisperServer; },
    get ttsRuntime() { return ttsRuntime; },
    get turnArbiter() { return turnArbiter; },
    get WHISPER_BEAM_SIZE() { return WHISPER_BEAM_SIZE; },
    get WHISPER_NO_SPEECH_THRESHOLD() { return WHISPER_NO_SPEECH_THRESHOLD; },
    get WHISPER_TEMPERATURE() { return WHISPER_TEMPERATURE; },
    get whisperDiscovery() { return whisperDiscovery; },
    get whisperLanguage() { return whisperLanguage; },
    get whisperThreads() { return whisperThreads; },
  });
  function synthesizeReply(...args) { return speechRuntime.synthesizeReply(...args); }

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
  function findWhisperBin(...args) { return speechRuntime.findWhisperBin(...args); }

  function findLlamaBin(...args) { return speechRuntime.findLlamaBin(...args); }

  function findLlamaModel(...args) { return speechRuntime.findLlamaModel(...args); }

  function getLlamaStatus(...args) { return speechRuntime.getLlamaStatus(...args); }

  // #925: heard is what whisper wrote, transcript the same with my
  // mishearing fixes applied -- what every caller uses. #1107: model and
  // language go into a kept voice clip's sidecar.
  function runWhisperHeard(...args) { return speechRuntime.runWhisperHeard(...args); }

  function runWhisper(...args) { return speechRuntime.runWhisper(...args); }

  function runWhisperPartial(...args) { return speechRuntime.runWhisperPartial(...args); }

  function findParakeetBin(...args) { return speechRuntime.findParakeetBin(...args); }

  function runParakeet(...args) { return speechRuntime.runParakeet(...args); }

  function runWhisperCli(...args) { return speechRuntime.runWhisperCli(...args); }

  // Runs whisper-cli asynchronously (spawn, not spawnSync) so it doesn't
  // block the event loop -- unlike runWhisperCli above, this is called
  // repeatedly (every ~1.2s) while the user is still speaking, to produce
  // a live partial transcript. A separate function rather than converting
  // runWhisperCli in place: several existing callers (memory-inbox.js
  // explicitly documents "whisper.cpp is sync") assume the synchronous
  // contract, and converting it would risk silently breaking them.
  function spawnWhisperCliAsync(...args) { return speechRuntime.spawnWhisperCliAsync(...args); }

  function runWhisperCliPartial(...args) { return speechRuntime.runWhisperCliPartial(...args); }

  // Async counterpart to normalizeUploadedAudio -- that function
  // unconditionally spawnSync's ffmpeg on every call (no format
  // short-circuit), which would block the event loop just as badly as the
  // old synchronous whisper call did, defeating the point of
  // runWhisperCliPartial being async. Used only by /transcribe-partial;
  // normalizeUploadedAudio itself and its other callers (/transcribe-only,
  // /transcribe) are untouched, same reasoning as spawnWhisperCliAsync
  // above.
  function normalizeUploadedAudioAsync(...args) { return speechRuntime.normalizeUploadedAudioAsync(...args); }

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

  function normalizeUploadedAudio(...args) { return speechRuntime.normalizeUploadedAudio(...args); }

  function cleanupUploadedAudio(...args) { return speechRuntime.cleanupUploadedAudio(...args); }

  let screenOcrWorkerPromise = null;

  function getScreenOcrWorker(...args) { return speechRuntime.getScreenOcrWorker(...args); }

  function dataUrlToBuffer(...args) { return speechRuntime.dataUrlToBuffer(...args); }

  function readScreenText(...args) { return speechRuntime.readScreenText(...args); }

  const chatReply = createChatReply({
    get resourceCoordinator() { return resourceCoordinator; },
    get acpMemoryStore() { return deps.acpMemoryStore || acpMemoryStore; },
    get activeApprovalGate() { return activeApprovalGate; },
    get activeBrowserAutomationToolSource() { return activeBrowserAutomationToolSource; },
    get activeDefaultPrompt() { return activeDefaultPrompt; },
    get activeHooksStore() { return activeHooksStore; },
    get activeLlamaServerRuntime() { return activeLlamaServerRuntime; },
    get activeMcpClientRegistry() { return activeMcpClientRegistry; },
    get activeMoodStore() { return activeMoodStore; },
    get activePluginSettingsStore() { return activePluginSettingsStore; },
    get activePresetsStore() { return activePresetsStore; },
    get activeProjectsStore() { return activeProjectsStore; },
    get projectReferences() { return projectReferences; },
    get activeSkillsStore() { return activeSkillsStore; },
    get activeToolCallLog() { return activeToolCallLog; },
    get activeToolPolicy() { return activeToolPolicy; },
    get agentActivity() { return agentActivity; },
    get BACKGROUND_MEMORY_BLOCK() { return BACKGROUND_MEMORY_BLOCK; },
    get briefing() { return briefing; },
    get browserAutomationPlugin() { return browserAutomationPlugin; },
    get buildSkillsIndexBlock() { return buildSkillsIndexBlock; },
    get buildToolPolicy() { return buildToolPolicy; },
    get characterStore() { return characterStore; },
    get classifyIntent() { return classifyIntent; },
    get cleanLlamaOutput() { return cleanLlamaOutput; },
    get codingSessionManager() { return codingSessionManager; },
    get compressExcerpts() { return compressExcerpts; },
    get contextFullNote() { return contextFullNote; },
    get createCodingToolSource() { return createCodingToolSource; },
    get createDeepThinkingToolSource() { return createDeepThinkingToolSource; },
    get createDesktopToolSource() { return createDesktopToolSource; },
    // #1383: what her self-inventory reads, live on each call.
    get inventorySources() {
      return {
        capabilities: () => capabilities,
        health: () => buildCapabilityHealth(capabilities, capabilityContext),
        isEnabled: (c) => isPluginEnabled(c, activePluginSettingsStore),
      };
    },
    get createExpressionToolSource() { return createExpressionToolSource; },
    get createMailCalendarToolSource() { return createMailCalendarToolSource; },
    get createMemoryToolSource() { return createMemoryToolSource; },
    get createProactiveToolSource() { return createProactiveToolSource; },
    get createRelationshipToolSource() { return createRelationshipToolSource; },
    get createReminderToolSource() { return createReminderToolSource; },
    get createSentenceChunker() { return createSentenceChunker; },
    get createSessionGoalToolSource() { return createSessionGoalToolSource; },
    get createSessionSearchToolSource() { return createSessionSearchToolSource; },
    get createSkillToolSource() { return createSkillToolSource; },
    get createSnapshotToolSource() { return createSnapshotToolSource; },
    get createSpeechToolSource() { return createSpeechToolSource; },
    get createTryPrToolSource() { return createTryPrToolSource; },
    get createVisionToolSource() { return createVisionToolSource; },
    get crisisInstruction() { return crisisInstruction; },
    get cronSchedulerPlugin() { return cronSchedulerPlugin; },
    get deepThinking() { return deepThinking; },
    get DEFAULT_CHARACTER_ID() { return DEFAULT_CHARACTER_ID; },
    get deps() { return deps; },
    get EMOTION_TAG_PROMPT() { return EMOTION_TAG_PROMPT; },
    get filterRelevantTools() { return filterRelevantTools; },
    get finalizePromptComposition() { return finalizePromptComposition; },
    get fs() { return fs; },
    get gamingWatch() { return gamingWatch; },
    get gentleHint() { return gentleHint; },
    get getEditorIntegrations() { return getEditorIntegrations; },
    get gitTools() { return gitTools; },
    get improvementTools() { return improvementTools; },
    get apiSpending() { return apiSpending; },
    get modelSettingsStore() { return modelSettingsStore; },
    get GROUP_REACTION_MAX_TOKENS() { return GROUP_REACTION_MAX_TOKENS; },
    get http() { return http; },
    get https() { return https; },
    get isExpressionToolName() { return isExpressionToolName; },
    get isLlamaServerAvailable() { return isLlamaServerAvailable; },
    get isPluginEnabled() { return isPluginEnabled; },
    get launchedTask() { return launchedTask; },
    get LLAMA_MAX_TOKENS() { return LLAMA_MAX_TOKENS; },
    get LLAMA_MAX_TOKENS_CODING() { return LLAMA_MAX_TOKENS_CODING; },
    get llamaServerRuntime() { return llamaServerRuntime; },
    get mailCalendarSettings() { return mailCalendarSettings; },
    get modelManagement() { return modelManagement; },
    get moodPromptBlock() { return moodPromptBlock; },
    get oldestSessionAt() { return oldestSessionAt; },
    get openAiApiKey() { return openAiApiKey; },
    get openAiBaseUrl() { return openAiBaseUrl; },
    get openAiModel() { return openAiModel; },
    get openAiFallbackConfig() { return deps.openAiFallbackConfig || openAiFallbackConfig; },
    get createChatAttempt() { return deps.createChatAttempt; },
    get path() { return path; },
    get perfMetrics() { return perfMetrics; },
    get persona() { return persona; },
    get personalityStore() { return personalityStore; },
    get personaOf() { return personaOf; },
    get phrasingVariator() { return phrasingVariator; },
    get Proxy() { return Proxy; },
    get queueVTubeReaction() { return queueVTubeReaction; },
    get recordPromptComposition() { return recordPromptComposition; },
    get Reflect() { return Reflect; },
    get relationshipPromptBlock() { return relationshipPromptBlock; },
    get relationshipStore() { return relationshipStore; },
    get replyEmotion() { return replyEmotion; },
    get resolveToolApprovalMode() { return resolveToolApprovalMode; },
    get retrieverService() { return retrieverService; },
    get reverter() { return reverter; },
    get reviewEdit() { return reviewEdit; },
    get rewritePhrase() { return rewritePhrase; },
    get runBestOfNReply() { return runBestOfNReply; },
    get runLocalAssistantReply() { return runLocalAssistantReply; },
    get runLocalLlamaReply() { return runLocalLlamaReply; },
    get runToolAwareReply() { return runToolAwareReply; },
    get rutDetector() { return rutDetector; },
    get screenSensingPlugin() { return screenSensingPlugin; },
    get selectLlamaModelProfileForPrompt() { return selectLlamaModelProfileForPrompt; },
    get selfWork() { return selfWork; },
    get sessionTokenUsage() { return sessionTokenUsage; },
    get shouldUseRemoteAi() { return shouldUseRemoteAi; },
    get snapshotStore() { return snapshotStore; },
    get spawnSync() { return spawnSync; },
    get speechVocabulary() { return speechVocabulary; },
    get stepInfo() { return stepInfo; },
    get streamedMatchesFinal() { return streamedMatchesFinal; },
    get stripEmotionTags() { return stripEmotionTags; },
    get terminalFeed() { return terminalFeed; },
    get TOOL_NARRATION_PROMPT() { return TOOL_NARRATION_PROMPT; },
    get trimResult() { return trimResult; },
    get untrustedLinks() { return untrustedLinks; },
    get untrustedSources() { return untrustedSources; },
    get visionCaptureBridge() { return visionCaptureBridge; },
    get wantsThinkHarder() { return wantsThinkHarder; },
    get withStepDescriptions() { return withStepDescriptions; },
    // #1381: only the behaviour eval passes this.
    get evalTools() { return deps.evalTools; },
    get wrapWithHooks() { return wrapWithHooks; },
    get wrapWithInputHooks() { return wrapWithInputHooks; },
    get wrapWithResultDigest() { return wrapWithResultDigest; },
    get wrapWithRiskGate() { return wrapWithRiskGate; },
    get wrapWithToolCallLog() { return wrapWithToolCallLog; },
  });
  function buildScreenAwarePrompt(...args) { return chatReply.buildScreenAwarePrompt(...args); }

  // ---------------------------------------------------------------------------
  // OpenAI / proxy API inference
  // ---------------------------------------------------------------------------
  function runOpenAIReply(...args) { return chatReply.runOpenAIReply(...args); }

  // Assistant mode picker: use the local intent classifier when available
  const { classifyIntent } = require("./utils/intent-classifier");

  // Returns an object: { mode: 'casual'|'everyday'|'coding', reason: string }
  function pickAssistantMode(...args) { return chatReply.pickAssistantMode(...args); }

  function buildAssistantReply(...args) { return chatReply.buildAssistantReply(...args); }

  registerCoreRoutes(app, upload, {
    documentAccess,
    UNIVERSALIS_DEFAULT_WORLD,
    TTS_PROVIDER,
    SCREEN_CONTEXT_MAX_CHARS,
    currentGame: deps.currentGame || currentGame,
    restartController: deps.restartController || createRestartController(),
    buildAssistantReply: deps.buildAssistantReply || buildAssistantReply,
    characters: characterStore,
    buildGroupReaction: deps.buildGroupReaction || buildGroupReaction,
    moodStore: activeMoodStore, // #700
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
    getScreenOcrWorker: deps.getScreenOcrWorker || getScreenOcrWorker,
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
  function buildGroupReaction(...args) { return chatReply.buildGroupReaction(...args); }

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
  require('./routes/chat-models').registerChatModelRoutes(app, { modelManagement, acpMemoryStore: app.locals.acpMemoryStore, checkAdminAuth });

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

  app.get("/api/memory/notes/excluded", authMiddleware, async (req, res) => {
    try {
      res.json({ excluded: excludedMemoryEntities() });
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  registerOpenAiCompatRoutes(app, {
    authMiddleware,
    activeLlamaServerRuntime,
    llamaServerRuntime,
    env: deps.env,
  });

  registerAdminAccountsRoutes(app, { authMiddleware, authStore });

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

  registerPluginStoreRoutes(app, {
    checkAdminAuth,
    activePluginSettingsStore,
    pluginStore: deps.pluginStore,
    fetchAvailablePlugins: deps.fetchAvailablePlugins,
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
  slugifyEntityName,
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
  deleteUploadFiles,
  codingSessionManager,
};
