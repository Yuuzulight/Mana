const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");
const whisperDiscovery = require("../whisper-discovery");

// Exercises the real runWhisperCliPartial/spawnWhisperCliAsync pipeline
// (async spawn, arg construction, JSON-wait loop, parse/fallback branches)
// against a real audio file -- transcribe-partial-route.test.js only tests
// the route layer with runWhisperPartial mocked, which never actually runs
// this code. Skips gracefully if this checkout has no whisper.cpp
// binary/model (they're large vendored files, not guaranteed present in
// every environment), rather than failing CI elsewhere.
const whisperAvailable =
  Boolean(whisperDiscovery.findWhisperBin({ env: process.env })) &&
  Boolean(whisperDiscovery.findWhisperModel({ env: process.env }));

// A minimal valid WAV file: ~0.3s of near-silence at 16kHz mono 16-bit PCM.
// Silence is fine here -- this test verifies the spawn/parse pipeline
// completes and returns a string, not transcription accuracy.
function makeSilentWav(durationMs = 300) {
  const sampleRate = 16000;
  const numSamples = Math.round((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  // PCM data left zeroed (silence) -- Buffer.alloc already zero-fills.

  return buffer;
}

test(
  "runWhisperCliPartial (via /transcribe-partial, unmocked) transcribes a real WAV file",
  { skip: !whisperAvailable && "no whisper.cpp binary/model in this checkout" },
  async () => {
    // No runWhisperPartial override -- exercises the real implementation.
    const app = createApp();

    await withServer(app, async (baseUrl) => {
      const form = new FormData();
      form.append("file", new Blob([makeSilentWav()]), "silent.wav");

      const response = await fetch(`${baseUrl}/transcribe-partial`, {
        method: "POST",
        body: form,
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(typeof body.transcript, "string");
    });
  },
);
