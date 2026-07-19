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

// GPT-SoVITS's cross-lingual synthesis (same reference voice, different
// target-text language) only covers these languages regardless of version;
// see GPT_SoVITS/text/cleaner.py's language_module_map. Anything else
// detected in the reply text routes to the fallback provider instead of
// wasting a request GPT-SoVITS cannot serve (it would otherwise error or,
// on older releases, silently return empty audio for an unknown code).
const GPT_SOVITS_LANGUAGE_MAP = {
  english: "en",
  japanese: "ja",
  chinese: "zh",
  korean: "ko",
};

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
  const nowMs =
    options.nowMs || (() => Number(process.hrtime.bigint() / 1000000n));
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
  // S1-mini can slow to a crawl (not fail outright) when the GPU is under
  // contention (e.g. a game holding VRAM) -- without a timeout, a slow
  // response never trips the fallback-to-Kokoro logic below, it just hangs.
  const fishTtsTimeoutMs = Number(env.FISH_TTS_TIMEOUT_MS || 20000);
  const fishTtsApiKey = env.FISH_TTS_API_KEY || null;
  const fishTtsReferenceId = env.FISH_TTS_REFERENCE_ID || null;
  // Zero-shot in-context voice cloning: pass a reference clip's raw audio
  // (base64-encoded) and its exact transcript with every request, per
  // fish_speech's ServeReferenceAudio schema. Takes priority over
  // FISH_TTS_REFERENCE_ID (a server-side pre-registered voice) when set.
  const fishTtsRefAudio = env.FISH_TTS_REF_AUDIO || "";
  const fishTtsRefText = env.FISH_TTS_REF_TEXT || "";
  const fishTtsFormat = env.FISH_TTS_FORMAT || "wav";
  const fishTtsLatency = env.FISH_TTS_LATENCY || "normal";
  const fishTtsMaxNewTokens = Number(env.FISH_TTS_MAX_NEW_TOKENS || 1024);
  const fishTtsChunkLength = Number(env.FISH_TTS_CHUNK_LENGTH || 300);
  const fishTtsTopP = Number(env.FISH_TTS_TOP_P || 0.8);
  const fishTtsRepetitionPenalty = Number(
    env.FISH_TTS_REPETITION_PENALTY || 1.1,
  );
  const fishTtsTemperature = Number(env.FISH_TTS_TEMPERATURE || 0.8);
  // Fish/S1-mini is the default voice; Kokoro is its safety net so Mana
  // never goes silent if S1-mini is unreachable or errors.
  const fishTtsFallbackProvider = env.FISH_TTS_FALLBACK_PROVIDER || "kokoro";
  const kokoroTtsFallbackProvider = env.KOKORO_TTS_FALLBACK_PROVIDER || "none";
  // Voice cloning on the GPU can fail when a game holds VRAM; keep Kokoro as
  // the voice-of-last-resort so Mana never goes silent.
  const chatterboxTtsFallbackProvider =
    env.CHATTERBOX_TTS_FALLBACK_PROVIDER || "kokoro";
  // Trial voice provider: GPT-SoVITS (see docs/gpt_sovits_setup.md). Not the
  // default; opt in with TTS_PROVIDER=gpt_sovits.
  const gptSovitsTtsUrl = env.GPT_SOVITS_TTS_URL || "http://127.0.0.1:9880";
  const gptSovitsRefAudio = env.GPT_SOVITS_REF_AUDIO || "";
  const gptSovitsPromptText = env.GPT_SOVITS_PROMPT_TEXT || "";
  const gptSovitsPromptLang = env.GPT_SOVITS_PROMPT_LANG || "en";
  const gptSovitsFallbackProvider =
    env.GPT_SOVITS_TTS_FALLBACK_PROVIDER || "kokoro";
  const ttsProvider = env.TTS_PROVIDER || (ttsBin ? "cli" : "fish");
  // Manual runtime override (e.g. "use Kokoro while gaming"), set via
  // setProviderOverride(); null means "use ttsProvider as configured".
  let providerOverride = null;
  const kokoroManaVoice = env.KOKORO_MANA_VOICE || "jf_nezumi";
  // Pitch lift for a brighter, younger voice; the Kokoro service compensates
  // tempo so speech speed is unaffected. 1.0 disables.
  const kokoroManaPitch = Number(env.KOKORO_MANA_PITCH || 1.05);
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

  let fishTtsRefAudioBase64Cache = null;
  let fishTtsRefAudioBase64CachePath = null;

  function loadFishTtsRefAudioBase64() {
    if (fishTtsRefAudioBase64CachePath !== fishTtsRefAudio) {
      fishTtsRefAudioBase64Cache = fs
        .readFileSync(fishTtsRefAudio)
        .toString("base64");
      fishTtsRefAudioBase64CachePath = fishTtsRefAudio;
    }
    return fishTtsRefAudioBase64Cache;
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

    if (fishTtsRefAudio || fishTtsRefText) {
      if (!fishTtsRefAudio || !fishTtsRefText) {
        throw new Error(
          "FISH_TTS_REF_AUDIO and FISH_TTS_REF_TEXT must both be set together; see docs/fish_speech_tts.md",
        );
      }
      request.references = [
        { audio: loadFishTtsRefAudioBase64(), text: fishTtsRefText },
      ];
    } else if (fishTtsReferenceId) {
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
          timeout: fishTtsTimeoutMs,
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
      req.on("timeout", () => {
        req.destroy(
          new Error(`Fish Speech request timed out after ${fishTtsTimeoutMs}ms`),
        );
      });
      req.write(payload);
      req.end();
    });
  }

  function pickKokoroLanguageProfile(text) {
    const language = detectTtsLanguage(text);
    return {
      voice: kokoroManaVoice,
      pitch: kokoroManaPitch,
      ...(kokoroLanguageProfiles[language] || kokoroLanguageProfiles.english),
    };
  }

  // Returns a GPT-SoVITS text_lang code for this text, or null when the
  // detected language isn't one GPT-SoVITS can synthesize (see
  // GPT_SOVITS_LANGUAGE_MAP). GPT_SOVITS_TEXT_LANG forces a fixed code for
  // every request, skipping detection entirely.
  function pickGptSovitsTextLang(text) {
    if (env.GPT_SOVITS_TEXT_LANG) {
      return env.GPT_SOVITS_TEXT_LANG;
    }
    const language = detectTtsLanguage(text);
    return GPT_SOVITS_LANGUAGE_MAP[language] || null;
  }

  function estimateWordTimings(text, avgMsPerWord = 120) {
    const words = String(text || "")
      .split(/\s+/)
      .filter(Boolean);
    const out = [];
    let t = 0;
    for (const w of words) {
      const start = t;
      const dur = avgMsPerWord;
      const end = start + dur;
      out.push({ word: w, startMs: start, endMs: end });
      t = end;
    }
    return out;
  }

  async function synthesizeWithConfiguredProvider(provider, text) {
    // Returns { audio: Buffer, timings: [{word,startMs,endMs}] }
    let audio = null;
    if (provider === "fish") {
      const startedAt = nowMs();
      audio = await postFish(text);
      logPerf("tts fish", startedAt);
    } else if (provider === "kokoro") {
      const startedAt = nowMs();
      const kokoroProfile = pickKokoroLanguageProfile(text);
      audio = await postJson(`${kokoroTtsUrl}/synthesize`, {
        text,
        ...kokoroProfile,
      });
      logPerf("tts kokoro", startedAt);
    } else if (provider === "chatterbox") {
      const startedAt = nowMs();
      audio = await postJson(`${chatterboxTtsUrl}/synthesize`, {
        text,
      });
      logPerf("tts chatterbox", startedAt);
    } else if (provider === "gpt_sovits") {
      if (!gptSovitsRefAudio || !gptSovitsPromptText) {
        throw new Error(
          "GPT_SOVITS_REF_AUDIO and GPT_SOVITS_PROMPT_TEXT must be set; see docs/gpt_sovits_setup.md",
        );
      }
      const textLang = pickGptSovitsTextLang(text);
      if (!textLang) {
        throw new Error(
          `GPT-SoVITS cannot speak the detected language of this text (supports English, Chinese, Japanese, Korean); see docs/gpt_sovits_setup.md`,
        );
      }
      const startedAt = nowMs();
      audio = await postJson(`${gptSovitsTtsUrl}/tts`, {
        text,
        text_lang: textLang,
        ref_audio_path: gptSovitsRefAudio,
        prompt_text: gptSovitsPromptText,
        prompt_lang: gptSovitsPromptLang,
        text_split_method: "cut5",
        batch_size: 1,
        media_type: "wav",
      });
      logPerf("tts gpt_sovits", startedAt);
    } else if (provider === "cli") {
      audio = runTts(text);
    } else {
      throw new Error(`TTS provider not configured: ${provider}`);
    }

    // Try to extract precise timings if the provider returned metadata in a custom wrapper
    // (future: providers that return {audio, timings} will be supported).
    // For now, provide an estimated timing map per word.
    const timings = estimateWordTimings(text, 120);
    return { audio: Buffer.from(audio), timings };
  }

  async function synthesizeReply(text) {
    if (!text) {
      throw new Error("No text provided for synthesis");
    }

    // Emojis and kaomojis are spoken as short words ("smile") instead of
    // Unicode names ("smiling face with smiling eyes").
    try {
      const { normalizeSpeechText } = require("./utils/speech-text");
      const normalized = normalizeSpeechText(text);
      if (normalized) {
        text = normalized;
      }
    } catch (e) {
      // Never let speech normalization break synthesis.
    }

    // A manual override (e.g. "use Kokoro while gaming") wins over the
    // configured provider until it's cleared.
    const activeProvider = providerOverride || ttsProvider;

    if (activeProvider === "fish") {
      try {
        const res = await synthesizeWithConfiguredProvider("fish", text);
        return res.audio;
      } catch (error) {
        if (fishTtsFallbackProvider === "none") {
          throw error;
        }

        console.warn(
          `Fish Speech TTS failed, falling back to ${fishTtsFallbackProvider}: ${error.message}`,
        );
        const res = await synthesizeWithConfiguredProvider(
          fishTtsFallbackProvider,
          text,
        );
        return res.audio;
      }
    }

    if (activeProvider === "kokoro") {
      try {
        const res = await synthesizeWithConfiguredProvider("kokoro", text);
        return res.audio;
      } catch (error) {
        if (kokoroTtsFallbackProvider === "none") {
          throw error;
        }

        console.warn(
          `Kokoro TTS failed, falling back to ${kokoroTtsFallbackProvider}: ${error.message}`,
        );
        const res = await synthesizeWithConfiguredProvider(
          kokoroTtsFallbackProvider,
          text,
        );
        return res.audio;
      }
    }

    if (activeProvider === "chatterbox") {
      try {
        const res = await synthesizeWithConfiguredProvider("chatterbox", text);
        return res.audio;
      } catch (error) {
        if (chatterboxTtsFallbackProvider === "none") {
          throw error;
        }
        console.warn(
          `Chatterbox TTS failed, falling back to ${chatterboxTtsFallbackProvider}: ${error.message}`,
        );
        const res = await synthesizeWithConfiguredProvider(
          chatterboxTtsFallbackProvider,
          text,
        );
        return res.audio;
      }
    }

    if (activeProvider === "gpt_sovits") {
      try {
        const res = await synthesizeWithConfiguredProvider("gpt_sovits", text);
        return res.audio;
      } catch (error) {
        if (gptSovitsFallbackProvider === "none") {
          throw error;
        }
        console.warn(
          `GPT-SoVITS TTS failed, falling back to ${gptSovitsFallbackProvider}: ${error.message}`,
        );
        const res = await synthesizeWithConfiguredProvider(
          gptSovitsFallbackProvider,
          text,
        );
        return res.audio;
      }
    }

    if (activeProvider === "cli") {
      const res = await synthesizeWithConfiguredProvider("cli", text);
      return res.audio;
    }

    throw new Error("TTS not configured");
  }

  return {
    buildFishTtsRequest,
    buildTtsArgs,
    detectTtsLanguage,
    pickGptSovitsTextLang,
    pickKokoroLanguageProfile,
    runTts,
    synthesizeReply,
    synthesizeWithConfiguredProvider,
    ttsProvider,
    getProviderOverride: () => providerOverride,
    setProviderOverride: (provider) => {
      providerOverride = provider || null;
    },
    urls: {
      chatterboxTtsUrl,
      fishTtsUrl,
      kokoroTtsUrl,
      gptSovitsTtsUrl,
    },
  };
}

module.exports = {
  DEFAULT_KOKORO_LANGUAGE_PROFILES,
  GPT_SOVITS_LANGUAGE_MAP,
  createTtsRuntime,
  detectTtsLanguage,
  postJsonBuffer,
};
