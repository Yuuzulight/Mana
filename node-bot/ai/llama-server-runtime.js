const defaultFs = require("node:fs");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");
const {
  collectFilesRecursively,
  findPreferredLlamaModel,
} = require("./local-ai");
const {
  DEFAULT_SYSTEM_PROMPT,
  isLocalModelSpec,
} = require("./local-llama-runtime");

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
  const registerExitHandlers = options.registerExitHandlers !== false;
  const sleep =
    options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

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

  function findLlamaServerBin() {
    const candidates = [];
    if (env.LLAMA_SERVER_BIN) {
      candidates.push(env.LLAMA_SERVER_BIN);
    }
    if (env.LLAMA_BIN) {
      candidates.push(path.join(path.dirname(env.LLAMA_BIN), "llama-server.exe"));
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
    return findPreferredLlamaModel({
      explicitModel: env.LLAMA_MODEL || "",
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
    if (env.LLAMA_VISION_MODEL) {
      if (fs.existsSync(env.LLAMA_VISION_MODEL)) {
        return env.LLAMA_VISION_MODEL;
      }
      throw new Error(
        `LLAMA_VISION_MODEL is set but does not exist: ${env.LLAMA_VISION_MODEL}`,
      );
    }

    const ggufs = collectFilesRecursively(toolsDir, (fullPath) =>
      fullPath.toLowerCase().endsWith(".gguf"),
    );
    const candidates = ggufs.filter((fullPath) => {
      if (isMmprojFile(fullPath)) return false;
      return /(^|[-_.])(vl|vision|llava|minicpm-v|moondream|gemma-3)/i.test(
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
    if (env.LLAMA_VISION_MMPROJ) {
      if (fs.existsSync(env.LLAMA_VISION_MMPROJ)) {
        return env.LLAMA_VISION_MMPROJ;
      }
      throw new Error(
        `LLAMA_VISION_MMPROJ is set but does not exist: ${env.LLAMA_VISION_MMPROJ}`,
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

  function buildServerArgs(model, port, mmproj = null) {
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

    const ngl = env.LLAMA_NGL || "99";
    if (ngl) {
      args.push("-ngl", String(ngl));
    }
    const contextCap = env.LLAMA_CONTEXT || env.LLAMA_CONTEXT_CAP || "4096";
    if (contextCap) {
      args.push("-c", String(contextCap));
    }

    return args;
  }

  async function startServer(model, mmproj = null) {
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

    const args = buildServerArgs(model, port, mmproj);
    console.log("Starting llama-server:", bin, args.join(" "));
    const child = spawn(bin, args, {
      cwd: path.dirname(bin),
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

  async function ensureServerConfig(model, mmproj = null) {
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

    const swapStartedAt = nowMs();
    if (isRunning) {
      if (state.model && state.model !== model) {
        console.log(
          `llama-server: switching model ${state.model} -> ${model}`,
        );
      }
      await stopAndWait();
    }

    state.starting = startServer(model, mmproj);
    try {
      await state.starting;
      state.lastStartFailureAt = 0;
      state.loadedAt = nowMs();
      if (isRunning) {
        state.lastSwapMs = state.loadedAt - swapStartedAt;
        logPerf("llama-server-swap", swapStartedAt);
        console.log(`llama-server: swap completed in ${state.lastSwapMs}ms`);
      }
    } catch (e) {
      state.lastStartFailureAt = nowMs();
      throw e;
    } finally {
      state.starting = null;
    }
  }

  async function ensureServer(profile) {
    return ensureServerConfig(findLlamaModel(profile), null);
  }

  async function runLocalAssistantReply(
    prompt,
    maxTokens = 256,
    profile = "default",
    overrideSystemPrompt = null,
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
          messages: [
            { role: "system", content: overrideSystemPrompt || systemPrompt },
            { role: "user", content: prompt },
          ],
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
  async function runToolAwareReply(
    prompt,
    toolPolicy,
    { maxTokens = 512, profile = "default", overrideSystemPrompt = null } = {},
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

    const messages = [
      { role: "system", content: overrideSystemPrompt || systemPrompt },
      { role: "user", content: prompt },
    ];

    async function complete() {
      const resp = await fetchImpl(
        `http://127.0.0.1:${state.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages,
            tools: toolPolicy.tools,
            tool_choice: "auto",
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

    let json = await complete();
    let message = (json && json.choices && json.choices[0] && json.choices[0].message) || {};
    const requestedToolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    const executedToolCalls = [];

    if (requestedToolCalls.length) {
      messages.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: requestedToolCalls,
      });

      for (const call of requestedToolCalls) {
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
          const result = toolPolicy.executeTool(name, args);
          resultText = String(result);
          executedToolCalls.push({ name, args, ok: true });
        } catch (e) {
          resultText = `Error: ${e.message}`;
          executedToolCalls.push({ name, args, ok: false, error: e.message });
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: resultText,
        });
      }

      json = await complete();
      message = (json && json.choices && json.choices[0] && json.choices[0].message) || {};
    }

    const content = String(message.content || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .trim();

    scheduleIdleShutdown();
    logPerf("llama-server-tool-reply", startedAt);
    return { content, toolCalls: executedToolCalls };
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

  return {
    findLlamaServerBin,
    findLlamaModel,
    findVisionModel,
    findVisionMmproj,
    getVisionStatus,
    isEnabled,
    proxyChatCompletion,
    runBestOfNReply,
    runLocalAssistantReply,
    runToolAwareReply,
    runVisionReply,
    getStatus,
    scheduleIdleShutdown,
    stop,
    systemPrompt,
  };
}

module.exports = { createLlamaServerRuntime };
