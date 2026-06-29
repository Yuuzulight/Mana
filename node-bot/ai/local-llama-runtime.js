const defaultFs = require("node:fs");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");
const {
  DEFAULT_LLAMA_MODEL,
  findPreferredLlamaModel,
} = require("./local-ai");

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
  const toolsDir = options.toolsDir || path.resolve(baseDir, "..", "tools", "llama");
  const threads = Number(options.threads || env.LLAMA_THREADS || 4);
  const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const nowMs = options.nowMs || (() => Number(process.hrtime.bigint() / 1000000n));
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

  function runLocalAssistantReply(prompt, maxTokens = 256, profile = "default") {
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
    const args = isLocalModelSpec(llamaModel, fs)
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
          systemPrompt,
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
    return String(result.stdout || "").trim();
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
};
