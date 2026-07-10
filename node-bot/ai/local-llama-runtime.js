const defaultFs = require("node:fs");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");
const { DEFAULT_LLAMA_MODEL, findPreferredLlamaModel } = require("./local-ai");

const DEFAULT_SYSTEM_PROMPT =
  "You are Mana, a local AI assistant with an original anime little-sister personality. Your tone blends cool confidence with a soft, shy gentleness: calm, caring, lightly teasing, and protective. Use occasional playful little jabs, then help immediately. Keep the teasing affectionate, never cruel or genuinely insulting. Speak naturally for spoken conversation: short sentences, clean wording, minimal rambling, usually one or two short sentences unless the user needs more detail.";

function isLocalModelSpec(modelSpec, fs = defaultFs) {
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

function createLocalLlamaRuntime(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || defaultFs;
  const spawnSync = options.spawnSync || defaultSpawnSync;
  const baseDir = options.baseDir || path.resolve(__dirname, "..");
  const toolsDir =
    options.toolsDir || path.resolve(baseDir, "..", "tools", "llama");
  const threads = Number(options.threads || env.LLAMA_THREADS || 4);
  const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const nowMs =
    options.nowMs || (() => Number(process.hrtime.bigint() / 1000000n));
  const logPerf = options.logPerf || (() => {});

  function findLlamaBin() {
    const candidates = [];
    if (env.LLAMA_BIN) {
      candidates.push(env.LLAMA_BIN);
    }

    const bundledLlamaDir = path.join(
      toolsDir,
      "llama-b9436-bin-win-cuda-12.4-x64",
    );
    candidates.push(
      path.join(bundledLlamaDir, "llama-cli.exe"),
      path.join(bundledLlamaDir, "llama.exe"),
      path.join(bundledLlamaDir, "llama-completion.exe"),
      path.join(toolsDir, "llama-cli.exe"),
      path.join(toolsDir, "llama.exe"),
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

  function findLlamaModel(profile = "default") {
    return findPreferredLlamaModel({
      explicitModel: env.LLAMA_MODEL || "",
      searchDir: toolsDir,
      profile,
    });
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
        model: env.LLAMA_MODEL || DEFAULT_LLAMA_MODEL,
        message: error.message,
      };
    }
  }

  function runLocalAssistantReply(
    prompt,
    maxTokens = 256,
    profile = "default",
    overrideSystemPrompt = null,
  ) {
    const startedAt = nowMs();
    let llamaBin;
    try {
      llamaBin = findLlamaBin();
    } catch (error) {
      console.warn(`${error.message} Returning placeholder reply instead.`);
      logPerf("llama placeholder", startedAt);
      return "(no local llama binary found) I heard: " + prompt.slice(0, 200);
    }

    const llamaModel = findLlamaModel(profile);
    const sysPrompt = overrideSystemPrompt || systemPrompt;
    // Build base args
    const baseArgs = isLocalModelSpec(llamaModel, fs)
      ? [
          "-m",
          llamaModel,
          "-sys",
          sysPrompt,
          "-p",
          prompt,
          "-n",
          String(maxTokens),
          "-t",
          String(threads),
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
          sysPrompt,
          "-p",
          prompt,
          "-n",
          String(maxTokens),
          "-t",
          String(threads),
          "--single-turn",
          "--simple-io",
          "--no-display-prompt",
          "--no-show-timings",
          "--no-perf",
          "--no-warmup",
        ];

    // Hardware/runtime optimizations (configurable via environment)
    // Defaults: conservative (disabled) to maximize compatibility with various llama binaries.
    // Enable features explicitly by setting the corresponding env var to '1'.
    const enableFlashAttn = env.LLAMA_ENABLE_FLASHATTN === "1"; // require explicit opt-in
    const flashAttnValue = env.LLAMA_ARG_FLASH_ATTN || "auto"; // value to pass when flash-attn is enabled
    const kvCompress = env.LLAMA_KV_COMPRESS || ""; // set to empty string to disable (explicit opt-in)
    const contextCap = env.LLAMA_CONTEXT || env.LLAMA_CONTEXT_CAP || "4096";
    const ngl = env.LLAMA_NGL || "99"; // number for offloading layers (model-specific)

    // Smart context / KV-offload flags: opt-in only
    const enableSmartContext = env.LLAMA_ENABLE_SMART_CONTEXT === "1";
    const enableNoKvOffload = env.LLAMA_ENABLE_NO_KV_OFFLOAD === "1";

    const extraArgs = [];
    if (enableFlashAttn) {
      // pass a value (some llama binaries expect 'on|off|auto')
      extraArgs.push("--flash-attn", flashAttnValue);
    }
    if (kvCompress) {
      // Both key and value compress flags if supported by the binary
      extraArgs.push("-ctk", kvCompress);
      extraArgs.push("-ctv", kvCompress);
    }

    // Smart context / no-kv-offload are only added when explicitly enabled
    if (enableSmartContext) {
      extraArgs.push("--smart-context");
    }
    if (enableNoKvOffload) {
      extraArgs.push("--no-kv-offload");
    }

    if (ngl) {
      extraArgs.push("-ngl", String(ngl));
    }
    if (contextCap) {
      extraArgs.push("-c", String(contextCap));
    }

    const args = baseArgs.concat(extraArgs);

    console.log("Running llama:", llamaBin, args.join(" "));
    const result = spawnSync(llamaBin, args, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      cwd: path.dirname(llamaBin),
    });
    if (result.error) throw result.error;
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
    // Cleanup known startup banner lines that llama.cpp may print before the actual reply
    function cleanLlamaOutput(text) {
      if (!text) return text;
      try {
        let s = String(text);
        // Remove Unicode replacement chars and long boxes sequences
        s = s.replace(/\uFFFD+/g, "");
        // Remove lines that are mostly non-alphanumeric (ASCII art)
        s = s
          .split(/\r?\n/)
          .filter((ln) => {
            const trimmed = ln.trim();
            if (!trimmed) return false;
            // drop lines that are mostly punctuation/box characters
            const alphaNumCount = (trimmed.match(/[A-Za-z0-9]/g) || []).length;
            if (alphaNumCount / Math.max(1, trimmed.length) < 0.15)
              return false;
            // drop lines that look like banner metadata
            if (/^build\s*:/i.test(trimmed)) return false;
            if (/^model\s*:/i.test(trimmed)) return false;
            if (/^modalities\s*:/i.test(trimmed)) return false;
            if (/using custom system prompt/i.test(trimmed)) return false;
            if (/^available commands\s*:/i.test(trimmed)) return false;
            if (/^\/\w+/.test(trimmed)) return false; // command lines like /exit /regen
            return true;
          })
          .join("\n");

        // Also try to remove any leading chunk until a blank line after known headings
        const re =
          /[\s\S]*?(?:available commands:|loading model)[\s\S]*?\n\s*\n/im;
        s = s.replace(re, "");

        return s.trim();
      } catch (e) {
        return String(text).trim();
      }
    }

    return cleanLlamaOutput(String(result.stdout || ""));
  }

  return {
    findLlamaBin,
    findLlamaModel,
    getLlamaStatus,
    runLocalAssistantReply,
    systemPrompt,
  };
}

module.exports = {
  DEFAULT_SYSTEM_PROMPT,
  createLocalLlamaRuntime,
  isLocalModelSpec,
  // export cleaner for other modules
  cleanLlamaOutput: (text) => {
    try {
      // reuse a runtime instance's cleaner by creating a dummy runtime to access function
      // but cleaner is local to run; replicate logic here minimally
      if (!text) return text;
      let s = String(text);
      s = s.replace(/\uFFFD+/g, "");
      s = s
        .split(/\r?\n/)
        .filter((ln) => {
          const trimmed = ln.trim();
          if (!trimmed) return false;
          const alphaNumCount = (trimmed.match(/[A-Za-z0-9]/g) || []).length;
          if (alphaNumCount / Math.max(1, trimmed.length) < 0.15) return false;
          if (/^build\s*:/i.test(trimmed)) return false;
          if (/^model\s*:/i.test(trimmed)) return false;
          if (/^modalities\s*:/i.test(trimmed)) return false;
          if (/using custom system prompt/i.test(trimmed)) return false;
          if (/^available commands\s*:/i.test(trimmed)) return false;
          if (/^\/\w+/.test(trimmed)) return false;
          return true;
        })
        .join("\n");
      const re =
        /[\s\S]*?(?:available commands:|loading model)[\s\S]*?\n\s*\n/im;
      s = s.replace(re, "");
      return s.trim();
    } catch (e) {
      return String(text).trim();
    }
  },
};
