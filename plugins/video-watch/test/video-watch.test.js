const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MIN_FRAMES,
  MAX_FRAMES,
  computeFrameBudget,
  parseCaptions,
  formatTimestamp,
  formatTimestampedTranscript,
  downloadVideo,
  getVideoDurationSeconds,
  extractFrames,
  transcribeVideoAudio,
  isLikelyUrl,
  watchVideo,
  answerAboutVideo,
} = require("../video-watch");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-video-watch-"));
}

test("computeFrameBudget respects the hard 2fps ceiling for very short clips", () => {
  assert.equal(computeFrameBudget(5), 10);
});

test("computeFrameBudget targets ~12-30 frames for a short clip", () => {
  const frames = computeFrameBudget(60);
  assert.ok(frames >= MIN_FRAMES && frames <= 30, `expected 12-30, got ${frames}`);
});

test("computeFrameBudget caps at MAX_FRAMES for a long video", () => {
  assert.equal(computeFrameBudget(3600), MAX_FRAMES);
});

test("computeFrameBudget floors at MIN_FRAMES for a zero/negative duration", () => {
  assert.equal(computeFrameBudget(0), MIN_FRAMES);
  assert.equal(computeFrameBudget(-5), MIN_FRAMES);
});

test("parseCaptions extracts start/end/text from WEBVTT cues", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:04.000",
    "Hello world",
    "",
    "00:00:04.500 --> 00:00:06.000",
    "second line",
  ].join("\n");
  const segments = parseCaptions(vtt);
  assert.deepEqual(segments, [
    { start: 1, end: 4, text: "Hello world" },
    { start: 4.5, end: 6, text: "second line" },
  ]);
});

test("parseCaptions strips inline VTT tags and skips cues with no text", () => {
  const vtt = [
    "WEBVTT",
    "00:00:00.000 --> 00:00:02.000",
    "<c>styled</c> text",
    "00:00:02.000 --> 00:00:03.000",
    "",
  ].join("\n");
  assert.deepEqual(parseCaptions(vtt), [{ start: 0, end: 2, text: "styled text" }]);
});

test("formatTimestamp renders seconds as HH:MM:SS", () => {
  assert.equal(formatTimestamp(0), "00:00:00");
  assert.equal(formatTimestamp(65), "00:01:05");
  assert.equal(formatTimestamp(3661), "01:01:01");
});

test("formatTimestampedTranscript joins segments with bracketed timestamps", () => {
  const result = formatTimestampedTranscript([
    { start: 0, end: 2, text: "hi" },
    { start: 65, end: 70, text: "there" },
  ]);
  assert.equal(result, "[00:00:00] hi\n[00:01:05] there");
});

test("isLikelyUrl distinguishes a URL from a local file path", () => {
  assert.equal(isLikelyUrl("https://example.com/video"), true);
  assert.equal(isLikelyUrl("http://example.com/video"), true);
  assert.equal(isLikelyUrl("C:\\videos\\clip.mp4"), false);
  assert.equal(isLikelyUrl("/home/user/clip.mp4"), false);
});

test("downloadVideo runs yt-dlp and returns the produced video and captions paths", () => {
  const outputDir = createTempDir();
  const calls = [];
  const fakeSpawn = (bin, args) => {
    calls.push({ bin, args });
    fs.writeFileSync(path.join(outputDir, "video.mp4"), "fake video bytes");
    fs.writeFileSync(path.join(outputDir, "video.en.vtt"), "WEBVTT");
    return { status: 0 };
  };

  const result = downloadVideo("https://example.com/watch?v=abc", {
    outputDir,
    ytDlpBin: "yt-dlp",
    spawnFn: fakeSpawn,
  });

  assert.equal(calls[0].bin, "yt-dlp");
  assert.ok(calls[0].args.includes("https://example.com/watch?v=abc"));
  assert.equal(result.videoPath, path.join(outputDir, "video.mp4"));
  assert.equal(result.captionsPath, path.join(outputDir, "video.en.vtt"));
});

test("downloadVideo throws when yt-dlp exits non-zero", () => {
  const outputDir = createTempDir();
  assert.throws(
    () =>
      downloadVideo("https://example.com/x", {
        outputDir,
        spawnFn: () => ({ status: 1, stderr: "network error" }),
      }),
    /yt-dlp failed/,
  );
});

test("downloadVideo throws when yt-dlp reports success but produced no video file", () => {
  const outputDir = createTempDir();
  assert.throws(
    () => downloadVideo("https://example.com/x", { outputDir, spawnFn: () => ({ status: 0 }) }),
    /did not produce a video file/,
  );
});

test("getVideoDurationSeconds parses ffprobe's JSON duration output", () => {
  const duration = getVideoDurationSeconds("video.mp4", {
    spawnFn: () => ({ status: 0, stdout: JSON.stringify({ format: { duration: "42.5" } }) }),
  });
  assert.equal(duration, 42.5);
});

test("getVideoDurationSeconds throws when ffprobe fails", () => {
  assert.throws(
    () => getVideoDurationSeconds("video.mp4", { spawnFn: () => ({ status: 1, stderr: "bad file" }) }),
    /ffprobe failed/,
  );
});

test("extractFrames caps returned frames at frameBudget and reads them as base64", () => {
  const outputDir = createTempDir();
  const fakeSpawn = () => {
    for (let i = 1; i <= 5; i += 1) {
      fs.writeFileSync(path.join(outputDir, `frame_000${i}.jpg`), `frame-${i}`);
    }
    return { status: 0 };
  };

  const frames = extractFrames("video.mp4", { outputDir, frameBudget: 3, spawnFn: fakeSpawn });
  assert.equal(frames.length, 3);
  assert.equal(Buffer.from(frames[0], "base64").toString("utf8"), "frame-1");
});

test("extractFrames throws when ffmpeg fails", () => {
  const outputDir = createTempDir();
  assert.throws(
    () =>
      extractFrames("video.mp4", {
        outputDir,
        frameBudget: 3,
        spawnFn: () => ({ status: 1, stderr: "bad codec" }),
      }),
    /ffmpeg frame extraction failed/,
  );
});

test("extractFrames in scene mode uses a scene-change select filter", () => {
  const outputDir = createTempDir();
  let usedArgs = null;
  extractFrames("video.mp4", {
    outputDir,
    frameBudget: 2,
    mode: "scene",
    spawnFn: (bin, args) => {
      usedArgs = args;
      return { status: 0 };
    },
  });
  assert.ok(usedArgs.some((a) => String(a).includes("scene")));
  assert.ok(!usedArgs.includes("-skip_frame"));
});

test("transcribeVideoAudio parses whisper-cli's JSON segments with timestamps", () => {
  const workDir = createTempDir();
  const fakeSpawn = (bin, args) => {
    if (bin === "ffmpeg") return { status: 0 };
    // whisper-cli: write the -of <base> + ".json" output file
    const ofIndex = args.indexOf("-of");
    const outBase = args[ofIndex + 1];
    fs.writeFileSync(
      `${outBase}.json`,
      JSON.stringify({
        transcription: [
          { offsets: { from: 0, to: 2000 }, text: " hello " },
          { offsets: { from: 2000, to: 5000 }, text: "world" },
        ],
      }),
    );
    return { status: 0 };
  };

  const segments = transcribeVideoAudio("video.mp4", {
    workDir,
    whisperBin: "whisper-cli",
    whisperModel: "ggml-base.en.bin",
    spawnFn: fakeSpawn,
  });
  assert.deepEqual(segments, [
    { start: 0, end: 2, text: "hello" },
    { start: 2, end: 5, text: "world" },
  ]);
});

test("transcribeVideoAudio requires whisperBin and whisperModel", () => {
  assert.throws(
    () => transcribeVideoAudio("video.mp4", { workDir: createTempDir() }),
    /whisperBin and whisperModel are required/,
  );
});

test("watchVideo uses captions when present and skips whisper entirely", async () => {
  const workDir = createTempDir();
  let whisperCalled = false;
  const fakeSpawn = (bin, args) => {
    if (String(bin).includes("yt-dlp")) {
      const outDir = path.dirname(args[args.indexOf("-o") + 1]);
      fs.writeFileSync(path.join(outDir, "video.mp4"), "video bytes");
      fs.writeFileSync(
        path.join(outDir, "video.en.vtt"),
        "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhi there\n",
      );
      return { status: 0 };
    }
    if (bin === "ffprobe") return { status: 0, stdout: JSON.stringify({ format: { duration: "10" } }) };
    if (bin === "ffmpeg") {
      // frame extraction call; write one dummy frame
      const outArg = args[args.length - 1];
      fs.writeFileSync(outArg.replace("%04d", "0001"), "frame bytes");
      return { status: 0 };
    }
    whisperCalled = true;
    return { status: 0 };
  };

  const result = await watchVideo("https://example.com/watch?v=xyz", {
    workDir,
    spawnFn: fakeSpawn,
    whisperBin: "whisper-cli",
    whisperModel: "ggml-base.en.bin",
  });

  assert.equal(whisperCalled, false);
  assert.equal(result.transcriptSource, "captions");
  assert.equal(result.transcript, "[00:00:00] hi there");
  assert.equal(result.frameCount, 1);
  assert.equal(result.durationSeconds, 10);
});

test("watchVideo falls back to whisper when the source has no captions", async () => {
  const workDir = createTempDir();
  const fakeSpawn = (bin, args) => {
    if (bin === "ffprobe") return { status: 0, stdout: JSON.stringify({ format: { duration: "10" } }) };
    if (bin === "ffmpeg" && args.includes("-skip_frame")) {
      const outArg = args[args.length - 1];
      fs.writeFileSync(outArg.replace("%04d", "0001"), "frame bytes");
      return { status: 0 };
    }
    if (bin === "ffmpeg") return { status: 0 }; // audio extraction for whisper
    const ofIndex = args.indexOf("-of");
    const outBase = args[ofIndex + 1];
    fs.writeFileSync(`${outBase}.json`, JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1000 }, text: "local file" }] }));
    return { status: 0 };
  };

  const result = await watchVideo(path.join(workDir, "local.mp4"), {
    workDir,
    spawnFn: fakeSpawn,
    whisperBin: "whisper-cli",
    whisperModel: "ggml-base.en.bin",
  });

  assert.equal(result.transcriptSource, "whisper");
  assert.equal(result.transcript, "[00:00:00] local file");
});

test("answerAboutVideo builds a prompt with the question and transcript, then calls runVisionReply", async () => {
  let receivedPrompt = null;
  let receivedFrames = null;
  const runVisionReply = async (prompt, frames) => {
    receivedPrompt = prompt;
    receivedFrames = frames;
    return "it's a cat video";
  };

  const answer = await answerAboutVideo(
    "what's in this video?",
    { transcript: "[00:00:00] meow", frames: ["base64frame"] },
    { runVisionReply },
  );

  assert.equal(answer, "it's a cat video");
  assert.match(receivedPrompt, /what's in this video\?/);
  assert.match(receivedPrompt, /meow/);
  assert.deepEqual(receivedFrames, ["base64frame"]);
});

test("answerAboutVideo requires runVisionReply", async () => {
  await assert.rejects(() => answerAboutVideo("q", { transcript: "" }, {}), /runVisionReply is required/);
});
