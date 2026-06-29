const defaultFs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { spawnSync: defaultSpawnSync } = require("node:child_process");

const DEFAULT_KOKORO_LANGUAGE_PROFILES = {
  english: { lang: "en-us", speed: 1.12 },
  chinese: { lang: "cmn", speed: 1.08 },
  japanese: { lang: "ja", speed: 1.12 },
  korean: { lang: "ko", speed: 1.08 },
  russian: { lang: "ru", speed: 1.08 },
  german: { lang: "de", speed: 1.08 },
  spanish: { lang: "es", speed: 1.1 },
  malay: { lang: "ms", speed: 1.1 },
};

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

function createTtsRuntime(options = {}) {
  const env = options.env || process.env;
  const fs = options.fs || defaultFs;
  const spawnSync = options.spawnSync || defaultSpawnSync;
  const baseDir = options.baseDir || __dirname;
  const tmpDir = options.tmpDir || path.join(baseDir, "tmp");
  const nowMs = options.nowMs || (() => Number(process.hrtime.bigint() / 1000000n));
  const logPerf = options.logPerf || (() => {});
  const postJson = options.postJsonBuffer || postJsonBuffer;
  const postFish =
    options.postFishTtsBuffer || ((text) => postFishTtsBuffer(text));

  const ttsBin = env.TTS_BIN || null;
  const ttsModel = env.TTS_MODEL || null;
  const ttsArgsJson = env.TTS_ARGS_JSON || null;
  const ttsVoice = env.TTS_VOICE || null;
  const ttsSpeaker = env.TTS_SPEAKER || null;
  const chatterboxTtsUrl = env.CHATTERBOX_TTS_URL || "http://127.0.0.1:5010";
  const kokoroTtsUrl = env.KOKORO_TTS_URL || "http://127.0.0.1:5011";
  const fishTtsUrl = env.FISH_TTS_URL || "http://127.0.0.1:8080";
  const fishTtsApiKey = env.FISH_TTS_API_KEY || null;
  const fishTtsReferenceId = env.FISH_TTS_REFERENCE_ID || null;
  const fishTtsFormat = env.FISH_TTS_FORMAT || "wav";
  const fishTtsLatency = env.FISH_TTS_LATENCY || "normal";
  const fishTtsMaxNewTokens = Number(env.FISH_TTS_MAX_NEW_TOKENS || 1024);
  const fishTtsChunkLength = Number(env.FISH_TTS_CHUNK_LENGTH || 300);
  const fishTtsTopP = Number(env.FISH_TTS_TOP_P || 0.8);
  const fishTtsRepetitionPenalty = Number(
    env.FISH_TTS_REPETITION_PENALTY || 1.1,
  );
  const fishTtsTemperature = Number(env.FISH_TTS_TEMPERATURE || 0.8);
  const fishTtsFallbackProvider = env.FISH_TTS_FALLBACK_PROVIDER || "kokoro";
  const kokoroTtsFallbackProvider = env.KOKORO_TTS_FALLBACK_PROVIDER || "none";
  const ttsProvider = env.TTS_PROVIDER || (ttsBin ? "cli" : "chatterbox");
  const kokoroManaVoice = env.KOKORO_MANA_VOICE || "jf_nezumi";
  const kokoroLanguageProfiles =
    options.kokoroLanguageProfiles || DEFAULT_KOKORO_LANGUAGE_PROFILES;

  function makeTmpPath(prefix, ext) {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return path.join(tmpDir, `${prefix}-${unique}.${ext}`);
  }

  function parseTtsArgsTemplate() {
    if (!ttsArgsJson) {
      return ["-m", "{model}", "-p", "{text}", "-o", "{output}"];
    }

    let parsed;
    try {
      parsed = JSON.parse(ttsArgsJson);
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
    if (!ttsBin) {
      throw new Error("TTS_BIN not configured");
    }

    const template = parseTtsArgsTemplate();
    const values = {
      "{text}": text,
      "{output}": outputPath,
      "{model}": ttsModel || "",
      "{voice}": ttsVoice || "",
      "{speaker}": ttsSpeaker || "",
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
    console.log("Running TTS:", ttsBin, args.join(" "));

    const result = spawnSync(ttsBin, args, {
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

  function buildFishTtsRequest(text) {
    const request = {
      text,
      format: fishTtsFormat,
      latency: fishTtsLatency,
      max_new_tokens: fishTtsMaxNewTokens,
      chunk_length: fishTtsChunkLength,
      top_p: fishTtsTopP,
      repetition_penalty: fishTtsRepetitionPenalty,
      temperature: fishTtsTemperature,
    };

    if (fishTtsReferenceId) {
      request.reference_id = fishTtsReferenceId;
    }

    return request;
  }

  function postFishTtsBuffer(text) {
    return new Promise((resolve, reject) => {
      const url = new URL("/v1/tts", fishTtsUrl);
      const transport = url.protocol === "https:" ? https : http;
      const payload = Buffer.from(
        JSON.stringify(buildFishTtsRequest(text)),
        "utf8",
      );
      const headers = {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
      };

      if (fishTtsApiKey) {
        headers.Authorization = `Bearer ${fishTtsApiKey}`;
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
            if (
              res.statusCode &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
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

  function pickKokoroLanguageProfile(text) {
    const language = detectTtsLanguage(text);
    return {
      voice: kokoroManaVoice,
      ...(kokoroLanguageProfiles[language] || kokoroLanguageProfiles.english),
    };
  }

  async function synthesizeWithConfiguredProvider(provider, text) {
    if (provider === "fish") {
      const startedAt = nowMs();
      const audio = await postFish(text);
      logPerf("tts fish", startedAt);
      return audio;
    }

    if (provider === "kokoro") {
      const startedAt = nowMs();
      const kokoroProfile = pickKokoroLanguageProfile(text);
      const audio = await postJson(`${kokoroTtsUrl}/synthesize`, {
        text,
        ...kokoroProfile,
      });
      logPerf("tts kokoro", startedAt);
      return audio;
    }

    if (provider === "chatterbox") {
      const startedAt = nowMs();
      const audio = await postJson(`${chatterboxTtsUrl}/synthesize`, {
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

    if (ttsProvider === "fish") {
      try {
        return await synthesizeWithConfiguredProvider("fish", text);
      } catch (error) {
        if (fishTtsFallbackProvider === "none") {
          throw error;
        }

        console.warn(
          `Fish Speech TTS failed, falling back to ${fishTtsFallbackProvider}: ${error.message}`,
        );
        return await synthesizeWithConfiguredProvider(
          fishTtsFallbackProvider,
          text,
        );
      }
    }

    if (ttsProvider === "kokoro") {
      try {
        return await synthesizeWithConfiguredProvider("kokoro", text);
      } catch (error) {
        if (kokoroTtsFallbackProvider === "none") {
          throw error;
        }

        console.warn(
          `Kokoro TTS failed, falling back to ${kokoroTtsFallbackProvider}: ${error.message}`,
        );
        return await synthesizeWithConfiguredProvider(
          kokoroTtsFallbackProvider,
          text,
        );
      }
    }

    if (ttsProvider === "chatterbox") {
      return await synthesizeWithConfiguredProvider("chatterbox", text);
    }

    if (ttsProvider === "cli") {
      return await synthesizeWithConfiguredProvider("cli", text);
    }

    throw new Error("TTS not configured");
  }

  return {
    buildFishTtsRequest,
    buildTtsArgs,
    detectTtsLanguage,
    pickKokoroLanguageProfile,
    runTts,
    synthesizeReply,
    synthesizeWithConfiguredProvider,
    ttsProvider,
    urls: {
      chatterboxTtsUrl,
      fishTtsUrl,
      kokoroTtsUrl,
    },
  };
}

module.exports = {
  DEFAULT_KOKORO_LANGUAGE_PROFILES,
  createTtsRuntime,
  detectTtsLanguage,
  postJsonBuffer,
};
