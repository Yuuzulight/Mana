const defaultFs = require("node:fs");
const { streamSentences } = require("../utils/sse-sentence-stream");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const { setTimeout: defaultSleep } = require("node:timers/promises");
const {
  collectFilesRecursively,
  findPreferredLlamaModel,
  getKnownLlamaModelProfiles,
} = require("./local-ai");
const {
  DEFAULT_SYSTEM_PROMPT,
  isLocalModelSpec,
} = require("./local-llama-runtime");
const { SESSION_GOAL_FINISH_TOOL_NAME } = require("./session-goal-tool-source");
const { detectGpuVramUsageMb } = require("../model-management");

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
  const fetchImpl = options.fetch || globalThis.fetch;
  const baseDir = options.baseDir || path.resolve(__dirname, "..");
  const toolsDir =
    options.toolsDir || path.resolve(baseDir, "..", "tools", "llama");
  const threads = Number(options.threads || env.LLAMA_THREADS || 4);
  const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const nowMs = options.nowMs || (() => Date.now());
  const logPerf = options.logPerf || (() => {});
  const modelSettingsStore = options.modelSettingsStore || null;
  const registerExitHandlers = options.registerExitHandlers !== false;
  const sleep = options.sleep || defaultSleep;

  const state = {
    child: null,
    model: null,
    mmproj: null,
    port: null,
    starting: null,
    idleTimer: null,
    exitHandlerRegistered: false,
    lastStartFailureAt: 0,
    loadedAt: null,
    lastSwapMs: null,
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
  // to approximate what stopAndWait() is about to release.
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

  function findLlamaModel(profile = "default") {
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

    // Prefer an mmproj that shares the model's family token (e.g. "qwen2.5-vl").
    const modelName = path.basename(modelPath).toLowerCase();
    const familyToken = (modelName.match(/^[a-z0-9.]+(-vl)?/i) || [""])[0];
    const match = mmprojFiles.find(
      (fullPath) =>
        familyToken &&
        path.basename(fullPath).toLowerCase().includes(familyToken),
    );
    return match || mmprojFiles[0];
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
      try {
        child.kill();
      } catch (e) {}
    }
    return child;
  }

  async function stopAndWait() {
    const child = stop();
    if (!child || child.exitCode !== null) {
      return;
    }
    // Wait for the old process to release the port before restarting.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      if (typeof timer.unref === "function") timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
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
      console.log(`llama-server idle for ${idleMs}ms, shutting it down`);
      stop();
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
  // (11.4s -> 4.1s) and ~32% faster on the larger 4B->7B swap direction,
  // with no regression the other way -- on by default. Set
  // MANA_LLAMA_UNIFIED_MEMORY=0 to opt out.
  function buildServerEnv() {
    if (env.MANA_LLAMA_UNIFIED_MEMORY === "0") {
      return env;
    }
    return { ...env, GGML_CUDA_ENABLE_UNIFIED_MEMORY: "1" };
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

  function buildServerArgs(model, port, mmproj = null, profile = null) {
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
    if (env.LLAMA_MLOCK === "1") {
      args.push("--mlock");
    }

    // Same opt-in hardware flags as the llama-cli path.
    if (env.LLAMA_ENABLE_FLASHATTN === "1") {
      args.push("--flash-attn", env.LLAMA_ARG_FLASH_ATTN || "auto");
    }
    if (env.LLAMA_KV_COMPRESS) {
      args.push("-ctk", env.LLAMA_KV_COMPRESS);
      args.push("-ctv", env.LLAMA_KV_COMPRESS);
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
    const contextCap = Number(env.LLAMA_CONTEXT || env.LLAMA_CONTEXT_CAP || "4096");

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
    const bin = findLlamaServerBin();
    const port = serverPort();

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

    const args = buildServerArgs(model, port, mmproj, profile);
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

  // profile only affects which flags a *new* start gets (see PROFILE_TUNING
  // above) -- if the same model+mmproj is already running and healthy, that
  // process keeps whatever flags it started with, even if called again
  // under a different profile label. This only matters when two profiles'
  // fallback lists resolve to the same actual file (rare; today's coding
  // profile's own primary model is distinct from the others'), and forcing
  // a restart on a profile-label-only change would undo the "don't restart
  // for no reason" debounce/adoption logic below for a cosmetic difference.
  async function ensureServerConfig(model, mmproj = null, profile = null) {
    // After a failed start (missing binary, port conflict, out of memory),
    // don't re-pay the startup wait on every reply; let the llama-cli
    // fallback serve until the cooldown expires.
    const retryCooldownMs = Number(
      env.LLAMA_SERVER_RETRY_COOLDOWN_MS || 300000,
    );
    if (
      state.lastStartFailureAt &&
      nowMs() - state.lastStartFailureAt < retryCooldownMs
    ) {
      throw new Error(
        "llama-server recently failed to start; retry cooldown active",
      );
    }

    if (state.starting) {
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

    const isRunning = Boolean(state.child || state.port);
    if (
      isRunning &&
      state.model &&
      state.model !== model &&
      swapDebounceMs > 0 &&
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

    const swapStartedAt = nowMs();
    if (isRunning) {
      if (state.model && state.model !== model) {
        console.log(
          `llama-server: switching model ${state.model} -> ${model}`,
        );
      }
      await stopAndWait();
    }

    state.starting = startServer(model, mmproj, profile);
    try {
      await state.starting;
      state.lastStartFailureAt = 0;
      state.loadedAt = nowMs();
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
      state.lastStartFailureAt = nowMs();
      throw e;
    } finally {
      state.starting = null;
    }
  }

  async function ensureServer(profile) {
    return ensureServerConfig(findLlamaModel(profile), null, profile);
  }

  // Issue #282: splices caller-supplied memory entries into the message
  // array at either end -- "early" right after the persona system message,
  // "late" right before the live user message (the higher-salience
  // position, closest to what's actually being asked). Omitting
  // extraMessages entirely preserves today's exact 2-message shape.
  function buildMessages(systemContent, prompt, extraMessages) {
    const early = extraMessages?.early || [];
    const late = extraMessages?.late || [];
    return [
      { role: "system", content: systemContent },
      ...early,
      ...late,
      { role: "user", content: prompt },
    ];
  }

  async function runLocalAssistantReply(
    prompt,
    maxTokens = 256,
    profile = "default",
    overrideSystemPrompt = null,
    extraMessages = null,
  ) {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    const startedAt = nowMs();
    await ensureServer(profile);

    const resp = await fetchImpl(
      `http://127.0.0.1:${state.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: buildMessages(
            overrideSystemPrompt || systemPrompt,
            prompt,
            extraMessages,
          ),
          max_tokens: maxTokens,
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
    if (!content.trim()) {
      throw new Error("llama-server returned an empty reply");
    }

    scheduleIdleShutdown();
    logPerf("llama-server", startedAt);
    // Reasoning models may wrap deliberation in <think> blocks; keep only the reply.
    return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
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
    } = {},
  ) {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available; cannot use llama-server");
    }
    const startedAt = nowMs();
    await ensureServer(profile);

    const resp = await fetchImpl(
      `http://127.0.0.1:${state.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: buildMessages(
            overrideSystemPrompt || systemPrompt,
            prompt,
            extraMessages,
          ),
          max_tokens: maxTokens,
          stream: true,
        }),
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `llama-server stream failed (${resp.status}): ${text.slice(0, 500)}`,
      );
    }

    const full = await streamSentences(resp, { onSentence, maxSentenceChars });

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
    await ensureServer(profile);

    const roundLimit = Math.max(
      1,
      Number(maxRounds ?? env.MANA_TOOL_CALLING_MAX_ROUNDS ?? 4),
    );
    const callsPerRoundLimit = Math.max(
      1,
      Number(maxToolCallsPerRound ?? env.MANA_TOOL_CALLING_MAX_CALLS_PER_ROUND ?? 5),
    );
    const timeLimitMs = Math.max(
      1,
      Number(maxMs ?? env.MANA_TOOL_CALLING_MAX_MS ?? 60000),
    );
    const deadline = startedAt + timeLimitMs;
    const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

    const messages = buildMessages(
      overrideSystemPrompt || systemPrompt,
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
      const resp = await fetchImpl(
        `http://127.0.0.1:${state.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages,
            ...(toolsEnabled
              ? { tools: toolPolicy.tools, tool_choice: "auto" }
              : { tool_choice: "none" }),
            max_tokens: maxTokens,
          }),
        },
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `llama-server reply failed (${resp.status}): ${text.slice(0, 500)}`,
        );
      }
      return resp.json();
    }

    const executedToolCalls = [];
    let message = {};
    let rounds = 0;
    let consecutiveToolErrors = 0;
    // Issue #401: set when the model calls session_goal__finish, believing
    // the session's user-stated goal is done. Folded into the existing
    // budgetExhausted check below so a genuine finish reuses the same
    // "force a real final answer now" path the round/time/error caps
    // already use, instead of a second code path.
    let goalFinished = false;

    for (let round = 1; round <= roundLimit; round += 1) {
      rounds = round;
      const json = await complete(true);
      message = (json && json.choices && json.choices[0] && json.choices[0].message) || {};
      const requestedToolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];

      if (!requestedToolCalls.length) {
        break; // model produced a real answer -- no more tools requested
      }

      const boundedCalls = requestedToolCalls.slice(0, callsPerRoundLimit);
      messages.push({
        role: "assistant",
        content: message.content || null,
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
          consecutiveToolErrors = 0;
          if (name === SESSION_GOAL_FINISH_TOOL_NAME) {
            goalFinished = true;
          }
        } catch (e) {
          resultText = `Error: ${e.message}`;
          executedToolCalls.push({ name, args, ok: false, error: e.message });
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
        round >= roundLimit ||
        nowMs() > deadline ||
        consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS;
      if (budgetExhausted) {
        // Force a real answer from whatever's been learned so far instead
        // of looping again (or returning nothing) -- tool_choice: "none"
        // means the model cannot request yet another tool call here.
        const finalJson = await complete(false);
        message = (finalJson && finalJson.choices && finalJson.choices[0] && finalJson.choices[0].message) || {};
        break;
      }
    }

    const content = String(message.content || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .trim();

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
            max_tokens: tokenLimit,
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
      { role: "system", content: overrideSystemPrompt || systemPrompt },
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
    const mmproj = findVisionMmproj(model);
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
            { role: "system", content: overrideSystemPrompt || systemPrompt },
            { role: "user", content },
          ],
          max_tokens: maxTokens,
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
      port: state.port,
      lastSwapMs: state.lastSwapMs,
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
    return runLocalAssistantReply(prompt, maxTokens, safeProfile);
  }

  return {
    buildServerArgs,
    ensureServerConfig,
    findLlamaServerBin,
    findLlamaModel,
    findVisionModel,
    findVisionMmproj,
    getVisionStatus,
    isEnabled,
    proxyChatCompletion,
    streamLocalAssistantReply,
    runBestOfNReply,
    runLocalAssistantReply,
    runToolAwareReply,
    runVisionReply,
    getStatus,
    isProfileAlreadyLoaded,
    runLocalReplyIfSafelyLoaded,
    scheduleIdleShutdown,
    stop,
    systemPrompt,
  };
}

module.exports = { createLlamaServerRuntime };
