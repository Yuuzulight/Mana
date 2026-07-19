const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");

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

test("tts runtime builds Fish Speech requests with inline reference audio", () => {
  let readCalls = 0;
  const fakeFs = {
    readFileSync: (filePath) => {
      readCalls += 1;
      assert.equal(filePath, "tts-service/references/mana-mitsuki.wav");
      return Buffer.from("fake-wav-bytes");
    },
  };
  const runtime = createTtsRuntime({
    fs: fakeFs,
    env: {
      FISH_TTS_REF_AUDIO: "tts-service/references/mana-mitsuki.wav",
      FISH_TTS_REF_TEXT: "In a quiet village where the sky brushes the fields.",
      FISH_TTS_REFERENCE_ID: "should-be-ignored",
    },
  });

  const request = runtime.buildFishTtsRequest("hello");

  assert.equal(request.reference_id, undefined);
  assert.deepEqual(request.references, [
    {
      audio: Buffer.from("fake-wav-bytes").toString("base64"),
      text: "In a quiet village where the sky brushes the fields.",
    },
  ]);

  // A second call should reuse the cached base64 instead of re-reading the file.
  runtime.buildFishTtsRequest("hello again");
  assert.equal(readCalls, 1);
});

test("tts runtime rejects a Fish Speech reference audio/text mismatch", () => {
  const runtime = createTtsRuntime({
    env: {
      FISH_TTS_REF_AUDIO: "tts-service/references/mana-mitsuki.wav",
    },
  });

  assert.throws(
    () => runtime.buildFishTtsRequest("hello"),
    /FISH_TTS_REF_AUDIO and FISH_TTS_REF_TEXT must both be set together/,
  );
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

test("manual provider override wins over the configured provider", async () => {
  const fishCalls = [];
  const kokoroCalls = [];
  const runtime = createTtsRuntime({
    env: {
      TTS_PROVIDER: "fish",
      KOKORO_TTS_URL: "http://kokoro.local",
    },
    postFishTtsBuffer: async (text) => {
      fishCalls.push(text);
      return Buffer.from("fish-audio");
    },
    postJsonBuffer: async (url, body) => {
      kokoroCalls.push(body);
      return Buffer.from("kokoro-audio");
    },
    nowMs: () => 1,
    logPerf: () => {},
  });

  assert.equal(runtime.getProviderOverride(), null);

  runtime.setProviderOverride("kokoro");
  assert.equal(runtime.getProviderOverride(), "kokoro");

  const audio = await runtime.synthesizeReply("hello");
  assert.equal(audio.toString("utf8"), "kokoro-audio");
  assert.equal(fishCalls.length, 0);
  assert.equal(kokoroCalls.length, 1);

  runtime.setProviderOverride(null);
  const audioAfterClear = await runtime.synthesizeReply("hello again");
  assert.equal(audioAfterClear.toString("utf8"), "fish-audio");
});

test("fish request times out and falls back to Kokoro instead of hanging", async () => {
  const kokoroCalls = [];
  const runtime = createTtsRuntime({
    env: {
      TTS_PROVIDER: "fish",
      FISH_TTS_FALLBACK_PROVIDER: "kokoro",
      KOKORO_TTS_URL: "http://kokoro.local",
    },
    postFishTtsBuffer: async () => {
      throw new Error("Fish Speech request timed out after 20000ms");
    },
    postJsonBuffer: async (url, body) => {
      kokoroCalls.push(body);
      return Buffer.from("kokoro-audio");
    },
    nowMs: () => 1,
    logPerf: () => {},
  });

  const audio = await runtime.synthesizeReply("hello");
  assert.equal(audio.toString("utf8"), "kokoro-audio");
  assert.equal(kokoroCalls.length, 1);
});

test("swapFishDevice hits POST /admin/device and skips repeat requests for the same target", async () => {
  const swapRequests = [];
  const server = http.createServer((req, res) => {
    swapRequests.push({ method: req.method, url: req.url });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const runtime = createTtsRuntime({
      env: { FISH_TTS_URL: `http://127.0.0.1:${port}` },
    });

    await runtime.swapFishDevice("cpu");
    assert.equal(swapRequests.length, 1);
    assert.equal(swapRequests[0].method, "POST");
    assert.equal(swapRequests[0].url, "/admin/device?target=cpu");

    // Same target again: should not refire the request.
    await runtime.swapFishDevice("cpu");
    assert.equal(swapRequests.length, 1);

    // Different target: fires again.
    await runtime.swapFishDevice("cuda");
    assert.equal(swapRequests.length, 2);
    assert.equal(swapRequests[1].url, "/admin/device?target=cuda");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("swapFishDevice retries after a failed swap instead of getting stuck", async () => {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount += 1;
    if (requestCount === 1) {
      res.writeHead(500);
      res.end("device busy");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const runtime = createTtsRuntime({
      env: { FISH_TTS_URL: `http://127.0.0.1:${port}` },
    });

    await assert.rejects(runtime.swapFishDevice("cpu"));
    // Retried instead of silently no-op'ing because the last attempt failed.
    await runtime.swapFishDevice("cpu");
    assert.equal(requestCount, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
