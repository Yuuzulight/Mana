const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const videoWatchPlugin = require("../index");

async function withServer(app, fn) {
  const http = require("node:http");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json();
  return { response, payload };
}

function buildApp(deps) {
  const app = express();
  app.use(express.json());
  videoWatchPlugin.registerRoutes(app, deps);
  return app;
}

test("POST /video/watch requires both source and question", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const missingSource = await postJson(`${baseUrl}/video/watch`, { question: "what happens?" });
    assert.equal(missingSource.response.status, 400);
    assert.match(missingSource.payload.error, /source is required/);

    const missingQuestion = await postJson(`${baseUrl}/video/watch`, { source: "clip.mp4" });
    assert.equal(missingQuestion.response.status, 400);
    assert.match(missingQuestion.payload.error, /question is required/);
  });
});

test("POST /video/watch drives a local file through captions-free whisper fallback and returns an answer", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-video-watch-cap-"));
  const localFile = path.join(workDir, "clip.mp4");
  fs.writeFileSync(localFile, "fake video bytes");

  const fakeSpawn = (bin, args) => {
    if (bin === "ffprobe") {
      return { status: 0, stdout: JSON.stringify({ format: { duration: "8" } }) };
    }
    if (bin === "ffmpeg" && args.includes("-skip_frame")) {
      const outArg = args[args.length - 1];
      fs.writeFileSync(outArg.replace("%04d", "0001"), "frame bytes");
      return { status: 0 };
    }
    if (bin === "ffmpeg") return { status: 0 };
    if (String(bin).includes("whisper")) {
      const ofIndex = args.indexOf("-of");
      const outBase = args[ofIndex + 1];
      fs.writeFileSync(
        `${outBase}.json`,
        JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1000 }, text: "a dog barks" }] }),
      );
      return { status: 0 };
    }
    return { status: 1, stderr: "unexpected binary" };
  };

  const app = buildApp({
    env: { WHISPER_BIN: "whisper-cli", WHISPER_MODEL: "" },
    spawnFn: fakeSpawn,
    runVisionReply: async (prompt) => {
      assert.match(prompt, /a dog barks/);
      return "it's a dog barking on a lawn";
    },
  });

  // Force whisper discovery to resolve without needing real files on disk.
  const whisperDiscovery = require("../../../node-bot/whisper-discovery");
  const originalFindBin = whisperDiscovery.findWhisperBin;
  const originalFindModel = whisperDiscovery.findWhisperModel;
  whisperDiscovery.findWhisperBin = () => "whisper-cli";
  whisperDiscovery.findWhisperModel = () => "ggml-base.en.bin";

  try {
    await withServer(app, async (baseUrl) => {
      const { response, payload } = await postJson(`${baseUrl}/video/watch`, {
        source: localFile,
        question: "what's happening?",
      });
      assert.equal(response.status, 200);
      assert.equal(payload.transcriptSource, "whisper");
      assert.equal(payload.frameCount, 1);
      assert.equal(payload.answer, "it's a dog barking on a lawn");
    });
  } finally {
    whisperDiscovery.findWhisperBin = originalFindBin;
    whisperDiscovery.findWhisperModel = originalFindModel;
  }
});

test("plugin metadata matches the shape other Mana plugins use", () => {
  assert.equal(videoWatchPlugin.key, "videoWatch");
  assert.equal(videoWatchPlugin.category, "Vision");
  assert.equal(videoWatchPlugin.defaultEnabled, false);
});

test("getHealth reports unavailable without a whisper model, and configured once one is found", () => {
  const whisperDiscovery = require("../../../node-bot/whisper-discovery");
  const original = whisperDiscovery.findWhisperModel;
  try {
    whisperDiscovery.findWhisperModel = () => null;
    assert.equal(videoWatchPlugin.getHealth({ env: {} }).status, "unavailable");

    whisperDiscovery.findWhisperModel = () => "ggml-base.en.bin";
    assert.equal(videoWatchPlugin.getHealth({ env: {} }).status, "configured");
  } finally {
    whisperDiscovery.findWhisperModel = original;
  }
});
