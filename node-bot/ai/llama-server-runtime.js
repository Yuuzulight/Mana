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
  function supportsFlag(bin, flag) {
    if (!bin) return true;
    if (!helpTexts.has(bin)) {
      let text = "";
      try {
        text = String(probeHelp(bin));
      } catch (e) {
        text = "";
      }
      helpTexts.set(bin, text);
    }
    return helpTexts.get(bin).includes(flag);
  }
  // Without --load-mode, --no-mmap does the same; it's still accepted
  // (deprecated) by builds that do have --load-mode.
  function supportsLoadMode(bin) {
    return supportsFlag(bin, "--load-mode");
  }
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

  // A GGUF file's size on disk is a rough proxy for its VRAM footprint at
  // full offload (-ngl 99, this runtime's default) -- weights dominate the
  // footprint, though KV cache/context buffers aren't captured by file size
  // alone (see the 20% margin below). Only meaningful for a local file path;
  // a bare -hf hub spec has no size to check without downloading it first,
  // so this returns null rather than guessing -- same graceful-fallback
  // policy detectGpuVramMb already follows elsewhere in this codebase.
  function estimateModelFootprintMb(modelSpec) {
    if (!isLocalModelSpec(modelSpec, fs)) {
      return null;
    }
    try {
      const stats = fs.statSync(modelSpec);
      return Math.round(stats.size / (1024 * 1024));
    } catch (e) {
      return null;
    }
  }

  // Sums a model file with its optional mmproj (vision loads carry a
  // separate projector file, also fully GPU-offloaded alongside the main
  // model) -- null only when the *model* itself can't be sized, since that's
  // the dominant term; an unsizeable mmproj just contributes 0 rather than
  // discarding a real model-size estimate over a secondary file.
  function estimateLoadFootprintMb(modelSpec, mmprojSpec) {
    const modelMb = estimateModelFootprintMb(modelSpec);
    if (modelMb === null) return null;
    const mmprojMb = mmprojSpec ? estimateModelFootprintMb(mmprojSpec) || 0 : 0;
    return modelMb + mmprojMb;
  }

  // Checked BEFORE the outgoing model (if any) is stopped, not after --
  // stopping first and only then discovering the replacement doesn't fit
  // would leave nothing loaded at all, which is worse than refusing the
  // swap up front. Since the outgoing model's VRAM isn't freed yet at this
  // point, its own estimated footprint is added back to current free VRAM
  // to approximate what stopping it is about to release.
  function assertVramForSwap(model, mmproj) {
    if (!vramGuardEnabled) return;
    const targetFootprintMb = estimateLoadFootprintMb(model, mmproj);
    if (targetFootprintMb === null) return;
    const usage = detectGpuVramUsage();
    if (!usage || !Number.isFinite(usage.freeMb)) return;

    const outgoingFootprintMb =
      (state.model && estimateLoadFootprintMb(state.model, state.mmproj)) || 0;
    const projectedFreeMb = usage.freeMb + outgoingFootprintMb;
    const requiredMb = Math.round(targetFootprintMb * 1.2);

    if (projectedFreeMb < requiredMb) {
      throw new Error(
        `llama-server: refusing to load ${model} -- estimated ${targetFootprintMb}MB model` +
          `${mmproj ? " (incl. mmproj)" : ""} needs ~${requiredMb}MB free VRAM, only ` +
          `~${projectedFreeMb}MB projected free (${usage.freeMb}MB free now + ` +
          `~${outgoingFootprintMb}MB from the outgoing model, if any). ` +
          `Set LLAMA_SERVER_VRAM_GUARD=0 to override.`,
      );
    }
  }

  function findLlamaServerBin() {
    const candidates = [];
    // #693: a build switched in by an update (tools/llama/active.json)
    // comes first; with no pointer, or an unreadable one, the order below
    // is exactly what it was before. path.win32 for the same reason as
    // LLAMA_BIN below: the pointer always names a Windows folder.
    const pointer = readActivePointer(toolsDir, fs);
    if (pointer) {
      candidates.push(path.win32.join(pointer.active, "llama-server.exe"));
    }
    if (env.LLAMA_SERVER_BIN) {
      candidates.push(env.LLAMA_SERVER_BIN);
    }
    if (env.LLAMA_BIN) {
      // LLAMA_BIN always names a Windows .exe (this module only supports
      // the bundled Windows/CUDA llama-server build) -- use path.win32
      // explicitly so this resolves the same way regardless of which OS
      // Node itself is running on (native path.dirname/join would silently
      // misparse a "C:\..." string as a relative path on a POSIX host).
      candidates.push(
        path.win32.join(path.win32.dirname(env.LLAMA_BIN), "llama-server.exe"),
      );
    }

    const bundledLlamaDir = path.join(
      toolsDir,
      "llama-b9436-bin-win-cuda-12.4-x64",
    );
    candidates.push(
      path.join(bundledLlamaDir, "llama-server.exe"),
      path.join(toolsDir, "llama-server.exe"),
    );

    const validPath = candidates.find(
      (candidate) => candidate && fs.existsSync(candidate),
    );
    if (validPath) {
      return validPath;
    }

    const checked = candidates.filter(Boolean).join(", ");
    throw new Error(
      `llama-server executable not found. Checked: ${checked}. Set LLAMA_SERVER_BIN to a valid llama-server.exe path.`,
    );
  }

  function isEnabled() {
    if (env.MANA_LLAMA_SERVER === "0") {
      return false;
    }
    // Never spawn a persistent server from test runs: a killed test process
    // cannot clean up its children, which leaves orphaned llama-server.exe
    // processes behind. NODE_TEST_CONTEXT is set by the node:test runner.
    if (env.NODE_ENV === "test" || env.NODE_TEST_CONTEXT) {
      return false;
    }
    try {
      findLlamaServerBin();
      return true;
    } catch (e) {
      return false;
    }
  }

  // #889: while the gaming model is in use, every profile resolves to it.
  function findLlamaModel(profile = "default") {
    return state.gamingModel ? env.MANA_GAMING_LLAMA_MODEL : findNormalLlamaModel(profile);
  }

  function findNormalLlamaModel(profile = "default") {
    const storedPath = modelSettingsStore ? modelSettingsStore.getModelPath() : null;
    return findPreferredLlamaModel({
      explicitModel: storedPath || env.LLAMA_MODEL || "",
      searchDir: toolsDir,
      profile,
    });
  }

  function isMmprojFile(filePath) {
    return path.basename(filePath).toLowerCase().includes("mmproj");
  }

  // Vision models are resolved separately from the chat profiles: falling
  // back to a text model would make llama-server reject every image request.
  function findVisionModel() {
    const storedPath = modelSettingsStore
      ? modelSettingsStore.getVisionSettings().modelPath
      : "";
    const explicitVisionModel = storedPath || env.LLAMA_VISION_MODEL;
    if (explicitVisionModel) {
      if (fs.existsSync(explicitVisionModel)) {
        return explicitVisionModel;
      }
      throw new Error(
        `Vision model is set but does not exist: ${explicitVisionModel}`,
      );
    }

    const ggufs = collectFilesRecursively(toolsDir, (fullPath) =>
      fullPath.toLowerCase().endsWith(".gguf"),
    );
    const candidates = ggufs.filter((fullPath) => {
      if (isMmprojFile(fullPath)) return false;
      return /(^|[-_.])(vl|vision|llava|minicpm-v|moondream|gemma-3|gemma-4)/i.test(
        path.basename(fullPath),
      );
    });
    if (!candidates.length) {
      throw new Error(
        "No local vision model found. Place a vision GGUF (e.g. Qwen2.5-VL) and its mmproj file under tools/llama/gguf-models, or set LLAMA_VISION_MODEL. See docs/vision_setup.md.",
      );
    }

    // Prefer smaller, well-supported models first.
    const preferenceOrder = [
      "qwen2.5-vl-3b",
      "gemma-4",
      "qwen2.5-vl",
      "minicpm-v",
      "gemma-3",
      "llava",
    ];
    const rank = (fullPath) => {
      const name = path.basename(fullPath).toLowerCase();
      const index = preferenceOrder.findIndex((token) => name.includes(token));
      return index === -1 ? preferenceOrder.length : index;
    };
    candidates.sort((a, b) => rank(a) - rank(b));
    return candidates[0];
  }

  function findVisionMmproj(modelPath) {
    const storedPath = modelSettingsStore
      ? modelSettingsStore.getVisionSettings().mmprojPath
      : "";
    const explicitMmproj = storedPath || env.LLAMA_VISION_MMPROJ;
    if (explicitMmproj) {
      if (fs.existsSync(explicitMmproj)) {
        return explicitMmproj;
      }
      throw new Error(
        `Vision mmproj is set but does not exist: ${explicitMmproj}`,
      );
    }

    const modelDir = path.dirname(modelPath);
    const mmprojFiles = collectFilesRecursively(modelDir, (fullPath) =>
      fullPath.toLowerCase().endsWith(".gguf"),
    ).filter(isMmprojFile);
    if (!mmprojFiles.length) {
      throw new Error(
        `No mmproj file found next to ${modelPath}. Download the matching mmproj GGUF for the vision model, or set LLAMA_VISION_MMPROJ. See docs/vision_setup.md.`,
      );
    }

    // #872: Q8_0 first -- it read test images as well as F16 for ~280 MiB
    // less VRAM. Then prefer one that shares the model's family token
    // (e.g. "qwen2.5-vl").
    mmprojFiles.sort((a, b) => /-q8_0\.gguf$/i.test(b) - /-q8_0\.gguf$/i.test(a));
    const modelName = path.basename(modelPath).toLowerCase();
    const familyToken = (modelName.match(/^[a-z0-9.]+(-vl)?/i) || [""])[0];
    const match = mmprojFiles.find(
      (fullPath) =>
        familyToken &&
        path.basename(fullPath).toLowerCase().includes(familyToken),
    );
    return match || mmprojFiles[0];
  }

  // #679: the vision mmproj when the vision model is this same file (a
  // natively multimodal chat model, the setup .env.sample documents), else
  // null. #872: the chat server only loads it once an image turn wants it
  // (state.visionWanted) and drops it again after MANA_VISION_IDLE_MS.
  function chatMmprojFor(model) {
    // #889: never with the gaming model (a small model may not see images);
    // image turns go describe-first instead.
    if (state.gamingModel) return null;
    try {
      const visionModel = findVisionModel();
      // path.relative is case-insensitive on Windows.
      return path.relative(visionModel, model) === "" ? findVisionMmproj(visionModel) : null;
    } catch {
      return null;
    }
  }

  function chatAcceptsImages(profile) {
    try {
      return Boolean(chatMmprojFor(findLlamaModel(profile)));
    } catch {
      return false;
    }
  }

  function getVisionStatus() {
    try {
      const model = findVisionModel();
      const mmproj = findVisionMmproj(model);
      return { available: true, model, mmproj };
    } catch (error) {
      return { available: false, reason: error.message };
    }
  }

  function serverPort() {
    return Number(env.LLAMA_SERVER_PORT || 8090);
  }

  async function isHealthy(port) {
    try {
      const resp = await fetchImpl(`http://127.0.0.1:${port}/health`);
      return Boolean(resp && resp.ok);
    } catch (e) {
      return false;
    }
  }

  async function getRunningModelPath(port) {
    try {
      const resp = await fetchImpl(`http://127.0.0.1:${port}/props`);
      if (!resp || !resp.ok) return null;
      const props = await resp.json();
      return props && props.model_path ? String(props.model_path) : null;
    } catch (e) {
      return null;
    }
  }

  function sameModelPath(a, b) {
    if (!a || !b) return false;
    try {
      return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    } catch (e) {
      return String(a).toLowerCase() === String(b).toLowerCase();
    }
  }

  function stop() {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    const child = state.child;
    state.child = null;
    state.model = null;
    state.mmproj = null;
    state.port = null;
    if (child) {
      killProcessTree(child, { platform, execFile, env });
      state.stopping = waitForExit(child, "llama-server");
    }
    return child;
  }

  function scheduleIdleShutdown() {
    // Default: release the model (RAM and, with GPU offload, VRAM) after 10
    // minutes without a reply. Set LLAMA_SERVER_IDLE_MS=0 to keep it resident.
    const idleMs = Number(
      env.LLAMA_SERVER_IDLE_MS === undefined ? 600000 : env.LLAMA_SERVER_IDLE_MS,
    );
    if (!idleMs || idleMs <= 0 || Number.isNaN(idleMs)) {
      return;
    }
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }
    state.idleTimer = setTimeout(() => {
      // A timer left over from before an unexpected exit must not kill the
      // restart in progress (a failed start counts against a #693 build);
      // the reply it's for schedules a fresh one.
      if (state.starting) return;
      const port = state.port;
      // #872: and the next start is text-only until an image asks again.
      state.visionWanted = false;
      const child = stop();
      if (!child) {
        // Adopted (see startServer): no handle to it, so nothing to kill.
        if (port) {
          console.log(
            `llama-server idle for ${idleMs}ms, but the one on port ${port} wasn't started by this backend -- leaving it running`,
          );
        }
        return;
      }
      console.log(`llama-server idle for ${idleMs}ms, shutting it down (pid ${child.pid})`);
      state.stopping.then((exited) => {
        if (exited) console.log(`llama-server (pid ${child.pid}) stopped`);
      });
    }, idleMs);
    if (typeof state.idleTimer.unref === "function") {
      state.idleTimer.unref();
    }
  }

  function registerExit() {
    if (!registerExitHandlers || state.exitHandlerRegistered) {
      return;
    }
    state.exitHandlerRegistered = true;
    process.once("exit", () => {
      stop();
    });
    // Best-effort cleanup on Ctrl+C / termination so the server child is not
    // orphaned. A hard kill of the backend still leaves the child running,
    // but the next backend start adopts it via the same-model port check.
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        stop();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }
  }

  // GGML_CUDA_ENABLE_UNIFIED_MEMORY is a ggml-cuda runtime env var (not a
  // llama-server CLI flag): it switches the CUDA backend to cudaMallocManaged
  // allocations, letting inactive weights page to system RAM under memory
  // pressure instead of the driver hard-failing the allocation. Measured
  // real cold-start/swap latency on an RTX 3070 Ti (see
  // docs/roadmap/issue-68-vram-hotswap-tuning.md): ~64% faster cold start
  // (11.4s -> 4.1s) and ~32% faster on the larger 4B->7B swap direction.
  // Off by default now: on the RTX 5080 machine, every llama-server
  // stop with it on left ~5 GB of system RAM committed to no process (model
  // sized, gone only after a reboot; 4 of 4 runs). With it off nothing was
  // left behind (3 of 3), including a forced kill after a 60 s CTRL_C wait,
  // so it's the unified memory, not the kill. MANA_LLAMA_UNIFIED_MEMORY=1
  // opts back in.
  function buildServerEnv() {
    if (env.MANA_LLAMA_UNIFIED_MEMORY === "1") {
      return { ...env, GGML_CUDA_ENABLE_UNIFIED_MEMORY: "1" };
    }
    return env;
  }

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

  function buildServerArgs(model, port, mmproj = null, profile = null, bin = null) {
    const args = [
      isLocalModelSpec(model, fs) ? "-m" : "-hf",
      model,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "-t",
      String(threads),
      "--no-webui",
    ];
    if (mmproj) {
      args.push("--mmproj", mmproj);
    }

    // Reasoning models (e.g. Qwen3) otherwise spend the whole token budget
    // "thinking" and return an empty content field — a spoken companion
    // needs direct replies. MANA_LLAMA_REASONING=on|auto re-enables it.
    const reasoning = ["on", "off", "auto"].includes(
      String(env.MANA_LLAMA_REASONING || "").toLowerCase(),
    )
      ? String(env.MANA_LLAMA_REASONING).toLowerCase()
      : "off";
    args.push("--reasoning", reasoning);

    // Issue #360: every profile switch kills and respawns this whole
    // process (see startServer below), so a return to a previously-active
    // model relies entirely on the OS page cache (mmap is llama.cpp's
    // default) to avoid a genuine cold disk read -- fine most of the time,
    // but those cached pages can be evicted under memory pressure from
    // anything else running, showing up as an occasional slow p95 switch.
    // --mlock pins the model in physical RAM so a switch back is always
    // fast, at the real cost of denying that RAM back to the OS even when
    // something else (a game) needs it -- opt-in only, never a default.
    //
    // Otherwise the model loads straight into VRAM by default: with full
    // GPU offload, mmap still maps the whole GGUF into this process --
    // measured on an RTX 5080 / 32 GB box (9B Q4_K_M, -ngl 99, -c 16384)
    // that drove llama-server to ~5 GB working set and system RAM 79% ->
    // 95%+; without mmap it loaded in 6.7s at ~1.1 GB (+3.7 points RAM).
    // `--load-mode none` is b10507's replacement for the deprecated
    // --no-mmap. A switch back then re-reads the file instead of relying on
    // the page cache above, and with a low LLAMA_NGL the CPU layers become
    // private memory, so Settings > Model or MANA_LLAMA_MMAP=1 turns mmap
    // back on (see model-settings-store.js).
    const loadIntoVram = modelSettingsStore
      ? modelSettingsStore.isLoadIntoVram(env)
      : env.MANA_LLAMA_MMAP !== "1";
    if (env.LLAMA_MLOCK === "1") {
      args.push("--mlock");
    } else if (loadIntoVram) {
      if (supportsLoadMode(bin)) {
        args.push("--load-mode", "none");
      } else {
        args.push("--no-mmap");
      }
    }

    // Issue #660: llama-server keeps a host-RAM prompt cache (b10507
    // default 8 GiB). Uncapped, its working set grew 0.9 -> 4.6 GB over one
    // session. The in-slot KV cache (VRAM) already gives turn-to-turn prefix
    // reuse; the host cache only helps when requests hop slots or sessions,
    // so 1 GiB keeps most of that. LLAMA_CACHE_RAM overrides it (MiB; -1 =
    // no limit, 0 = off).
    // #889: the gaming model gets MANA_GAMING_CACHE_RAM (256): a live FFXIV
    // run showed system RAM, not VRAM, runs out first while gaming.
    if (supportsFlag(bin, "--cache-ram")) {
      const [setting, fallback] = state.gamingModel ? [env.MANA_GAMING_CACHE_RAM, 256] : [env.LLAMA_CACHE_RAM, 1024];
      const cacheRam = Number(String(setting || "").trim() || fallback);
      args.push("--cache-ram", String(Number.isInteger(cacheRam) && cacheRam >= -1 ? cacheRam : fallback));
    }

    // Same opt-in hardware flags as the llama-cli path.
    if (env.LLAMA_ENABLE_FLASHATTN === "1") {
      args.push("--flash-attn", env.LLAMA_ARG_FLASH_ATTN || "auto");
    }
    // #889: the gaming model's KV cache type. A quantized V cache needs
    // flash attention, which llama-server's default (auto) turns on for it.
    const kvCache = state.gamingModel ? env.MANA_GAMING_KV_CACHE || "q8_0" : env.LLAMA_KV_COMPRESS;
    if (kvCache) {
      args.push("-ctk", kvCache);
      args.push("-ctv", kvCache);
    }
    if (env.LLAMA_ENABLE_NO_KV_OFFLOAD === "1") {
      args.push("--no-kv-offload");
    }

    // Issue #332: speculative decoding, both opt-in and independent of each
    // other -- --spec-type takes a comma-separated list, so both can be
    // active together if a caller sets both env vars.
    //
    // N-gram/lookup: drafts candidate tokens by pattern-matching against the
    // ongoing generation itself -- no second model, no extra VRAM. Defaults
    // to ngram-simple, llama.cpp's simplest/most-tested lookup variant, when
    // the gate is on but no specific variant is named. Deliberately doesn't
    // wire ngram-cache's -lcs/-lcd persisted-cache-file flags -- that's a
    // different feature (a cache surviving across process restarts) than
    // "match against this generation," and the other ngram-* variants
    // already provide the latter without needing an external cache file.
    //
    // Draft-model: loads a genuinely separate, smaller model alongside the
    // target and drafts tokens by actually running it. LLAMA_SPEC_DRAFT_MODEL
    // is the draft model's own path, same convention as LLAMA_MODEL/
    // LLAMA_VISION_MODEL. Only draft-simple is wired -- draft-eagle3/
    // draft-mtp need the target model itself trained for that, which is
    // unconfirmed for Mana's current models (see the issue's own scope
    // note).
    //
    // -ngld (--spec-draft-ngl) is explicitly set to match the target's own
    // -ngl here, rather than left at its own 'auto' default -- measured
    // directly (issue #332): with a real coder-7B target + a same-family
    // 1.5B draft, -ngld auto left the draft model mostly off-GPU and
    // generation ran at 14.6 tok/s (vs. a 97.4 tok/s no-draft baseline on
    // identical hardware); forcing -ngld to match -ngl recovered most of
    // that to 78.7 tok/s. Still slower than no draft at all on this
    // single-GPU setup even at a 93% token-acceptance rate -- draft-model
    // speculative decoding stays opt-in rather than a recommended default,
    // but a caller who does enable it shouldn't hit a measured, avoidable
    // 5x regression from an unrelated default.
    const ngl = env.LLAMA_NGL || "99";
    const specTypes = [];
    const profileDefaults = PROFILE_TUNING[profile] || {};
    const specNgramEnabled =
      env.LLAMA_ENABLE_SPEC_NGRAM === "1"
        ? true
        : env.LLAMA_ENABLE_SPEC_NGRAM === "0"
          ? false
          : Boolean(profileDefaults.enableSpecNgram);
    if (specNgramEnabled) {
      specTypes.push(env.LLAMA_SPEC_NGRAM_TYPE || "ngram-simple");
    }
    if (env.LLAMA_SPEC_DRAFT_MODEL) {
      specTypes.push("draft-simple");
      args.push("--spec-draft-model", env.LLAMA_SPEC_DRAFT_MODEL);
      args.push("--spec-draft-ngl", String(ngl));
    }
    if (specTypes.length) {
      args.push("--spec-type", specTypes.join(","));
    }

    if (ngl) {
      args.push("-ngl", String(ngl));
    }
    const contextCap = configuredContext();

    // Issue #462: opt-in real concurrency, now that the 16GB card leaves
    // room for it (was rejected on the prior 8GB card -- see
    // docs/roadmap/issue-70-best-of-n.md). llama.cpp divides a single -c
    // budget evenly across slots, so a bare --parallel N would silently
    // shrink every request's context to 1/N of today's value; multiplying
    // -c by N here keeps each slot's effective context unchanged from the
    // single-slot default, matching this file's existing convention of a
    // flag never changing behavior unless explicitly opted into.
    const parallel = Number(env.LLAMA_PARALLEL || "1");
    if (parallel > 1) {
      args.push("--parallel", String(parallel));
      args.push("-c", String(contextCap * parallel));
    } else if (contextCap) {
      args.push("-c", String(contextCap));
    }

    return args;
  }

  async function startServer(model, mmproj = null, profile = null) {
    state.lastStartBin = null;
    const bin = findLlamaServerBin();
    state.lastStartBin = bin;
    const port = serverPort();
    // A just-stopped server holds the port until it has really exited; a
    // new one spawned before that fails to bind, which #693 would count
    // against the build.
    await state.stopping;

    // If something already answers on the target port (e.g. a server left
    // over from a previous backend run), adopt it when it serves the same
    // model instead of failing to bind.
    if (await isHealthy(port)) {
      const runningModel = await getRunningModelPath(port);
      if (sameModelPath(runningModel, model)) {
        state.child = null;
        state.model = model;
        state.mmproj = mmproj;
        state.port = port;
        console.log(
          `Adopted existing llama-server on port ${port} (model: ${model})`,
        );
        registerExit();
        return;
      }
      throw new Error(
        `Port ${port} is already in use by another llama-server (model: ${runningModel || "unknown"}). Set LLAMA_SERVER_PORT to a free port.`,
      );
    }

    const args = buildServerArgs(model, port, mmproj, profile, bin);
    console.log("Starting llama-server:", bin, args.join(" "));
    const child = spawn(bin, args, {
      // bin always names a Windows llama-server.exe -- path.win32 so this
      // resolves the same way regardless of which OS Node itself is
      // running on (bin can come straight from LLAMA_SERVER_BIN unchanged).
      cwd: path.win32.dirname(bin),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: buildServerEnv(),
    });

    let stderrTail = "";
    let exited = false;
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => {
        stderrTail = (stderrTail + String(chunk)).slice(-4000);
      });
    }
    child.on("error", () => {
      exited = true;
    });
    child.on("exit", (code) => {
      exited = true;
      if (state.child === child) {
        state.child = null;
        state.model = null;
        state.mmproj = null;
        state.port = null;
        console.warn(`llama-server exited unexpectedly (code ${code})`);
      }
    });

    state.child = child;
    state.port = port;

    const timeoutMs = Number(env.LLAMA_SERVER_STARTUP_TIMEOUT_MS || 180000);
    const startedWaitingAt = nowMs();
    for (;;) {
      if (exited) {
        stop();
        throw new Error(
          `llama-server exited during startup: ${stderrTail.slice(-1000)}`,
        );
      }
      if (await isHealthy(port)) {
        break;
      }
      if (nowMs() - startedWaitingAt > timeoutMs) {
        stop();
        throw new Error(
          `llama-server did not become healthy within ${timeoutMs}ms: ${stderrTail.slice(-1000)}`,
        );
      }
      await sleep(750);
    }

    state.model = model;
    state.mmproj = mmproj;
    registerExit();
    console.log(
      `llama-server ready on port ${port} (model: ${model}${mmproj ? `, mmproj: ${mmproj}` : ""})`,
    );
  }

  // #666: cooldown after the Nth consecutive failed start of one model.
  function startCooldownMs(failureCount) {
    return Math.min(
      Number(env.LLAMA_SERVER_RETRY_COOLDOWN_MS || 300000),
      5000 * 3 ** (failureCount - 1),
    );
  }

  // profile only affects which flags a *new* start gets (see PROFILE_TUNING
  // above) -- if the same model+mmproj is already running and healthy, that
  // process keeps whatever flags it started with, even if called again
  // under a different profile label. This only matters when two profiles'
  // fallback lists resolve to the same actual file (rare; today's coding
  // profile's own primary model is distinct from the others'), and forcing
  // a restart on a profile-label-only change would undo the "don't restart
  // for no reason" debounce/adoption logic below for a cosmetic difference.
  // onWait (#666) is called whenever this call is about to wait on a
  // (re)start, so a chat turn can tell the user it's waking up.
  async function ensureServerConfig(model, mmproj = null, profile = null, onWait = null) {
    // After a failed start (missing binary, port conflict, out of memory),
    // don't re-pay the startup wait on every reply; let the llama-cli
    // fallback serve until the cooldown expires. #666: per model, and it
    // backs off -- 5s after the first failure, x3 per repeat, capped at
    // LLAMA_SERVER_RETRY_COOLDOWN_MS -- so a transient failure no longer
    // locks the model out for five minutes.
    const failure = state.startFailures.get(model);
    if (failure) {
      const retryAfterMs = failure.at + startCooldownMs(failure.count) - nowMs();
      if (retryAfterMs > 0) {
        const error = new Error(
          "llama-server recently failed to start; retry cooldown active",
        );
        error.retryAfterMs = retryAfterMs;
        throw error;
      }
    }

    if (state.starting) {
      if (onWait) onWait();
      try {
        await state.starting;
      } catch (e) {
        // Previous start failed; fall through and retry below.
      }
    }

    if (
      state.model === model &&
      (state.mmproj || null) === (mmproj || null) &&
      state.port &&
      (await isHealthy(state.port))
    ) {
      return;
    }

    // Live run (2026-09-29): a call that got past the checks above while
    // another one was already restarting started a second server; the one
    // that lost the state.child slot kept running untracked, so idle
    // shutdown had nothing to kill. From here to `state.starting =` is
    // synchronous, so re-checking once is enough.
    if (state.starting) {
      return ensureServerConfig(model, mmproj, profile, onWait);
    }

    const isRunning = Boolean(state.child || state.port);
    if (
      isRunning &&
      state.model &&
      state.model !== model &&
      swapDebounceMs > 0 &&
      // #889: swaps to or from the gaming model are never skipped.
      ![model, state.model].includes(env.MANA_GAMING_LLAMA_MODEL) &&
      state.loadedAt !== null &&
      nowMs() - state.loadedAt < swapDebounceMs
    ) {
      console.log(
        `llama-server: swap to ${model} debounced (current model loaded ${nowMs() - state.loadedAt}ms ago, ` +
          `window ${swapDebounceMs}ms); serving from ${state.model} instead`,
      );
      return;
    }

    assertVramForSwap(model, mmproj);

    if (onWait) onWait();
    const swapStartedAt = nowMs();
    if (isRunning) {
      if (state.model && state.model !== model) {
        console.log(
          `llama-server: switching model ${state.model} -> ${model}`,
        );
      }
      stop(); // startServer() waits for the exit
    }

    state.loading = { model, since: nowMs() };
    state.starting = startServer(model, mmproj, profile);
    try {
      await state.starting;
      state.startFailures.delete(model);
      state.loadedAt = nowMs();
      // #693: only a process this runtime spawned proves the new build
      // works -- an adopted server may still be the old one.
      if (state.child) {
        settleBuild(null);
      }
      if (isRunning) {
        state.lastSwapMs = state.loadedAt - swapStartedAt;
        logPerf("llama-server-swap", swapStartedAt);
        // Issue #320: visibility only -- logged, not gated on. Lets a real
        // swap's actual post-load headroom be compared against
        // assertVramForSwap's pre-load estimate above.
        const postSwapUsage = detectGpuVramUsage();
        const vramNote = postSwapUsage
          ? `, ${postSwapUsage.freeMb}MB VRAM free`
          : "";
        console.log(`llama-server: swap completed in ${state.lastSwapMs}ms${vramNote}`);
      }
    } catch (e) {
      const count = (state.startFailures.get(model)?.count || 0) + 1;
      state.startFailures.set(model, { at: nowMs(), count });
      e.retryAfterMs = startCooldownMs(count);
      // #693: an update-installed build that won't start is swapped back
      // to the previous one; skip the retry cooldown so the next reply
      // starts on it straight away instead of falling back to llama-cli.
      if (settleBuild(e)) {
        state.startFailures.clear();
        e.retryAfterMs = 0;
      }
      throw e;
    } finally {
      state.starting = null;
      state.loading = null;
    }
  }

  // Returns true when the pointer was rolled back. Pointer I/O problems are
  // logged, never allowed to change how a start succeeded or failed.
  function settleBuild(startError) {
    if (!state.lastStartBin) return false;
    try {
      const next = settleActiveBuild(toolsDir, fs, path.win32.dirname(state.lastStartBin), startError);
      if (next && startError) {
        console.warn(
          `llama-server failed to start on updated build ${next.lastRollback.from}; ` +
            `rolled back to ${next.lastRollback.to}. Reason: ${next.lastRollback.reason}`,
        );
        return true;
      }
    } catch (pointerError) {
      console.warn(`llama-server: could not update tools/llama/active.json: ${pointerError.message}`);
    }
    return false;
  }

  // #872: images = the turn's attached images, if any. The first image turn
  // restarts the chat server with its mmproj; later turns keep it until
  // unloadVision().
  async function ensureServer(profile, images = null) {
    if (images?.length) noteImageTurn();
    const model = findLlamaModel(profile);
    return ensureServerConfig(model, chatMmprojToLoad(model), profile);
  }

  function chatMmprojToLoad(model) {
    return state.visionWanted ? chatMmprojFor(model) : null;
  }

  // #872: (re)starts the vision idle countdown. While a watched game runs
  // it's the embedder's short gaming idle, so a mid-game image doesn't
  // hold the mmproj's VRAM for 10 minutes.
  function noteImageTurn() {
    state.visionWanted = true;
    clearTimeout(state.visionTimer);
    const idleMs = gaming()
      ? GAMING_IDLE_MS
      : Number(env.MANA_VISION_IDLE_MS === undefined ? 600000 : env.MANA_VISION_IDLE_MS);
    if (!(idleMs > 0)) return; // 0: kept until the server's own idle shutdown
    state.visionTimer = setTimeout(unloadVision, idleMs);
    state.visionTimer.unref?.();
  }

  // #872: restarts the chat server without its mmproj (idle, or a watched
  // game started). Mid-reply it waits: the last reply to finish calls it
  // again (see inTurn).
  function unloadVision() {
    if (state.busy > 0) {
      state.visionUnloadPending = true;
      return;
    }
    state.visionUnloadPending = false;
    clearTimeout(state.visionTimer);
    state.visionWanted = false;
    if (!state.mmproj || state.starting) return;
    // Only a chat model's server: a separate vision model (describe-first)
    // is swapped out by the next chat turn anyway.
    const profile = getKnownLlamaModelProfiles().find(isProfileAlreadyLoaded);
    if (!profile) return;
    console.log("Vision idle: restarting llama-server without the mmproj");
    ensureServerConfig(state.model, null, profile).then(
      // stop() cleared the idle shutdown; the restarted server needs one.
      scheduleIdleShutdown,
      (e) => console.warn("llama-server restart without the mmproj failed:", e.message),
    );
  }

  // #889: a watched game started (true) or ended (false). With
  // MANA_GAMING_LLAMA_MODEL set, the chat server swaps to that model (see
  // buildServerArgs for its context and KV cache) so Fish can stay on the
  // GPU next to the game, and back when it ends. Without it, a game start
  // only drops the vision mmproj (#872). Like unloadVision, a swap that
  // lands mid-reply waits for the last reply to finish (see inTurn).
  function setGaming(on) {
    const gamingModel = env.MANA_GAMING_LLAMA_MODEL;
    if (!gamingModel || (on && !fs.existsSync(gamingModel))) {
      if (gamingModel) console.warn(`MANA_GAMING_LLAMA_MODEL not found, keeping the normal model: ${gamingModel}`);
      if (on) unloadVision();
      return;
    }
    if (state.busy > 0) {
      state.gamingSwapPending = on;
      // The swap drops the mmproj anyway; one restart, not two.
      if (on) state.visionUnloadPending = false;
      return;
    }
    state.gamingSwapPending = null;
    if (state.gamingModel === on) return;
    state.gamingModel = on;
    clearTimeout(state.visionTimer);
    state.visionWanted = false;
    // Nothing loaded: the next turn starts the right model.
    if (!state.port && !state.starting) return;
    console.log(`Watched game ${on ? "started" : "ended"}: restarting llama-server with the ${on ? "gaming" : "normal"} model`);
    ensureServerConfig(findLlamaModel(), null, "default").then(
      scheduleIdleShutdown,
      (e) => console.warn("llama-server gaming model swap failed:", e.message),
    );
  }

  // #872: counts a reply as in flight, so unloadVision (and #889's
  // setGaming) never restarts the server under it.
  function inTurn(fn) {
    return async (...args) => {
      state.busy += 1;
      try {
        return await fn(...args);
      } finally {
        state.busy -= 1;
        if (state.busy === 0 && state.gamingSwapPending !== null) setGaming(state.gamingSwapPending);
        if (state.busy === 0 && state.visionUnloadPending) unloadVision();
      }
    };
  }

  // #666: a chat turn waits out a llama-server (re)start or a brief outage
  // instead of failing. Retries back off (2s, 6s, 18s, or the cooldown if
  // longer) while they fit in LLAMA_SERVER_TURN_WAIT_MS (20s), then the
  // profile's fallbackProfile gets one try. onWait fires at most once, the
  // first time the turn actually has to wait. Resolves to the profile that
  // is ready; rejects with the primary's error when nothing came up.
  async function waitForServer(profile, onWait = null, images = null) {
    if (images?.length) noteImageTurn();
    let waited = false;
    const notify = () => {
      if (waited) return;
      waited = true;
      if (onWait) onWait();
    };
    const deadline = nowMs() + Number(env.LLAMA_SERVER_TURN_WAIT_MS || 20000);
    const model = findLlamaModel(profile);
    for (let delayMs = 2000; ; delayMs *= 3) {
      try {
        await ensureServerConfig(model, chatMmprojToLoad(model), profile, notify);
        return profile;
      } catch (e) {
        const waitMs = Math.max(delayMs, e.retryAfterMs || 0);
        if (nowMs() + waitMs <= deadline) {
          notify();
          await sleep(waitMs);
          continue;
        }
        const fallback = backupProfileFor(profile);
        if (!fallback) throw e;
        try {
          const fallbackModel = findLlamaModel(fallback);
          await ensureServerConfig(fallbackModel, chatMmprojToLoad(fallbackModel), fallback, notify);
        } catch {
          throw e;
        }
        return fallback;
      }
    }
  }

  // #666: the profile's fallbackProfile, or null when it has none or it
  // resolves to the same model file (retrying that model wouldn't help).
  function backupProfileFor(profile) {
    const fallback = LLAMA_MODEL_PROFILES[profile]?.fallbackProfile;
    const fallbackModel = fallback ? findLlamaModel(fallback) : null;
    return fallbackModel && fallbackModel !== findLlamaModel(profile) ? fallback : null;
  }

  // Issue #282: splices caller-supplied memory entries into the message
  // array at either end -- "early" right after the persona system message,
  // "late" right before the live user message (the higher-salience
  // position, closest to what's actually being asked). Omitting
  // extraMessages entirely preserves today's exact 2-message shape.
  // Issue #660: "early" is only for content that is stable across turns --
  // anything there becomes part of the prompt prefix llama-server's prompt
  // cache reuses, so per-turn content there would invalidate it each turn.
  //
  // Only the first message may be system-role: Qwen3.5's chat template (the
  // default model) raises "System message must be at the beginning" for any
  // later one, and llama-server answers 500 -- so every turn with memory
  // fell back to llama-cli. System-role entries are folded instead: early
  // ones into the leading system message (where they already sat), late
  // ones onto the front of the live user message (still last in the prompt,
  // so the stable prefix stays cacheable, #660). Other roles pass through.
  //
  // #679: extraMessages.images (data URLs) ride on the live user message,
  // but only when the running server has an mmproj -- a text-only server
  // (a backup profile, say) would reject the whole request, so they are
  // dropped there and the model answers from the text alone.
  // Bare base64 becomes a data URL (runVisionReply's rule); anything else
  // that isn't one stays unusable to llama-server rather than a URL it fetches.
  function toImageDataUrl(image) {
    return String(image).startsWith("data:") ? String(image) : `data:image/png;base64,${image}`;
  }

  function buildMessages(systemContent, prompt, extraMessages) {
    const early = extraMessages?.early || [];
    const late = extraMessages?.late || [];
    const systemText = (entries) => entries.filter((m) => m.role === "system").map((m) => m.content);
    const nonSystem = (entries) => entries.filter((m) => m.role !== "system");
    const lateText = systemText(late);
    const userText = [...lateText, prompt].join("\n\n");
    let images = extraMessages?.images || [];
    if (images.length && !state.mmproj) {
      console.warn(`llama-server has no mmproj loaded; answering without the ${images.length} attached image(s)`);
      images = [];
    }
    return [
      { role: "system", content: [systemContent, ...systemText(early)].join("\n\n") },
      ...nonSystem(early),
      ...nonSystem(late),
      {
        role: "user",
        content: images.length
          ? [{ type: "text", text: userText }, ...images.map((image) => ({ type: "image_url", image_url: { url: toImageDataUrl(image) } }))]
          : userText,
      },
    ];
  }

  // Issue #660: llama-server reports per request how many prompt tokens it
  // reused from its prompt cache (cache_n) vs. processed fresh (prompt_n),
  // so the cache hit rate between turns is visible in the log.
  //
  // #642: also kept as the latest prompt's real size for the context meter
  // -- cache_n + prompt_n is the whole prompt. A fresh object every time,
  // so a caller can tell "a completion ran since I last looked" by identity.
  function logPromptCache(label, timings) {
    if (!timings || typeof timings.prompt_n !== "number") return;
    const cacheN = Number(timings.cache_n) || 0;
    console.log(`${label}: prompt cache_n=${cacheN} prompt_n=${timings.prompt_n}`);
    state.lastPromptUsage = { promptTokens: cacheN + timings.prompt_n, promptN: timings.prompt_n, cacheN };
  }

  function getLastPromptUsage() {
    return state.lastPromptUsage;
  }

  // #642: exact token count of text with the loaded model's tokenizer.
  // Only asks a server this runtime already started or adopted -- never
  // starts one -- and returns null when there is none or it fails, so the
  // caller can fall back to an estimate.
  async function countTokens(text) {
    if (!state.port || typeof fetchImpl !== "function") return null;
    try {
      const resp = await fetchImpl(`http://127.0.0.1:${state.port}/tokenize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: String(text || "") }),
      });
      if (!resp || !resp.ok) return null;
      const json = await resp.json();
      return Array.isArray(json?.tokens) ? json.tokens.length : null;
    } catch (e) {
      return null;
    }
  }

  // #642: the running server's real per-slot context (/props n_ctx),
  // else the -c value buildServerArgs would pass. Never starts a server.
  function configuredContext() {
    if (state.gamingModel) return Number(env.MANA_GAMING_LLAMA_CONTEXT || 8192);
    return Number(env.LLAMA_CONTEXT || env.LLAMA_CONTEXT_CAP || "4096");
  }

  async function getContextSize() {
    const configured = configuredContext();
    if (!state.port || typeof fetchImpl !== "function") return configured;
    try {
      const resp = await fetchImpl(`http://127.0.0.1:${state.port}/props`);
      if (!resp || !resp.ok) return configured;
      const props = await resp.json();
      return Number(props?.default_generation_settings?.n_ctx) || configured;
    } catch (e) {
      return configured;
    }
  }

  // #675: a "think harder" request asks for its reply's max_tokens plus a
  // 1024-token thinking budget (512 on a tool round). Keeps prompt +
  // max_tokens inside the slot's context, so a long prompt shortens the
  // thinking first (then the reply) instead of generation running off the
  // end of the window mid-thought.
  // The prompt is measured as the JSON of what's sent (messages + tools),
  // which slightly overcounts -- the safe side.
  async function fitThinkingToContext(params, payload) {
    const budget = params.thinking_budget_tokens;
    if (!budget || !Number.isFinite(params.max_tokens)) return;
    // #679: an attached image's base64 would count as ~100k text tokens.
    // ponytail: images count as 0 here; a per-image estimate if image turns
    // with deep thinking start overflowing the context.
    const text = JSON.stringify(payload, (key, value) => (key === "image_url" ? undefined : value));
    const [contextSize, counted] = await Promise.all([getContextSize(), countTokens(text)]);
    const room = contextSize - (counted ?? Math.ceil(text.length / 3)) - 64;
    const over = params.max_tokens - room;
    if (over <= 0) return;
    params.max_tokens = Math.max(1, room);
    if (over >= budget) {
      delete params.thinking_budget_tokens;
      delete params.reasoning_budget_message;
      params.chat_template_kwargs = { enable_thinking: false };
    } else {
      params.thinking_budget_tokens = budget - over;
    }
  }

  async function runLocalAssistantReply(
    prompt,
    maxTokens = 256,
    profile = "default",
    overrideSystemPrompt = null,
    extraMessages = null,
    task = null,
    thinkingOverride = undefined,
  ) {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    const startedAt = nowMs();
    await ensureServer(profile, extraMessages?.images);

    // #675: per-profile/per-task sampler preset and thinking.
    const sampling = buildSamplingParams({ profile, task, maxTokens, thinking: thinkingOverride, env });
    const messages = buildMessages(overrideSystemPrompt || systemPromptOf(), prompt, extraMessages);
    if (thinkingOverride === true) await fitThinkingToContext(sampling.params, { messages });
    const resp = await fetchImpl(
      `http://127.0.0.1:${state.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, ...sampling.params }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `llama-server reply failed (${resp.status}): ${text.slice(0, 500)}`,
      );
    }
    const json = await resp.json();
    logPromptCache("llama-server", json && json.timings);
    // Reasoning models may wrap deliberation in <think> blocks; keep only
    // the reply (a reply that was all thinking counts as empty).
    const content = stripThinking(json?.choices?.[0]?.message?.content);
    if (!content) {
      // #675: thinking can use up the reply (reasoning, no content) -- one
      // retry with thinking off so the user still gets an answer.
      if (sampling.thinking) {
        console.warn("llama-server: empty reply with thinking on; retrying once with thinking off");
        return runLocalAssistantReply(prompt, maxTokens, profile, overrideSystemPrompt, extraMessages, task, false);
      }
      throw new Error("llama-server returned an empty reply");
    }

    scheduleIdleShutdown();
    logPerf("llama-server", startedAt);
    return content;
  }

  // Issue #331: the streaming counterpart of runLocalAssistantReply. Same
  // prompt construction and the same post-processing, but the reply is
  // consumed as it is generated so each finished sentence can go to TTS
  // while the model is still writing the next one.
  //
  // onSentence is called with each completed sentence, in order. The full
  // reply is still returned, so a caller that only wants the text can use
  // this exactly like the blocking version and ignore the callback.
  //
  // Two filters sit between the wire and the caller, and the order matters:
  // think-block suppression runs FIRST, so reasoning never reaches the
  // sentence chunker and therefore never reaches TTS. Doing it the other
  // way round would speak the model's deliberation aloud before the closing
  // tag arrived.
  async function streamLocalAssistantReply(
    prompt,
    {
      maxTokens = 256,
      profile = "default",
      overrideSystemPrompt = null,
      extraMessages = null,
      onSentence = null,
      maxSentenceChars,
      thinking,
    } = {},
  ) {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    const startedAt = nowMs();
    await ensureServer(profile, extraMessages?.images);

    const messages = buildMessages(overrideSystemPrompt || systemPromptOf(), prompt, extraMessages);
    const { params } = buildSamplingParams({ profile, task: "stream", maxTokens, thinking, env });
    if (thinking === true) await fitThinkingToContext(params, { messages });
    const resp = await fetchImpl(
      `http://127.0.0.1:${state.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, ...params, stream: true }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `llama-server stream failed (${resp.status}): ${text.slice(0, 500)}`,
      );
    }

    // Kept and logged once: only the final frame normally carries timings,
    // but a server run with timings_per_token sends them on every frame.
    let lastTimings = null;
    const full = await streamSentences(resp, {
      onSentence,
      maxSentenceChars,
      onTimings: (timings) => {
        lastTimings = timings;
      },
    });
    logPromptCache("llama-server-stream", lastTimings);

    if (!full.trim()) {
      throw new Error("llama-server returned an empty reply");
    }

    scheduleIdleShutdown();
    logPerf("llama-server-stream", startedAt);
    return full;
  }

  // Raw OpenAI-compatible passthrough (issue #95). Unlike runLocalAssistantReply,
  // this does not inject Mana's persona system prompt or post-process the
  // reply -- external clients (Obsidian Copilot, etc.) bring their own
  // messages/system prompt and expect a standard OpenAI response shape,
  // streaming or not. Returns the raw fetch Response so the HTTP layer can
  // relay status/JSON/SSE as-is without this runtime needing to understand
  // Express or SSE framing.
  async function proxyChatCompletion(body, profile = "default") {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    await ensureServer(profile);
    scheduleIdleShutdown();
    return fetchImpl(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // A real reply essentially never starts with a raw `{` -- this is the
  // exact leaked-JSON signature confirmed on qwen2.5-coder-7b (see
  // runToolAwareReply's repair call below). Cheap and precise enough: no
  // false-positive risk worth guarding against, and a false negative here
  // just means an unhandled turn falls through to the pre-existing
  // "no tool calls, that's the final answer" behavior.
  //
  // Second, distinct leak shape confirmed live against the same model
  // (coding-mode `coding__propose_edit` prompts, 9/9 real samples): instead
  // of leaking *only* JSON, it writes ordinary explanatory prose and then
  // embeds the intended call mid-response, e.g. "...let's propose this
  // edit:\n\n```json\n{\"name\": \"coding__propose_edit\", \"arguments\":
  // {...}}\n```". The prefix check above never sees this. The
  // "name"+"arguments" pair appearing together (in that order, as JSON
  // keys) is specific to the tool-call shape -- a plain code block's own
  // dict/object literals essentially never use exactly those two key names
  // back to back, so this is unlikely to false-positive on this model's
  // otherwise code-heavy replies.
  //
  // Checked after stripping emotion tags (#623): a tagged reply always starts
  // with "[" ("[happy] Welcome home"), and flagging it forced a repair round
  // whose schema had to return some tool call -- it invented skill__view
  // every turn in a live run.
  function looksLikeFailedToolCallJson(content) {
    const trimmed = stripEmotionTags(content).text;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return true;
    }
    return /"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/.test(trimmed);
  }

  // #675: reply text without reasoning: a closed <think> block, or an
  // unclosed one running to the end (thinking cut off by its budget).
  function stripThinking(content) {
    return String(content || "").replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim();
  }

  // #787: qwen2.5-coder never uses the <tool_call> tags its template asks
  // for, so llama-server's parser never sees a call -- measured live, 98 of
  // 102 goal-mode turns wrote it as a ```json block (or bare JSON) instead,
  // and fixing the template's doubled `{{"name"...}}` example didn't change
  // that. Read those text-form calls here, but only well-formed ones naming
  // an offered tool with its required arguments; anything else still goes
  // to repairToolCalls.
  function parseTextToolCalls(content, tools) {
    const params = new Map((tools || []).map((t) => [t.function.name, t.function.parameters || {}]));
    const text = String(content || "");
    const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```|<tool_call>([\s\S]*?)<\/tool_call>/g)].map(
      (m) => m[1] ?? m[2],
    );
    const calls = [];
    for (const raw of blocks.length ? blocks : [text]) {
      let parsed;
      try {
        parsed = JSON.parse(raw.trim());
      } catch (e) {
        continue;
      }
      for (const call of [].concat(parsed)) {
        const schema = call && params.get(call.name);
        const args = call && call.arguments;
        if (!schema || !args || typeof args !== "object" || Array.isArray(args)) continue;
        if (!(schema.required || []).every((key) => key in args)) continue;
        calls.push({
          id: `text_${Date.now()}_${calls.length}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(args) },
        });
      }
    }
    return calls;
  }

  // Builds a JSON Schema that forces a valid `{tool_calls: [{name, arguments}]}`
  // shape, one oneOf branch per available tool so `arguments` is validated
  // against that specific tool's own parameter schema. Confirmed directly
  // against this repo's own llama-server build before use: oneOf+const
  // discriminators across multiple tools compile to a working grammar and
  // the model reliably picks the right branch.
  function buildToolCallRepairSchema(tools) {
    return {
      type: "object",
      properties: {
        tool_calls: {
          type: "array",
          items: {
            oneOf: tools.map((t) => ({
              type: "object",
              properties: {
                name: { const: t.function.name },
                arguments: t.function.parameters || { type: "object" },
              },
              required: ["name", "arguments"],
            })),
          },
        },
      },
      required: ["tool_calls"],
    };
  }

  // One extra request, schema-constrained instead of relying on the
  // model's own template to populate `tool_calls` -- see the call site's
  // comment for why this exists and how it was confirmed to work. Returns
  // the same shape runToolAwareReply's main loop already expects
  // (OpenAI-style tool_calls entries with a JSON-*string* `arguments`
  // field, matching the `JSON.parse(call.function.arguments)` call
  // further down this loop).
  async function repairToolCalls(messages, tools, maxTokens, profile = "default") {
    if (!Array.isArray(tools) || !tools.length) {
      return [];
    }
    const schema = buildToolCallRepairSchema(tools);
    let resp;
    try {
      resp = await fetchImpl(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          response_format: { type: "json_schema", json_schema: { name: "tool_calls_repair", schema } },
          ...buildSamplingParams({ profile, task: "tools", maxTokens, env }).params,
        }),
      });
    } catch (e) {
      return []; // network/process hiccup -- fall through to the caller's existing no-tool-calls path
    }
    if (!resp.ok) {
      return [];
    }
    let parsed;
    try {
      const json = await resp.json();
      parsed = JSON.parse(json?.choices?.[0]?.message?.content || "");
    } catch (e) {
      return []; // schema-constrained generation still failed to parse -- give up, don't throw
    }
    const calls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
    return calls.map((call, index) => ({
      id: `repair_${Date.now()}_${index}`,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments || {}),
      },
    }));
  }

  // Issue #676: goal mode's nudge when the model answers without a tool.
  function goalRecheckMessage(goal, missing = []) {
    const stillMissing = missing.length ? `\nStill missing: ${missing.join("; ")}` : "";
    return {
      role: "user",
      content: `Goal: ${goal}${stillMissing}\nIf it's done, call ${SESSION_GOAL_FINISH_TOOL_NAME} with the reason; otherwise do the next step.`,
    };
  }

  // #787: what the run itself shows, for the review. Measured live, the
  // model-only review passed "fixed" with no edit made and with the tests
  // still failing. No edit on an edit goal is decided here; a failing test
  // run goes to the model review with its output instead, since a suite can
  // fail on something the goal doesn't cover. ponytail: "is this an edit
  // goal" is a verb regex -- a goal worded without one skips the no-edit
  // check and relies on the model review.
  const EDIT_GOAL_RE = /\b(fix|add|rename|change|update|implement|refactor|remove|delete|edit|replace|modify)\b/i;
  function goalEvidence(goal, calls, toolNames) {
    const lastIndex = (pred) => calls.reduce((found, c, i) => (pred(c) ? i : found), -1);
    const lastEdit = lastIndex((c) => c.name === CODING_EDIT_TOOL_NAME && c.status === "ok");
    const lastTest = lastIndex((c) => c.name === CODING_TEST_TOOL_NAME && typeof c.passed === "boolean");
    const gaps =
      lastEdit < 0 && toolNames.includes(CODING_EDIT_TOOL_NAME) && EDIT_GOAL_RE.test(goal)
        ? [`no edit was made yet (${CODING_EDIT_TOOL_NAME} never succeeded)`]
        : [];
    let tests = "";
    if (lastTest >= 0 && lastTest > lastEdit) {
      const output = (() => {
        try {
          return String(JSON.parse(calls[lastTest].result).output || "");
        } catch (e) {
          return "";
        }
      })();
      tests = `Latest test run, after the last edit: ${calls[lastTest].passed ? "passed" : "FAILED"}\n${output.slice(-1500)}`;
    } else if (toolNames.includes(CODING_TEST_TOOL_NAME)) {
      tests = "Tests: not run since the last edit.";
    }
    return { gaps, tests };
  }

  // Issue #676: one schema-constrained call (same shape as repairToolCalls)
  // asking whether the draft actually does what was asked. Returns
  // {complete, missing[]}, or null when the check itself fails -- a broken
  // review must never block or rewrite the answer. #787: an evidence gap
  // decides first; the model sees each call's actual result and the latest
  // test run, not just that the calls ran.
  async function reviewGoalCompletion({ prompt, goal, toolCalls, toolNames, draft, maxTokens, profile }) {
    const { gaps, tests } = goalEvidence(goal, toolCalls, toolNames);
    if (gaps.length) return { complete: false, missing: gaps, evidence: true };
    const calls = toolCalls
      .map(
        (c) =>
          `- ${c.name}(${JSON.stringify(c.args || {}).slice(0, 200)}) ${c.ok ? "ok" : `error: ${c.error}`}` +
          (c.result ? `\n  result: ${c.result.slice(0, 800)}` : ""),
      )
      .join("\n") || "(none)";
    try {
      await ensureServer(profile);
      const resp = await fetchImpl(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content: "You check whether a task was actually done as asked. Judge only from the tool calls, their results and the draft answer; a claim in the draft that no tool result backs is unverified. If the latest test run failed on something the goal covers, that part is not done. List each requested thing that is missing or unverified.",
            },
            {
              role: "user",
              content: `Request:\n${prompt}\n\nGoal:\n${goal}\n\nTool calls made:\n${calls}${tests ? `\n\n${tests}` : ""}\n\nDraft answer:\n${draft}`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "goal_review",
              schema: {
                type: "object",
                properties: {
                  complete: { type: "boolean" },
                  missing: { type: "array", items: { type: "string" } },
                },
                required: ["complete", "missing"],
              },
            },
          },
          ...buildSamplingParams({ profile, task: "tools", maxTokens, env }).params,
        }),
      });
      if (!resp.ok) return null;
      const json = await resp.json();
      const parsed = JSON.parse(json?.choices?.[0]?.message?.content || "");
      if (typeof parsed.complete !== "boolean") return null;
      const missing = (Array.isArray(parsed.missing) ? parsed.missing : [])
        .map((m) => String(m).trim())
        .filter(Boolean);
      return { complete: parsed.complete, missing };
    } catch (e) {
      return null;
    }
  }

  // Foundational tool-calling loop (issue #51). Single round only: the
  // model gets one chance to call tools, sees the results, and produces a
  // final reply -- deliberately not a multi-step agent loop yet. Every tool
  // call is executed through the caller-supplied toolPolicy (see
  // ai/tool-policy.js), never dispatched by name without going through it,
  // so the actual read/write/exec boundary lives in one place.
  //
  // Real-hardware finding behind this: Qwen3-4B (the "default" profile)
  // reliably emits proper OpenAI-format tool_calls via llama-server's
  // --jinja chat template (3/3 in testing). qwen2.5-coder-7b (the "coding"
  // profile) does not -- it wraps the same well-formed JSON in a markdown
  // code fence inside `content` instead of the <tool_call> XML tags its own
  // template asks for, so llama-server's parser never recognizes it as a
  // tool call. Tool-calling here is scoped to profiles that pass this check
  // (currently: default), not assumed to work everywhere.
  // Issue #183: bounded multi-round loop, not a fixed two-call sequence --
  // the model can call tools, see results, and call more tools across
  // several rounds (needed for #169's outbound MCP client tools to be
  // useful at all; a single-round loop can't let a remote tool's results
  // inform a second tool call). Every cap below exists because an LLM tool
  // loop is exactly the kind of thing that can run away: too many rounds,
  // too many calls in one round, too long wall-clock, or stuck repeatedly
  // calling the same broken tool. Whenever a cap is hit, one final
  // tools-disabled completion call forces the model to synthesize an
  // answer from whatever it already knows, rather than returning a blank
  // or synthetic fallback string.
  //
  // Issue #676: goal mode (options.goal set). A reply without tool calls no
  // longer ends the loop: the model is re-asked against the goal until it
  // calls session_goal__finish, stalls (two re-checks in a row answered
  // with neither a tool nor finish), leaves a call waiting on approval, or
  // hits a cap -- the round and time caps are longer here
  // (MANA_GOAL_MODE_MAX_ROUNDS / _MAX_MS), and the loop also stops before
  // the prompt outgrows 80% of the context. Then one
  // review call checks the draft against the request; anything missing
  // goes back in as the next re-check (at most 2 cycles, budget allowing),
  // else the answer opens with "Not done yet: ...".
  async function runToolAwareReply(
    prompt,
    toolPolicy,
    {
      maxTokens = 512,
      profile = "default",
      overrideSystemPrompt = null,
      maxRounds,
      maxToolCallsPerRound,
      maxMs,
      extraMessages = null,
      // #675: true on a "think harder" turn -- every round thinks. May be a
      // function, read each round: Mana's deep_thinking__set can switch it
      // mid-reply.
      thinking,
      goal = null,
      // #1124: (round, roundLimit) at the start of each round.
      onRound = null,
    } = {},
  ) {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    if (!toolPolicy || typeof toolPolicy.executeTool !== "function") {
      throw new Error(
        "runToolAwareReply requires a toolPolicy with executeTool()",
      );
    }
    const startedAt = nowMs();
    await ensureServer(profile, extraMessages?.images);

    const goalText = String(goal || "").trim();
    const goalMode = Boolean(goalText);
    const roundLimit = Math.max(
      1,
      Number(
        maxRounds ??
          (goalMode ? env.MANA_GOAL_MODE_MAX_ROUNDS ?? 30 : env.MANA_TOOL_CALLING_MAX_ROUNDS ?? 4),
      ),
    );
    const callsPerRoundLimit = Math.max(
      1,
      Number(maxToolCallsPerRound ?? env.MANA_TOOL_CALLING_MAX_CALLS_PER_ROUND ?? 5),
    );
    const timeLimitMs = Math.max(
      1,
      Number(
        maxMs ??
          (goalMode ? env.MANA_GOAL_MODE_MAX_MS ?? 600000 : env.MANA_TOOL_CALLING_MAX_MS ?? 60000),
      ),
    );
    // Issue #676: a 30-round loop can outgrow the context; stopping first
    // keeps the work instead of a llama-server error discarding it.
    const promptTokenLimit = goalMode ? Math.floor((await getContextSize()) * 0.8) : Infinity;
    const deadline = startedAt + timeLimitMs;
    const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

    const messages = buildMessages(
      overrideSystemPrompt || systemPromptOf(),
      prompt,
      extraMessages,
    );

    async function complete(toolsEnabled) {
      // Issue #417: a tool executed mid-loop (vision__look) can swap the
      // local server to a different model out from under this loop --
      // ensureServer() at the top of runToolAwareReply only confirms the
      // model once, before round 1. Re-ensuring here, on every round, is
      // the root-cause fix: whatever the last tool call left loaded, the
      // configured profile's model is back in place before the next
      // request goes out. On the common no-swap path this is just a cheap
      // isHealthy() check (ensureServerConfig's early-return), not a real
      // restart.
      await ensureServer(profile);
      // #675: never DRY/XTC here, and no thinking unless this is a "think
      // harder" turn -- both can break tool-call JSON. When it thinks,
      // llama-server returns the reasoning apart from content and
      // tool_calls (reasoning_content); the loop below never sends it back
      // or parses it, and strips any <think> block left inside content.
      const toolFields = toolsEnabled
        ? { tools: toolPolicy.tools, tool_choice: "auto" }
        : { tool_choice: "none" };
      const think = typeof thinking === "function" ? thinking() : thinking;
      const { params } = buildSamplingParams({ profile, task: "tools", maxTokens, thinking: think, env });
      if (think === true) await fitThinkingToContext(params, { messages, ...toolFields });
      const resp = await fetchImpl(
        `http://127.0.0.1:${state.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages, ...toolFields, ...params }),
        },
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `llama-server reply failed (${resp.status}): ${text.slice(0, 500)}`,
        );
      }
      const json = await resp.json();
      logPromptCache("llama-server-tool-reply", json && json.timings);
      return json;
    }

    const executedToolCalls = [];
    // #787: what each call returned, for the goal review only -- kept out of
    // executedToolCalls, which the caller persists with the turn.
    const reviewLog = [];
    let message = {};
    let rounds = 0;
    let consecutiveToolErrors = 0;
    // Issue #401: set when the model calls session_goal__finish, believing
    // the session's user-stated goal is done. Folded into the existing
    // budgetExhausted check below so a genuine finish reuses the same
    // "force a real final answer now" path the round/time/error caps
    // already use, instead of a second code path.
    let goalFinished = false;
    // Issue #676: goal-mode state, see the header comment.
    let unansweredRechecks = 0;
    let reviewCycles = 0;
    let stalled = false;
    let awaitingApproval = false;
    let promptTokens = 0;
    let notDone = "";
    const outOfBudget = () =>
      rounds >= roundLimit || nowMs() > deadline || promptTokens > promptTokenLimit;

    // #898: once per reply, a claim of a memory write that didn't happen
    // goes back to her with memoryClaimNote. Goal mode's own review
    // already checks claims against the tool calls.
    let memoryRechecked = false;
    function recheckMemoryClaim() {
      if (goalMode || memoryRechecked) return false;
      if (!toolPolicy.tools.some((t) => t.function?.name === MEMORY_REMEMBER_TOOL)) return false;
      const reply = stripThinking(message.content);
      const note = memoryClaimNote(reply, reviewLog);
      if (!note) return false;
      memoryRechecked = true;
      messages.push({ role: "assistant", content: reply }, { role: "user", content: note });
      return true;
    }

    // Issue #676: the end of a goal-mode run. True means the review found
    // something missing and there's budget for another cycle.
    async function reviewAndResume() {
      if (!goalMode) return false;
      const review = await reviewGoalCompletion({
        prompt,
        goal: goalText,
        toolCalls: reviewLog,
        toolNames: toolPolicy.tools.map((t) => t.function.name),
        draft: stripThinking(message.content),
        maxTokens,
        profile,
      });
      notDone = "";
      if (!review || review.complete) return false;
      if (
        // #787: a stall still gets its cycles when the gap is one the run
        // shows outright (no edit made) -- the generic re-checks never said so.
        (stalled && !review.evidence) ||
        awaitingApproval ||
        reviewCycles >= 2 ||
        consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS ||
        outOfBudget()
      ) {
        notDone = review.missing.join("; ") || "the goal isn't finished";
        return false;
      }
      reviewCycles += 1;
      goalFinished = false;
      stalled = false;
      unansweredRechecks = 0;
      messages.push(
        { role: "assistant", content: message.content || "" },
        goalRecheckMessage(goalText, review.missing),
      );
      return true;
    }

    for (let round = 1; round <= roundLimit; round += 1) {
      rounds = round;
      onRound?.(round, roundLimit);
      let json;
      try {
        json = await complete(true);
      } catch (e) {
        // #787: one round's tool results (file contents, test output) can
        // jump past the 80% guard below and the whole context. Keep the run's
        // work and say why it stopped, rather than failing the reply.
        if (!goalMode || !/exceeds the available context/i.test(e.message)) throw e;
        notDone = "the conversation outgrew the model's context";
        break;
      }
      promptTokens = (Number(json?.timings?.cache_n) || 0) + (Number(json?.timings?.prompt_n) || 0);
      message = (json && json.choices && json.choices[0] && json.choices[0].message) || {};
      const visibleContent = stripThinking(message.content);
      let requestedToolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];

      if (!requestedToolCalls.length) {
        requestedToolCalls = parseTextToolCalls(visibleContent, toolPolicy.tools);
      }
      if (!requestedToolCalls.length && looksLikeFailedToolCallJson(visibleContent)) {
        // Issue: this method's own header comment documents that some
        // model/template combos (qwen2.5-coder-7b confirmed) never
        // populate `tool_calls` at all -- they leak the call they meant to
        // make into `content` instead, sometimes malformed (verified
        // directly: a raw request against that exact model returned
        // `content: '{{"name": "get_weather", ...'` -- a literal double
        // brace, not valid JSON). Confirmed the fix empirically before
        // writing this: re-asking with response_format's json_schema
        // constraint reliably produces clean, schema-conforming JSON even
        // from this same broken model/template pair. Only fires when the
        // native path already failed -- the common/working case (e.g. the
        // default profile) never pays for the extra request.
        requestedToolCalls = await repairToolCalls(messages, toolPolicy.tools, maxTokens, profile);
      }

      if (!requestedToolCalls.length) {
        // Issue #676: in goal mode a plain reply isn't the end -- re-ask
        // against the goal, until two re-checks in a row go unanswered.
        if (goalMode && !outOfBudget()) {
          if (unansweredRechecks < 2) {
            unansweredRechecks += 1;
            messages.push({ role: "assistant", content: visibleContent }, goalRecheckMessage(goalText));
            continue;
          }
          stalled = true;
        }
        if (recheckMemoryClaim()) {
          // She can still call memory__remember; with no rounds left she
          // only gets to correct the reply.
          if (!outOfBudget()) continue;
          message = (await complete(false))?.choices?.[0]?.message || {};
        }
        if (await reviewAndResume()) continue;
        break; // model produced a real answer -- no more tools requested
      }
      unansweredRechecks = 0;

      const boundedCalls = requestedToolCalls.slice(0, callsPerRoundLimit);
      messages.push({
        role: "assistant",
        content: visibleContent || null,
        tool_calls: boundedCalls,
      });

      for (const call of boundedCalls) {
        const name = call.function && call.function.name;
        let args = {};
        try {
          args = call.function && call.function.arguments
            ? JSON.parse(call.function.arguments)
            : {};
        } catch (e) {
          // Malformed arguments from the model -- report back as a tool
          // error below instead of throwing and losing the whole reply.
        }

        let resultText;
        try {
          // Issue #169: await, not a bare call -- an MCP-sourced tool's
          // executeTool() is inherently async (network/child-process I/O),
          // unlike the local read_file tool this loop originally only ever
          // saw. Awaiting a plain (non-Promise) return value is a no-op, so
          // this stays exactly backward-compatible with tool-policy.js's
          // synchronous executeTool().
          const result = await toolPolicy.executeTool(name, args);
          resultText = String(result);
          executedToolCalls.push({ name, args, ok: true });
          let parsed = {};
          try {
            parsed = JSON.parse(resultText) || {};
          } catch (e) {}
          reviewLog.push({ name, args, ok: true, status: parsed.status, passed: parsed.passed, result: resultText });
          consecutiveToolErrors = 0;
          if (name === SESSION_GOAL_FINISH_TOOL_NAME) {
            goalFinished = true;
          }
          // Issue #676: a call waiting on a human (#669 approval queue) ends
          // goal mode -- retrying would only queue up more approvals.
          awaitingApproval ||= goalMode && ["pending", "blocked"].includes(parsed.status);
        } catch (e) {
          resultText = `Error: ${e.message}`;
          executedToolCalls.push({ name, args, ok: false, error: e.message });
          reviewLog.push({ name, args, ok: false, error: e.message });
          consecutiveToolErrors += 1;
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: resultText,
        });
      }

      const budgetExhausted =
        goalFinished ||
        awaitingApproval ||
        outOfBudget() ||
        consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS;
      if (budgetExhausted) {
        // Force a real answer from whatever's been learned so far instead
        // of looping again (or returning nothing) -- tool_choice: "none"
        // means the model cannot request yet another tool call here.
        const finalJson = await complete(false);
        message = (finalJson && finalJson.choices && finalJson.choices[0] && finalJson.choices[0].message) || {};
        if (recheckMemoryClaim()) message = (await complete(false))?.choices?.[0]?.message || {};
        if (await reviewAndResume()) continue;
        break;
      }
    }

    const draft = stripThinking(message.content);
    const content = notDone ? `Not done yet: ${notDone}${draft ? `\n\n${draft}` : ""}` : draft;

    scheduleIdleShutdown();
    logPerf("llama-server-tool-reply", startedAt);
    return { content, toolCalls: executedToolCalls, rounds };
  }

  // Best-of-N self-voting (issue #70): generate N candidates at varied
  // temperature, then a temp-0 judge call picks the best one. Sequential,
  // not parallel -- this llama-server instance runs with the default single
  // parallel slot (no --parallel flag), so concurrent requests would just
  // queue behind each other on this hardware anyway, not actually overlap.
  // See docs/roadmap/issue-70-best-of-n.md for the measured latency cost.
  async function runBestOfNReply(
    prompt,
    {
      n = 3,
      maxTokens = 512,
      profile = "coding",
      overrideSystemPrompt = null,
    } = {},
  ) {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    const startedAt = nowMs();
    await ensureServer(profile);

    async function completeChat(messages, temperature, tokenLimit) {
      const resp = await fetchImpl(
        `http://127.0.0.1:${state.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages,
            // #675: the profile's preset, with the ladder/judge temperature on top.
            ...buildSamplingParams({ profile, task: "bestofn", maxTokens: tokenLimit, env }).params,
            temperature,
          }),
        },
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `llama-server reply failed (${resp.status}): ${text.slice(0, 500)}`,
        );
      }
      const json = await resp.json();
      const content =
        json && json.choices && json.choices[0] && json.choices[0].message
          ? String(json.choices[0].message.content || "")
          : "";
      return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    }

    const baseMessages = [
      { role: "system", content: overrideSystemPrompt || systemPromptOf() },
      { role: "user", content: prompt },
    ];
    // Fixed ladder from a safe low-temperature baseline up to more varied
    // alternatives, rather than N identical low-temp calls that would just
    // reproduce the same candidate.
    const temperatures = Array.from({ length: n }, (_, i) =>
      n === 1
        ? 0.2
        : Math.round((0.2 + (0.8 * i) / (n - 1)) * 100) / 100,
    );

    const candidates = [];
    for (const temperature of temperatures) {
      const content = await completeChat(baseMessages, temperature, maxTokens);
      if (content) candidates.push(content);
    }
    if (!candidates.length) {
      throw new Error("llama-server returned no usable candidates");
    }

    let judgeIndex = 0;
    if (candidates.length > 1) {
      const judgeMessages = [
        {
          role: "system",
          content:
            "You are a terse code reviewer. Reply with only the number of the best candidate, nothing else.",
        },
        {
          role: "user",
          content:
            `You are judging ${candidates.length} candidate answers to the same coding question. ` +
            "Pick the single best one for correctness, edge-case handling, and efficiency.\n\n" +
            candidates
              .map((c, i) => `Candidate ${i + 1}:\n${c}`)
              .join("\n\n") +
            "\n\nBest candidate number:",
        },
      ];
      const judgeReply = await completeChat(judgeMessages, 0, 16);
      const parsed = parseInt((judgeReply.match(/\d+/) || [])[0], 10);
      // Falls back to candidate 1 (the lowest-temperature, safest one) if
      // the judge doesn't return a clean, in-range number.
      judgeIndex =
        Number.isInteger(parsed) && parsed >= 1 && parsed <= candidates.length
          ? parsed - 1
          : 0;
    }

    scheduleIdleShutdown();
    logPerf("llama-server-best-of-n", startedAt);
    return { content: candidates[judgeIndex], candidates, judgeIndex };
  }

  // Vision replies must go through llama-server (llama-cli has no equivalent
  // one-shot multimodal path here), so there is no CLI fallback: errors
  // propagate to the caller with a configuration hint.
  async function runVisionReply(
    prompt,
    images,
    maxTokens = 256,
    overrideSystemPrompt = null,
  ) {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    if (!isEnabled()) {
      throw new Error(
        "llama-server runtime is disabled; local vision replies are unavailable",
      );
    }
    const imageList = [].concat(images || []).filter(Boolean);
    if (!imageList.length) {
      throw new Error("runVisionReply requires at least one image");
    }

    const startedAt = nowMs();
    const model = findVisionModel();
    // #889: while gaming, a separate vision model can still describe the
    // image (the VRAM guard has the last word), but the normal chat model
    // plus its mmproj is exactly the load the gaming model is there to avoid.
    if (state.gamingModel && sameModelPath(model, findNormalLlamaModel())) {
      const error = new Error("Vision is paused while gaming");
      error.code = "VISION_PAUSED_GAMING";
      throw error;
    }
    const mmproj = findVisionMmproj(model);
    // #872: when the vision model is the chat model, chat turns now keep
    // the mmproj this loads (vision__look mid tool loop: one reload, not two).
    noteImageTurn();
    await ensureServerConfig(model, mmproj);

    const content = [
      {
        type: "text",
        text: String(prompt || "Describe what you see in this image."),
      },
    ];
    for (const image of imageList) {
      const url = String(image).startsWith("data:")
        ? String(image)
        : `data:image/png;base64,${image}`;
      content.push({ type: "image_url", image_url: { url } });
    }

    const resp = await fetchImpl(
      `http://127.0.0.1:${state.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: overrideSystemPrompt || systemPromptOf() },
            { role: "user", content },
          ],
          ...buildSamplingParams({ task: "vision", maxTokens, env }).params,
        }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `llama-server vision reply failed (${resp.status}): ${text.slice(0, 500)}`,
      );
    }
    const json = await resp.json();
    const replyContent =
      json && json.choices && json.choices[0] && json.choices[0].message
        ? String(json.choices[0].message.content || "")
        : "";
    if (!replyContent.trim()) {
      throw new Error("llama-server returned an empty vision reply");
    }

    scheduleIdleShutdown();
    logPerf("llama-vision", startedAt);
    return replyContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  }

  function getStatus() {
    return {
      enabled: isEnabled(),
      running: Boolean(state.port && state.model),
      external: Boolean(state.port && state.model && !state.child),
      model: state.model,
      mmproj: state.mmproj,
      // #889: the running model is the gaming model.
      gamingModel: Boolean(state.gamingModel && state.model === env.MANA_GAMING_LLAMA_MODEL),
      port: state.port,
      lastSwapMs: state.lastSwapMs,
      loading: state.loading,
    };
  }

  // Issue #431: lets a caller (memory-tool-source.js's LLM-confirmed
  // conflict judge) find out whether calling runLocalAssistantReply(...,
  // profile) would be truly free -- reuses the exact same resolution
  // ensureServerConfig itself uses, not just a name-membership guess, since
  // a profile's preferred file can differ from whatever happens to be
  // running right now even when the running model's name also appears
  // somewhere in that profile's list (a higher-preference file for that
  // profile might also exist on disk). A caller that skips this check and
  // guesses wrong risks a real model swap -- exactly the failure mode that
  // crashed system RAM earlier in this session's own #360 testing.
  function isProfileAlreadyLoaded(profile) {
    return Boolean(state.port && state.model && findLlamaModel(profile) === state.model);
  }

  // Issue #431: a small utility-classification call (same shape as
  // guardian-precheck.js's judgeActionRisk) that never triggers a load or a
  // swap -- returns null instead of running when no already-loaded profile
  // is safely reusable, rather than guessing and risking a swap. Callers
  // that don't care which profile actually served the call (a yes/no
  // classification, not a user-facing reply) can use this instead of
  // picking a profile themselves.
  async function runLocalReplyIfSafelyLoaded(prompt, maxTokens) {
    const safeProfile = getKnownLlamaModelProfiles().find((profile) =>
      isProfileAlreadyLoaded(profile),
    );
    if (!safeProfile) {
      return null;
    }
    return runLocalAssistantReply(prompt, maxTokens, safeProfile, null, null, "utility");
  }

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
    // ponytail: the proxy's streamed body outlives this call, so an unload
    // can still land mid-stream there; track the body if that ever bites.
    proxyChatCompletion,
    streamLocalAssistantReply: inTurn(streamLocalAssistantReply),
    runBestOfNReply: inTurn(runBestOfNReply),
    waitForServer: inTurn(waitForServer),
    runLocalAssistantReply: inTurn(runLocalAssistantReply),
    runToolAwareReply: inTurn(runToolAwareReply),
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
    unloadVision,
  };
}

module.exports = { createLlamaServerRuntime };
