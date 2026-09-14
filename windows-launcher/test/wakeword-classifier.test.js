const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createWakeWordClassifier,
  SAMPLE_RATE,
  EMBEDDING_FRAMES,
  WINDOW_SAMPLES,
  DEFAULT_THRESHOLD,
} = require("../renderer/wakeword-classifier");

// Fake onnxruntime-web: records every session.run() call and returns a
// scripted output, so the constructor/threshold/session-reuse tests below
// exercise this module's own logic without a real ONNX runtime or model
// files -- same pattern as silero-vad.test.js's fakeOrt.
function fakeOrt({ classifierScore = 0 } = {}) {
  let createCalls = 0;
  return {
    ort: {
      Tensor: class FakeTensor {
        constructor(type, data, dims) {
          this.type = type;
          this.data = data;
          this.dims = dims;
        }
      },
      InferenceSession: {
        create: async () => {
          createCalls += 1;
          return {
            run: async (feeds) => {
              if (feeds.input_1) {
                // embedding stage: one 96-dim row of zeros per window
                const windows = feeds.input_1.dims[0];
                return { conv2d_19: { data: new Float32Array(windows * 96), dims: [windows, 1, 1, 96] } };
              }
              if (feeds.input && feeds.input.dims.length === 3) {
                // classifier stage: (1, frames, 96) in -> scripted score out
                return { output: { data: [classifierScore] } };
              }
              // melspectrogram stage: (1, samples) in -> a fixed 197-frame,
              // 32-bin output, matching the real model's shape for a 2.0s clip.
              return { output: { data: new Float32Array(197 * 32), dims: [1, 1, 197, 32] } };
            },
          };
        },
      },
    },
    getCreateCalls: () => createCalls,
  };
}

test("createWakeWordClassifier requires ort and all three model URLs", () => {
  assert.throws(() => createWakeWordClassifier({ melspecModelUrl: "a", embeddingModelUrl: "b", classifierModelUrl: "c" }), /ort/);
  assert.throws(() => createWakeWordClassifier({ ort: fakeOrt().ort }), /melspecModelUrl/);
});

test("alignToWindow pads a shorter clip with leading silence, ending at the window's end", () => {
  const { ort } = fakeOrt();
  const classifier = createWakeWordClassifier({
    ort,
    melspecModelUrl: "a",
    embeddingModelUrl: "b",
    classifierModelUrl: "c",
  });

  const shortClip = new Int16Array(100).fill(7);
  const aligned = classifier.alignToWindow(shortClip);

  assert.equal(aligned.length, WINDOW_SAMPLES);
  assert.ok(aligned.subarray(0, WINDOW_SAMPLES - 100).every((v) => v === 0), "leading samples should be silence");
  assert.deepEqual(Array.from(aligned.subarray(WINDOW_SAMPLES - 100)), Array.from(shortClip));
});

test("alignToWindow truncates a longer clip to its trailing WINDOW_SAMPLES", () => {
  const { ort } = fakeOrt();
  const classifier = createWakeWordClassifier({
    ort,
    melspecModelUrl: "a",
    embeddingModelUrl: "b",
    classifierModelUrl: "c",
  });

  const longClip = new Int16Array(WINDOW_SAMPLES + 500);
  for (let i = 0; i < longClip.length; i += 1) longClip[i] = i % 100;
  const aligned = classifier.alignToWindow(longClip);

  assert.equal(aligned.length, WINDOW_SAMPLES);
  assert.deepEqual(Array.from(aligned), Array.from(longClip.subarray(500)));
});

test("alignToWindow returns the input unchanged when it's already exactly WINDOW_SAMPLES", () => {
  const { ort } = fakeOrt();
  const classifier = createWakeWordClassifier({
    ort,
    melspecModelUrl: "a",
    embeddingModelUrl: "b",
    classifierModelUrl: "c",
  });

  const exact = new Int16Array(WINDOW_SAMPLES).fill(3);
  assert.equal(classifier.alignToWindow(exact), exact);
});

test("mayContainWakeWord compares the classifier's score against the configured threshold", async () => {
  const { ort: lowScoreOrt } = fakeOrt({ classifierScore: 0.3 });
  const belowThreshold = createWakeWordClassifier({
    ort: lowScoreOrt,
    melspecModelUrl: "a",
    embeddingModelUrl: "b",
    classifierModelUrl: "c",
    threshold: 0.9,
  });
  assert.equal(await belowThreshold.mayContainWakeWord(new Int16Array(WINDOW_SAMPLES)), false);

  const { ort: highScoreOrt } = fakeOrt({ classifierScore: 0.95 });
  const aboveThreshold = createWakeWordClassifier({
    ort: highScoreOrt,
    melspecModelUrl: "a",
    embeddingModelUrl: "b",
    classifierModelUrl: "c",
    threshold: 0.9,
  });
  assert.equal(await aboveThreshold.mayContainWakeWord(new Int16Array(WINDOW_SAMPLES)), true);
});

test("the default threshold is exported and used when none is given", async () => {
  assert.equal(DEFAULT_THRESHOLD, 0.9);
});

test("all three ONNX sessions are created once and reused across score() calls", async () => {
  const { ort, getCreateCalls } = fakeOrt();
  const classifier = createWakeWordClassifier({
    ort,
    melspecModelUrl: "a",
    embeddingModelUrl: "b",
    classifierModelUrl: "c",
  });

  await classifier.score(new Int16Array(WINDOW_SAMPLES));
  await classifier.score(new Int16Array(WINDOW_SAMPLES));

  assert.equal(getCreateCalls(), 3, "melspec + embedding + classifier sessions, created once each");
});

// Real end-to-end test against the actual committed/fetched model files --
// skips gracefully (rather than failing CI) if fetch-wakeword-models.js
// hasn't been run in this checkout, same reasoning as
// windows-native-launcher's SkippableFact tests for the equivalent C# port.
test("real models: a 2.0s window of silence produces a valid, low sigmoid score", async (t) => {
  const wakeWordDir = path.join(__dirname, "..", "assets", "wakeword");
  const melspecPath = path.join(wakeWordDir, "melspectrogram.onnx");
  const embeddingPath = path.join(wakeWordDir, "embedding_model.onnx");
  const classifierPath = path.join(wakeWordDir, "mana.onnx");
  const allPresent = [melspecPath, embeddingPath, classifierPath].every(
    (p) => fs.existsSync(p) && fs.statSync(p).size > 0,
  );
  if (!allPresent) {
    t.skip("wakeword model files not present -- run `npm run fetch-wakeword-models` first");
    return;
  }

  const ort = require("onnxruntime-web");
  const classifier = createWakeWordClassifier({
    ort,
    melspecModelUrl: melspecPath,
    embeddingModelUrl: embeddingPath,
    classifierModelUrl: classifierPath,
  });

  const silence = new Int16Array(WINDOW_SAMPLES);
  const score = await classifier.score(silence);

  assert.ok(score >= 0 && score <= 1, `score ${score} should be a valid sigmoid output`);
  assert.equal(EMBEDDING_FRAMES, 16);
  assert.equal(SAMPLE_RATE, 16000);
});
