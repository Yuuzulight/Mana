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
