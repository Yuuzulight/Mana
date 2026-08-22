const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");

test("POST /transcribe-partial returns a transcript for a valid upload", async () => {
  const app = createApp({
    runWhisperPartial: async (filePath) => {
      assert.ok(filePath, "should receive a file path");
      return "partial transcript text";
    },
  });

  await withServer(app, async (baseUrl) => {
    const form = new FormData();
    // A tiny valid WAV header is enough -- runWhisperPartial is mocked
    // above and never actually reads this file's audio content.
    const wavBytes = Buffer.from(
      "52494646244000005741564566" + "6d7420100000000100010080" + "3e0000807d000002001000" + "6461746100000000",
      "hex",
    );
    form.append("file", new Blob([wavBytes]), "test.wav");

    const response = await fetch(`${baseUrl}/transcribe-partial`, {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.transcript, "partial transcript text");
  });
});

test("POST /transcribe-partial rejects a request with no file", async () => {
  const app = createApp({
    runWhisperPartial: async () => "unused",
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/transcribe-partial`, {
      method: "POST",
      body: new FormData(),
    });

    assert.equal(response.status, 400);
  });
});

test("POST /transcribe-partial returns 500 if the whisper call throws", async () => {
  const app = createApp({
    runWhisperPartial: async () => {
      throw new Error("whisper (partial) failed: boom");
    },
  });

  await withServer(app, async (baseUrl) => {
    const form = new FormData();
    const wavBytes = Buffer.from(
      "52494646244000005741564566" + "6d7420100000000100010080" + "3e0000807d000002001000" + "6461746100000000",
      "hex",
    );
    form.append("file", new Blob([wavBytes]), "test.wav");

    const response = await fetch(`${baseUrl}/transcribe-partial`, {
      method: "POST",
      body: form,
    });

    assert.equal(response.status, 500);
  });
});
