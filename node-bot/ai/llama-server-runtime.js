const { createModelDiscovery } = require('./llama/model-discovery');
const { createServerConfig } = require('./llama/server-config');
const { createServerStartup } = require('./llama/server-startup');
const { createLifecycle } = require('./llama/lifecycle');
const { createCompletions } = require('./llama/completions');
const { createToolCalls } = require('./llama/tool-calls');
const { createGoalReview } = require('./llama/goal-review');
const { createToolReply } = require('./llama/tool-reply');
const { AsyncLocalStorage } = require('node:async_hooks');
const defaultFs = require("node:fs");
const { streamSentences } = require("../utils/sse-sentence-stream");
const { stripEmotionTags } = require("../utils/emotion-tags");
const { buildSamplingParams } = require("./sampler-presets");
const path = require("node:path");
const {
  spawn: defaultSpawn,
  execFile: defaultExecFile,
} = require("node:child_process");
const { setTimeout: defaultSleep } = require("node:timers/promises");
const { killProcessTree, waitForExit } = require("../utils/kill-process-tree");
const {
  collectFilesRecursively,
  findPreferredLlamaModel,
  getKnownLlamaModelProfiles,
  LLAMA_MODEL_PROFILES,
} = require("./local-ai");
const {
  DEFAULT_SYSTEM_PROMPT,
  isLocalModelSpec,
} = require("./local-llama-runtime");
const { SESSION_GOAL_FINISH_TOOL_NAME } = require("./session-goal-tool-source");
const { CODING_EDIT_TOOL_NAME, CODING_TEST_TOOL_NAME } = require("./coding-tool-source");
const { detectGpuVramUsageMb } = require("../model-management");
const { readActivePointer, settleActiveBuild } = require("../llama-builds");
const { GAMING_IDLE_MS } = require("../utils/gaming-watch");
const { MEMORY_TOOL_PREFIX } = require("./memory-tool-source");
const { repairToolCallText } = require("../utils/repair-tool-call");

// #898: a reply saying she saved, or will remember, something. Measured
// live: "I already saved that detail into my memory just now" with no
// memory__remember call at all. Not "remember when we..." or "do you
// remember": those are recall, not a claim. ponytail: phrase regexes in
// English, Japanese and Chinese; a claim worded another way slips through.
const MEMORY_REMEMBER_TOOL = `${MEMORY_TOOL_PREFIX}remember`;
const MEMORY_SAVE_CLAIM_RE = new RegExp(
  [
    String.raw`(?<!(?:\bnot|n't|\bnever)\s+(?:yet\s+)?(?:be(?:en)?\s+)?)\b(?:saved|stored|noted|recorded|written|wrote|added|put|committed|locked|filed)\b[^.!?\n]{0,40}?\b(?:in|into|to) (?:my )?(?:long-term )?memor(?:y|ies)\b`,
    String.raw`\bI(?:'ll| will|'m going to| am going to|'m gonna) (?:make sure to |be sure to )?remember (?:that|this|it)\b`,
    String.raw`\bI(?:'ve| have)?(?: already| just)? (?:memori[sz]ed|made a (?:mental )?note)\b`,
    "覚えておく(?:ね|よ)|覚えておきます|覚えました|覚えたよ|(?:記憶|メモリ)に(?:保存|登録|記録)(?:した|しました|しておく|しておきます|しておいた)",
    "我(?:会|已经)?记住(?:了|的)|(?:保存|记录?)(?:到|在|进)(?:我的)?记忆",
  ].join("|"),
  "i",
);

// #1214: how many of the latest tool results goal mode keeps whole once
// the prompt passes 60% of the context.
const KEEP_RECENT_TOOL_RESULTS = 4;
// #1214: how long her context switch waits for replies in flight to end.
const CONTEXT_SWITCH_WAIT_MS = 2 * 60 * 1000;
// #1209: what she's told when llama-server couldn't parse her tool call.
const TOOL_CALL_UNPARSED_NOTE =
  "Your last tool call couldn't be parsed: its arguments were cut off or weren't valid JSON. Make the call again with shorter arguments (for a code change, replace only the lines that change).";

// #621: whether a tool call's arguments can run: they parse to a JSON
// object with every parameter its schema requires. Calls read from text
// (#1263) and native tool_calls both go through this, so neither runs with
// {} in place of arguments that didn't parse. No arguments at all is {}.
function checkToolCallArgs(raw, parameters) {
  let args = raw ?? {};
  if (typeof args === "string") {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch (e) {
      return { problem: "weren't valid JSON", missing: [] };
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return { problem: "weren't a JSON object", missing: [] };
  const missing = ((parameters && parameters.required) || []).filter((key) => !(key in args));
  return { args, missing };
}

// "saved" when a memory__remember call wrote (or was approved), "pending"
// when one is waiting on approval, else "none".
function memoryWriteState(calls) {
  let state = "none";
  for (const call of calls) {
    if (call.name !== MEMORY_REMEMBER_TOOL || !call.ok) continue;
    let r = {};
    try {
      r = JSON.parse(call.result) || {};
    } catch (e) {}
    if (r.ok === true || (r.status === "approved" && r.result?.ok !== false)) return "saved";
    if (r.status === "pending") state = "pending";
  }
  return state;
}

// #898: what to tell her when the reply claims a memory write this turn
// doesn't back, or null. The fix goes back through memory__remember (its
// approval gate and #317 attribution check), never a write from here.
function memoryClaimNote(reply, calls) {
  if (!MEMORY_SAVE_CLAIM_RE.test(reply)) return null;
  const state = memoryWriteState(calls);
  if (state === "saved") return null;
  if (state === "pending") {
    return /approv/i.test(reply)
      ? null
      : `Your ${MEMORY_REMEMBER_TOOL} call is waiting for the user's approval, so nothing is saved yet. Answer again and say it's waiting for their approval, not that it's saved.`;
  }
  return `Nothing was saved to memory this turn: no ${MEMORY_REMEMBER_TOOL} call went through. If the user asked you to remember something, call ${MEMORY_REMEMBER_TOOL} now; otherwise answer again without saying you saved it or will remember it.`;
}

// Persistent llama-server runtime.
//
// The one-shot llama-cli path reloads the whole GGUF model on every call,
// which shows up as llama-cli.exe repeatedly spawning in Task Manager and
// blocks the Node event loop while it runs. This runtime starts
// llama-server.exe once, keeps it alive, and serves replies over local HTTP,
// so the model loads a single time. The llama-cli path remains as fallback.
function createLlamaServerRuntime(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || defaultFs;
  const spawn = options.spawn || defaultSpawn;
  const execFile = options.execFile || defaultExecFile;
  const platform = options.platform || process.platform;
  const fetchImpl = options.fetch || globalThis.fetch;
  const resourceCoordinator = options.resourceCoordinator;
  const resourceContext = new AsyncLocalStorage();
  async function withModelOperation(fn, cpu = 0) {
    if (!resourceCoordinator) return fn();
    if (resourceCoordinator.currentContext()?.modelOperation) return fn();
    const request = resourceContext.getStore() || {};
    const lease = await resourceCoordinator.acquire({ owner: request.background ? 'Self-work inference' : 'Chat model operation',
      background: !!request.background, cancelled: request.cancelled, onWait: request.onWait, signal: request.signal,
      exclusive: 'chat-model', estimate: { cpu } });
    let transferred = false;
    const finish = () => {
      state.resourceExecuting -= 1;
      lease.release();
      if (!state.busy && !state.resourceExecuting) {
        if (state.gamingSwapPending !== null) setGaming(state.gamingSwapPending);
        if (state.visionUnloadPending) unloadVision();
        if (state.contextRestorePending) { state.contextOverride = null; state.contextRestorePending = false; }
      }
    };
    const failed = async () => {
      if (state.child) {
        lease.attachProcess(state.child);
        stop();
        await state.stopping;
      } else if (state.port && cpu > 0) {
        lease.retain('An external model request failed; completion is unconfirmed. The external process was not stopped.');
      }
    };
    try {
      state.resourceExecuting = (state.resourceExecuting || 0) + 1;
      const result = await resourceCoordinator.scope({ ...request, admitted: true, modelOperation: true }, fn);
      if (result instanceof Response && result.body) {
        const reader = result.body.getReader();
        let ended = false;
        const end = async (failure = false) => {
          if (ended) return;
          ended = true;
          try { if (failure) await failed(); } finally { finish(); }
        };
        const body = new ReadableStream({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) { await end(); controller.close(); }
              else controller.enqueue(chunk.value);
            } catch (error) { await end(true); controller.error(error); }
          },
          async cancel(reason) {
            try { await reader.cancel(reason); } finally { await end(true); }
          },
        }, { highWaterMark: 0 });
        const response = new Response(body, { status: result.status, statusText: result.statusText, headers: result.headers });
        transferred = true;
        return response;
      }
      return result;
    } catch (error) {
      await failed();
      throw error;
    } finally { if (!transferred) finish(); }
  }
  const baseDir = options.baseDir || path.resolve(__dirname, "..");
  const toolsDir =
    options.toolsDir || path.resolve(baseDir, "..", "tools", "llama");
  const threads = Number(options.threads || env.LLAMA_THREADS || 4);
  // #914: a function is read on every call (the active character's).
  const systemPromptOf =
    typeof options.systemPrompt === "function"
      ? options.systemPrompt
      : () => options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const nowMs = options.nowMs || (() => Date.now());
  const logPerf = options.logPerf || (() => {});
  const modelSettingsStore = options.modelSettingsStore || null;
  // #872: is a watched game running (server.js passes the gaming watch).
  const gaming = options.gaming || (() => false);
  // `llama-server --help` text for a binary, cached per path (a probe is
  // ~1 s and only happens when a server starts). Injectable for tests.
  const probeHelp =
    options.probeHelp ||
    ((bin) =>
      require("child_process").execFileSync(bin, ["--help"], {
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }));
  // Each binary's --help text, probed once. Builds older than a flag
  // (reachable via #693 update/rollback) refuse to start with it. A failed
  // probe counts as "not supported".
  const helpTexts = new Map();
  const modelDiscovery = createModelDiscovery({
    get collectFilesRecursively() { return collectFilesRecursively; },
    get env() { return env; },
    get fetchImpl() { return fetchImpl; },
    get findPreferredLlamaModel() { return findPreferredLlamaModel; },
    get fs() { return fs; },
    get helpTexts() { return helpTexts; },
    get LLAMA_MODEL_PROFILES() { return LLAMA_MODEL_PROFILES; },
    get modelSettingsStore() { return modelSettingsStore; },
    get path() { return path; },
    get probeHelp() { return probeHelp; },
    get readActivePointer() { return readActivePointer; },
    get state() { return state; },
    get toolsDir() { return toolsDir; },
  });
  function supportsFlag(...args) { return modelDiscovery.supportsFlag(...args); }
  function supportsLoadMode(...args) { return modelDiscovery.supportsLoadMode(...args); }
  const registerExitHandlers = options.registerExitHandlers !== false;
  const sleep = options.sleep || defaultSleep;

  const state = {
    child: null,
    model: null,
    mmproj: null,
    port: null,
    starting: null,
    // #1124: { model, since } while `starting` is loading it.
    loading: null,
    // Settles once the last stopped child has exited (true) or was still
    // running after the stop bound (false); startServer() waits on it.
    stopping: Promise.resolve(true),
    idleTimer: null,
    exitHandlerRegistered: false,
    // #666: model -> { at, count } of its consecutive failed starts.
    startFailures: new Map(),
    loadedAt: null,
    lastSwapMs: null,
    // #693: the binary the latest start attempt used, so a pointer switch
    // is only confirmed/rolled back by a start that actually ran it.
    lastStartBin: null,
    // #642: prompt size of the latest completion, from its timings.
    lastPromptUsage: null,
    // #1214: the -c the running server started with, and a reply's own
    // context size (her self-work runs) while that reply runs.
    ctx: null,
    contextOverride: null,
    contextRestorePending: false,
    // #872: an image turn sets visionWanted (the chat server then keeps
    // its mmproj); visionTimer clears it after MANA_VISION_IDLE_MS. busy
    // counts replies in flight -- an unload waits for it to reach 0.
    visionWanted: false,
    visionTimer: null,
    busy: 0,
    visionUnloadPending: false,
    // #889: the gaming model is in use (see setGaming); gamingSwapPending
    // is a swap (true/false) waiting for the reply in flight.
    gamingModel: false,
    gamingSwapPending: null,
    // #1343: multi-LoRA dynamic adapters
    hasLoraAdapters: false,
    activeLoraAdapter: null,
    loraIds: {},
  };

  // Debounce: back-to-back requests for different profiles (e.g. one coding
  // question right after a casual one) would otherwise force a full
  // kill/respawn per reply. Within this window after a swap, a *different*
  // second swap is skipped and the reply is served from whatever model is
  // already loaded instead. Set LLAMA_SERVER_SWAP_DEBOUNCE_MS=0 to disable.
  const swapDebounceMs = Number(
    env.LLAMA_SERVER_SWAP_DEBOUNCE_MS === undefined
      ? 3000
      : env.LLAMA_SERVER_SWAP_DEBOUNCE_MS,
  );

  // Issue #320: refuse a load that's very unlikely to fit, rather than
  // attempting it and letting llama-server fail messily (or the driver OOM)
  // partway through. Set LLAMA_SERVER_VRAM_GUARD=0 to disable.
  const vramGuardEnabled = env.LLAMA_SERVER_VRAM_GUARD !== "0";
  const detectGpuVramUsage = options.detectGpuVramUsage || detectGpuVramUsageMb;

  const serverConfig = createServerConfig({
    get configuredContext() { return configuredContext; },
    get detectGpuVramUsage() { return detectGpuVramUsage; },
    get env() { return env; },
    get findLoraAdapters() { return findLoraAdapters; },
    get fs() { return fs; },
    get isLocalModelSpec() { return isLocalModelSpec; },
    get modelSettingsStore() { return modelSettingsStore; },
    get PROFILE_TUNING() { return PROFILE_TUNING; },
    get state() { return state; },
    get supportsFlag() { return supportsFlag; },
    get supportsLoadMode() { return supportsLoadMode; },
    get threads() { return threads; },
    get vramGuardEnabled() { return vramGuardEnabled; },
  });
  function estimateModelFootprintMb(...args) { return serverConfig.estimateModelFootprintMb(...args); }

  function estimateLoadFootprintMb(...args) { return serverConfig.estimateLoadFootprintMb(...args); }

  function assertVramForSwap(...args) { return serverConfig.assertVramForSwap(...args); }

  function findLlamaServerBin(...args) { return modelDiscovery.findLlamaServerBin(...args); }

  function isEnabled(...args) { return modelDiscovery.isEnabled(...args); }

  function findLlamaModel(...args) { return modelDiscovery.findLlamaModel(...args); }

  function findNormalLlamaModel(...args) { return modelDiscovery.findNormalLlamaModel(...args); }

  function findLoraAdapters(...args) { return modelDiscovery.findLoraAdapters(...args); }

  function refreshLoraAdapters(...args) { return modelDiscovery.refreshLoraAdapters(...args); }

  function applyLoraAdapter(...args) { return modelDiscovery.applyLoraAdapter(...args); }

  function isMmprojFile(...args) { return modelDiscovery.isMmprojFile(...args); }

  function findVisionModel(...args) { return modelDiscovery.findVisionModel(...args); }

  function findVisionMmproj(...args) { return modelDiscovery.findVisionMmproj(...args); }

  function chatMmprojFor(...args) { return modelDiscovery.chatMmprojFor(...args); }

  function chatAcceptsImages(...args) { return modelDiscovery.chatAcceptsImages(...args); }

  function getVisionStatus(...args) { return modelDiscovery.getVisionStatus(...args); }

  const serverStartup = createServerStartup({
    get resourceCoordinator() { return resourceCoordinator; },
    get resourceRequest() { return resourceContext.getStore() || {}; },
    get estimateLoadFootprintMb() { return estimateLoadFootprintMb; },
    get kvCacheMb() { return kvCacheMb; },
    get supportsFlag() { return supportsFlag; },
    get assertVramForSwap() { return assertVramForSwap; },
    get backupProfileFor() { return backupProfileFor; },
    get buildServerArgs() { return buildServerArgs; },
    get buildServerEnv() { return buildServerEnv; },
    get chatMmprojFor() { return chatMmprojFor; },
    get configuredContext() { return configuredContext; },
    get detectGpuVramUsage() { return detectGpuVramUsage; },
    get env() { return env; },
    get fetchImpl() { return fetchImpl; },
    get findLlamaModel() { return findLlamaModel; },
    get findLlamaServerBin() { return findLlamaServerBin; },
    get fs() { return fs; },
    get logPerf() { return logPerf; },
    get noteImageTurn() { return noteImageTurn; },
    get nowMs() { return nowMs; },
    get path() { return path; },
    get refreshLoraAdapters() { return refreshLoraAdapters; },
    get registerExit() { return registerExit; },
    get settleActiveBuild() { return settleActiveBuild; },
    get sleep() { return sleep; },
    get spawn() { return spawn; },
    get state() { return state; },
    get stop() { return stop; },
    get swapDebounceMs() { return swapDebounceMs; },
    get toolsDir() { return toolsDir; },
  });
  function serverPort(...args) { return serverStartup.serverPort(...args); }

  function isHealthy(...args) { return serverStartup.isHealthy(...args); }

  function getRunningModelPath(...args) { return serverStartup.getRunningModelPath(...args); }

  function sameModelPath(...args) { return serverStartup.sameModelPath(...args); }

  const lifecycle = createLifecycle({
    get withModelOperation() { return withModelOperation; },
    get resourceCoordinator() { return resourceCoordinator; },
    get resourceContext() { return resourceContext; },
    get threads() { return threads; },
    get configuredContext() { return configuredContext; },
    get CONTEXT_SWITCH_WAIT_MS() { return CONTEXT_SWITCH_WAIT_MS; },
    get contextFits() { return contextFits; },
    get ensureServerConfig() { return ensureServerConfig; },
    get env() { return env; },
    get execFile() { return execFile; },
    get findLlamaModel() { return findLlamaModel; },
    get fs() { return fs; },
    get gaming() { return gaming; },
    get GAMING_IDLE_MS() { return GAMING_IDLE_MS; },
    get getKnownLlamaModelProfiles() { return getKnownLlamaModelProfiles; },
    get isEnabled() { return isEnabled; },
    get killProcessTree() { return killProcessTree; },
    get platform() { return platform; },
    get registerExitHandlers() { return registerExitHandlers; },
    get sleep() { return sleep; },
    get state() { return state; },
    get waitForExit() { return waitForExit; },
  });
  function stop(...args) { return lifecycle.stop(...args); }

  function scheduleIdleShutdown(...args) { return lifecycle.scheduleIdleShutdown(...args); }

  function registerExit(...args) { return lifecycle.registerExit(...args); }

  function buildServerEnv(...args) { return serverConfig.buildServerEnv(...args); }

  // Issue #370: the flags that actually govern throughput/memory (flash-attn,
  // KV-quant, speculative decoding) were process-global, so a conclusion for
  // one profile silently applied to all of them regardless of fit. This
  // table gives per-profile overrides a home, the same way profile selection
  // itself is already hardware-aware. Only entries #332 actually measured a
  // real difference for are populated -- the rest stay `{}` deliberately
  // (documented "nothing special, and why") rather than guessed at.
  //
  // A profile entry only overrides the *default* an unset env var falls
  // back to -- LLAMA_ENABLE_SPEC_NGRAM=0/1 always wins regardless of
  // profile, preserving the "env vars are an explicit override" guarantee
  // this file's other flags already have.
  const PROFILE_TUNING = {
    // #332 measured n-gram speculative decoding as a free +81% win
    // (193->350 tok/s) on repetitive/structured output -- code blocks and
    // tool-call JSON, exactly what the coding profile mostly produces --
    // with no measurable difference (or downside) on conversational prose.
    coding: { enableSpecNgram: true },
    // No profile-specific win measured yet for these: flash-attn already
    // resolves to enabled via `auto` on this hardware regardless of profile,
    // and KV-cache quantization was a wash at Mana's current 4096-token
    // context cap for every profile tested (see #332's findings) -- revisit
    // if the context cap is ever raised significantly, since KV savings
    // scale with context length.
    default: {},
    fast: {},
    quality: {},
  };

  function buildServerArgs(...args) { return serverConfig.buildServerArgs(...args); }

  function startServer(...args) { return serverStartup.startServer(...args); }

  function startCooldownMs(...args) { return serverStartup.startCooldownMs(...args); }

  function ensureServerConfig(...args) { return serverStartup.ensureServerConfig(...args); }

  function settleBuild(...args) { return serverStartup.settleBuild(...args); }

  function ensureServer(...args) { return serverStartup.ensureServer(...args); }

  function chatMmprojToLoad(...args) { return serverStartup.chatMmprojToLoad(...args); }

  function noteImageTurn(...args) { return lifecycle.noteImageTurn(...args); }

  function unloadVision(...args) { return lifecycle.unloadVision(...args); }

  function setGaming(...args) { return lifecycle.setGaming(...args); }

  function inTurn(...args) { return lifecycle.inTurn(...args); }

  function waitForServer(...args) { return serverStartup.waitForServer(...args); }

  function backupProfileFor(...args) { return modelDiscovery.backupProfileFor(...args); }

  const completions = createCompletions({
    get applyLoraAdapter() { return applyLoraAdapter; },
    get buildSamplingParams() { return buildSamplingParams; },
    get ensureServer() { return ensureServer; },
    get ensureServerConfig() { return ensureServerConfig; },
    get env() { return env; },
    get extractThinking() { return extractThinking; },
    get fetchImpl() { return fetchImpl; },
    get findNormalLlamaModel() { return findNormalLlamaModel; },
    get findVisionMmproj() { return findVisionMmproj; },
    get findVisionModel() { return findVisionModel; },
    get getKnownLlamaModelProfiles() { return getKnownLlamaModelProfiles; },
    get isEnabled() { return isEnabled; },
    get isProfileAlreadyLoaded() { return isProfileAlreadyLoaded; },
    get logPerf() { return logPerf; },
    get noteImageTurn() { return noteImageTurn; },
    get nowMs() { return nowMs; },
    get sameModelPath() { return sameModelPath; },
    get scheduleIdleShutdown() { return scheduleIdleShutdown; },
    get state() { return state; },
    get streamSentences() { return streamSentences; },
    get stripThinking() { return stripThinking; },
    get systemPromptOf() { return systemPromptOf; },
  });
  function toImageDataUrl(...args) { return completions.toImageDataUrl(...args); }

  function buildMessages(...args) { return completions.buildMessages(...args); }

  function logPromptCache(...args) { return completions.logPromptCache(...args); }

  function getLastPromptUsage(...args) { return completions.getLastPromptUsage(...args); }

  function countTokens(...args) { return completions.countTokens(...args); }

  function configuredContext(...args) { return completions.configuredContext(...args); }

  function getContextSize(...args) { return completions.getContextSize(...args); }

  function fitThinkingToContext(...args) { return completions.fitThinkingToContext(...args); }

  function runLocalAssistantReply(...args) { return completions.runLocalAssistantReply(...args); }

  function streamLocalAssistantReply(...args) { return completions.streamLocalAssistantReply(...args); }

  function proxyChatCompletion(...args) { return completions.proxyChatCompletion(...args); }

  const toolCalls = createToolCalls({
    get buildSamplingParams() { return buildSamplingParams; },
    get checkToolCallArgs() { return checkToolCallArgs; },
    get env() { return env; },
    get fetchImpl() { return fetchImpl; },
    get state() { return state; },
    get stripEmotionTags() { return stripEmotionTags; },
  });
  function looksLikeFailedToolCallJson(...args) { return toolCalls.looksLikeFailedToolCallJson(...args); }

  function stripThinking(...args) { return toolCalls.stripThinking(...args); }

  function extractThinking(...args) { return toolCalls.extractThinking(...args); }

  function parseTextToolCalls(...args) { return toolCalls.parseTextToolCalls(...args); }

  function buildToolCallRepairSchema(...args) { return toolCalls.buildToolCallRepairSchema(...args); }

  function repairToolCalls(...args) { return withModelOperation(() => toolCalls.repairToolCalls(...args), Math.max(1, Number(threads) || 1)); }

  const goalReview = createGoalReview({
    get buildSamplingParams() { return buildSamplingParams; },
    get CODING_EDIT_TOOL_NAME() { return CODING_EDIT_TOOL_NAME; },
    get CODING_TEST_TOOL_NAME() { return CODING_TEST_TOOL_NAME; },
    get EDIT_GOAL_RE() { return EDIT_GOAL_RE; },
    get ensureServer() { return ensureServer; },
    get env() { return env; },
    get fetchImpl() { return fetchImpl; },
    get SESSION_GOAL_FINISH_TOOL_NAME() { return SESSION_GOAL_FINISH_TOOL_NAME; },
    get state() { return state; },
  });
  function goalRecheckMessage(...args) { return goalReview.goalRecheckMessage(...args); }

  // #787: what the run itself shows, for the review. Measured live, the
  // model-only review passed "fixed" with no edit made and with the tests
  // still failing. No edit on an edit goal is decided here; a failing test
  // run goes to the model review with its output instead, since a suite can
  // fail on something the goal doesn't cover. ponytail: "is this an edit
  // goal" is a verb regex -- a goal worded without one skips the no-edit
  // check and relies on the model review.
  const EDIT_GOAL_RE = /\b(fix|add|rename|change|update|implement|refactor|remove|delete|edit|replace|modify)\b/i;
  function goalEvidence(...args) { return goalReview.goalEvidence(...args); }

  function reviewGoalCompletion(...args) { return withModelOperation(() => goalReview.reviewGoalCompletion(...args), Math.max(1, Number(threads) || 1)); }

  function withContextSize(...args) { return lifecycle.withContextSize(...args); }

  function kvCacheMb(...args) { return serverConfig.kvCacheMb(...args); }

  function contextFits(...args) { return serverConfig.contextFits(...args); }

  const toolReply = createToolReply({
    get withModelOperation() { return withModelOperation; },
    get resourceCoordinator() { return resourceCoordinator; },
    get resourceRequest() { return resourceContext.getStore() || {}; },
    get threads() { return threads; },
    get applyLoraAdapter() { return applyLoraAdapter; },
    get buildMessages() { return buildMessages; },
    get buildSamplingParams() { return buildSamplingParams; },
    get checkToolCallArgs() { return checkToolCallArgs; },
    get ensureServer() { return ensureServer; },
    get env() { return env; },
    get fetchImpl() { return fetchImpl; },
    get fitThinkingToContext() { return fitThinkingToContext; },
    get getContextSize() { return getContextSize; },
    get goalRecheckMessage() { return goalRecheckMessage; },
    get KEEP_RECENT_TOOL_RESULTS() { return KEEP_RECENT_TOOL_RESULTS; },
    get logPerf() { return logPerf; },
    get logPromptCache() { return logPromptCache; },
    get looksLikeFailedToolCallJson() { return looksLikeFailedToolCallJson; },
    get MEMORY_REMEMBER_TOOL() { return MEMORY_REMEMBER_TOOL; },
    get memoryClaimNote() { return memoryClaimNote; },
    get nowMs() { return nowMs; },
    get parseTextToolCalls() { return parseTextToolCalls; },
    get repairToolCalls() { return repairToolCalls; },
    get repairToolCallText() { return repairToolCallText; },
    get reviewGoalCompletion() { return reviewGoalCompletion; },
    get scheduleIdleShutdown() { return scheduleIdleShutdown; },
    get SESSION_GOAL_FINISH_TOOL_NAME() { return SESSION_GOAL_FINISH_TOOL_NAME; },
    get state() { return state; },
    get stripThinking() { return stripThinking; },
    get systemPromptOf() { return systemPromptOf; },
    get TOOL_CALL_UNPARSED_NOTE() { return TOOL_CALL_UNPARSED_NOTE; },
    get WeakSet() { return WeakSet; },
  });
  function runToolAwareReply(...args) { return toolReply.runToolAwareReply(...args); }

  function runBestOfNReply(...args) { return completions.runBestOfNReply(...args); }

  function runVisionReply(...args) { return completions.runVisionReply(...args); }

  function getStatus(...args) { return lifecycle.getStatus(...args); }

  function isProfileAlreadyLoaded(...args) { return lifecycle.isProfileAlreadyLoaded(...args); }

  function runLocalReplyIfSafelyLoaded(...args) { return completions.runLocalReplyIfSafelyLoaded(...args); }

  return {
    backupProfileFor,
    buildServerArgs,
    chatAcceptsImages,
    chatMmprojFor,
    ensureServerConfig,
    findLlamaServerBin,
    findLlamaModel,
    findVisionModel,
    findVisionMmproj,
    getVisionStatus,
    isEnabled,
    // #1281: count proxied requests as in-flight so a self-work context switch
    // (and vision/gaming unloads) waits for them before restarting llama-server.
    proxyChatCompletion: inTurn(proxyChatCompletion),
    streamLocalAssistantReply: inTurn(streamLocalAssistantReply),
    runBestOfNReply: inTurn(runBestOfNReply),
    waitForServer: inTurn(waitForServer),
    runLocalAssistantReply: inTurn(runLocalAssistantReply),
    runToolAwareReply: withContextSize(inTurn(runToolAwareReply)),
    runVisionReply: inTurn(runVisionReply),
    getStatus,
    getLastPromptUsage,
    countTokens,
    getContextSize,
    isProfileAlreadyLoaded,
    runLocalReplyIfSafelyLoaded: inTurn(runLocalReplyIfSafelyLoaded),
    scheduleIdleShutdown,
    setGaming,
    stop,
    supportsLoadMode,
    get systemPrompt() {
      return systemPromptOf();
    },
    applyLoraAdapter: inTurn(applyLoraAdapter),
    findLoraAdapters,
    getActiveLoraAdapter: () => state.activeLoraAdapter || null,
    hasLoraAdapters: () => Boolean(state.hasLoraAdapters),
    unloadVision,
  };
}

module.exports = { createLlamaServerRuntime };
