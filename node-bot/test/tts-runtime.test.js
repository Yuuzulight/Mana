const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTtsRuntime,
  detectTtsLanguage,
} = require("../tts-runtime");

test("tts runtime builds CLI args from configured placeholders", () => {
  const runtime = createTtsRuntime({
    env: {
      TTS_BIN: "tts.exe",
      TTS_MODEL: "model.bin",
      TTS_VOICE: "mana",
      TTS_ARGS_JSON: JSON.stringify([
        "--model",
        "{model}",
        "--voice",
        "{voice}",
        "--text",
        "{text}",
        "--out",
        "{output}",
      ]),
    },
  });

  assert.deepEqual(runtime.buildTtsArgs("hello", "out.wav"), [
    "--model",
    "model.bin",
    "--voice",
    "mana",
    "--text",
    "hello",
    "--out",
    "out.wav",
  ]);
});

test("tts runtime detects multilingual Kokoro profiles", () => {
  const runtime = createTtsRuntime({
    env: {
      KOKORO_MANA_VOICE: "jf_test",
    },
  });

  assert.equal(detectTtsLanguage("こんにちは"), "japanese");
  assert.equal(detectTtsLanguage("hola gracias"), "spanish");
  assert.deepEqual(runtime.pickKokoroLanguageProfile("hola gracias"), {
    voice: "jf_test",
    pitch: 1.05,
    lang: "es",
    speed: 1.1,
  });
});

test("tts runtime builds Fish Speech requests with optional reference id", () => {
  const runtime = createTtsRuntime({
    env: {
      FISH_TTS_REFERENCE_ID: "voice-1",
      FISH_TTS_FORMAT: "wav",
      FISH_TTS_LATENCY: "balanced",
      FISH_TTS_MAX_NEW_TOKENS: "64",
      FISH_TTS_CHUNK_LENGTH: "120",
      FISH_TTS_TOP_P: "0.7",
      FISH_TTS_REPETITION_PENALTY: "1.2",
      FISH_TTS_TEMPERATURE: "0.5",
    },
  });

  assert.deepEqual(runtime.buildFishTtsRequest("hello"), {
    text: "hello",
    format: "wav",
    latency: "balanced",
    max_new_tokens: 64,
    chunk_length: 120,
    top_p: 0.7,
    repetition_penalty: 1.2,
    temperature: 0.5,
    reference_id: "voice-1",
  });
});

test("tts runtime falls back from Fish Speech to Kokoro when configured", async () => {
  const calls = [];
  const runtime = createTtsRuntime({
    env: {
      TTS_PROVIDER: "fish",
      FISH_TTS_FALLBACK_PROVIDER: "kokoro",
      KOKORO_TTS_URL: "http://kokoro.local",
    },
    postFishTtsBuffer: async () => {
      throw new Error("fish unavailable");
    },
    postJsonBuffer: async (url, body) => {
      calls.push({ url, body });
      return Buffer.from("kokoro-audio");
    },
    nowMs: () => 1,
    logPerf: () => {},
  });

  const audio = await runtime.synthesizeReply("hello");

  assert.equal(audio.toString("utf8"), "kokoro-audio");
  assert.equal(calls[0].url, "http://kokoro.local/synthesize");
  assert.equal(calls[0].body.text, "hello");
});

test("tts runtime posts a correctly-shaped GPT-SoVITS request", async () => {
  const calls = [];
  const runtime = createTtsRuntime({
    env: {
      TTS_PROVIDER: "gpt_sovits",
      GPT_SOVITS_TTS_URL: "http://sovits.local",
      GPT_SOVITS_REF_AUDIO: "C:\\refs\\mana-alice.wav",
      GPT_SOVITS_PROMPT_TEXT: "Hi, I'm Mana!",
      GPT_SOVITS_PROMPT_LANG: "en",
      GPT_SOVITS_TEXT_LANG: "en",
    },
    postJsonBuffer: async (url, body) => {
      calls.push({ url, body });
      return Buffer.from("sovits-audio");
    },
    nowMs: () => 1,
    logPerf: () => {},
  });

  const audio = await runtime.synthesizeReply("hello there");

  assert.equal(audio.toString("utf8"), "sovits-audio");
  assert.equal(calls[0].url, "http://sovits.local/tts");
  assert.deepEqual(calls[0].body, {
    text: "hello there",
    text_lang: "en",
    ref_audio_path: "C:\\refs\\mana-alice.wav",
    prompt_text: "Hi, I'm Mana!",
    prompt_lang: "en",
    text_split_method: "cut5",
    batch_size: 1,
    media_type: "wav",
  });
});

test("tts runtime falls back from GPT-SoVITS to Kokoro when configured", async () => {
  const calls = [];
  const runtime = createTtsRuntime({
    env: {
      TTS_PROVIDER: "gpt_sovits",
      GPT_SOVITS_REF_AUDIO: "C:\\refs\\mana-alice.wav",
      GPT_SOVITS_PROMPT_TEXT: "Hi, I'm Mana!",
      GPT_SOVITS_TTS_FALLBACK_PROVIDER: "kokoro",
      KOKORO_TTS_URL: "http://kokoro.local",
    },
    postJsonBuffer: async (url) => {
      if (url.endsWith("/tts")) {
        throw new Error("sovits unavailable");
      }
      calls.push(url);
      return Buffer.from("kokoro-audio");
    },
    nowMs: () => 1,
    logPerf: () => {},
  });

  const audio = await runtime.synthesizeReply("hello");

  assert.equal(audio.toString("utf8"), "kokoro-audio");
  assert.equal(calls[0], "http://kokoro.local/synthesize");
});

test("tts runtime rejects GPT-SoVITS with no reference configured", async () => {
  const runtime = createTtsRuntime({
    env: { TTS_PROVIDER: "gpt_sovits", GPT_SOVITS_TTS_FALLBACK_PROVIDER: "none" },
    postJsonBuffer: async () => Buffer.from("unused"),
    nowMs: () => 1,
    logPerf: () => {},
  });

  await assert.rejects(
    () => runtime.synthesizeReply("hello"),
    /GPT_SOVITS_REF_AUDIO/,
  );
});

test("pickGptSovitsTextLang auto-detects supported languages and rejects the rest", () => {
  const runtime = createTtsRuntime({ env: {} });

  assert.equal(runtime.pickGptSovitsTextLang("Hello there!"), "en");
  assert.equal(runtime.pickGptSovitsTextLang("你好，今天天气怎么样？"), "zh");
  assert.equal(runtime.pickGptSovitsTextLang("こんにちは、元気ですか？"), "ja");
  assert.equal(runtime.pickGptSovitsTextLang("안녕하세요"), "ko");
  // German, Russian, Malay, Spanish are outside GPT-SoVITS's supported set.
  assert.equal(runtime.pickGptSovitsTextLang("Guten Tag, wie geht es dir?"), null);
  assert.equal(runtime.pickGptSovitsTextLang("Привет, как дела?"), null);
  assert.equal(runtime.pickGptSovitsTextLang("Selamat pagi, apa khabar?"), null);
});

test("GPT_SOVITS_TEXT_LANG forces a fixed code regardless of detection", () => {
  const runtime = createTtsRuntime({
    env: { GPT_SOVITS_TEXT_LANG: "zh" },
  });
  assert.equal(runtime.pickGptSovitsTextLang("Hello there!"), "zh");
});

test("tts runtime auto-detects text_lang per request with no override set", async () => {
  const calls = [];
  const runtime = createTtsRuntime({
    env: {
      TTS_PROVIDER: "gpt_sovits",
      GPT_SOVITS_TTS_URL: "http://sovits.local",
      GPT_SOVITS_REF_AUDIO: "C:\\refs\\mana-alice.wav",
      GPT_SOVITS_PROMPT_TEXT: "Hi, I'm Mana!",
    },
    postJsonBuffer: async (url, body) => {
      calls.push(body);
      return Buffer.from("sovits-audio");
    },
    nowMs: () => 1,
    logPerf: () => {},
  });

  await runtime.synthesizeReply("こんにちは！");
  assert.equal(calls[0].text_lang, "ja");

  await runtime.synthesizeReply("你好！");
  assert.equal(calls[1].text_lang, "zh");
});

test("tts runtime falls back to Kokoro for languages GPT-SoVITS cannot speak", async () => {
  const kokoroCalls = [];
  const sovitsCalls = [];
  const runtime = createTtsRuntime({
    env: {
      TTS_PROVIDER: "gpt_sovits",
      GPT_SOVITS_REF_AUDIO: "C:\\refs\\mana-alice.wav",
      GPT_SOVITS_PROMPT_TEXT: "Hi, I'm Mana!",
      KOKORO_TTS_URL: "http://kokoro.local",
      KOKORO_MANA_VOICE: "jf_test",
    },
    postJsonBuffer: async (url, body) => {
      if (url.endsWith("/tts")) {
        sovitsCalls.push(body);
        throw new Error("should not reach GPT-SoVITS for this language");
      }
      kokoroCalls.push(body);
      return Buffer.from("kokoro-audio");
    },
    nowMs: () => 1,
    logPerf: () => {},
  });

  // German: not supported by GPT-SoVITS, should route straight to Kokoro
  // with the correct German voice profile.
  const audio = await runtime.synthesizeReply("Guten Tag, wie geht es dir?");

  assert.equal(audio.toString("utf8"), "kokoro-audio");
  assert.equal(sovitsCalls.length, 0);
  assert.equal(kokoroCalls.length, 1);
  assert.equal(kokoroCalls[0].lang, "de");
});
