const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createSileroVad,
  FRAME_SAMPLES,
  CONTEXT_SIZE,
  SAMPLE_RATE,
  STATE_SHAPE,
} = require("../renderer/silero-vad");

// Fake onnxruntime-web: records every session.run() call's feeds and returns
// a scripted output/stateN pair, so these tests exercise createSileroVad's
// own logic (tensor shapes, context/state threading, error handling)
// without a real ONNX runtime or model file.
function fakeOrt({ outputs = [] } = {}) {
  const runCalls = [];
  let createCalls = 0;
  let nextOutputIndex = 0;
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
        create: async (modelUrl) => {
          createCalls += 1;
          return {
            run: async (feeds) => {
              runCalls.push(feeds);
              const scripted = outputs[nextOutputIndex] || {
                output: 0,
                stateN: new Float32Array(STATE_SHAPE.reduce((a, b) => a * b, 1)),
              };
              nextOutputIndex += 1;
              return {
                output: { data: [scripted.output] },
                stateN: { data: scripted.stateN },
              };
            },
          };
        },
      },
    },
    runCalls,
    getCreateCalls: () => createCalls,
  };
}

test("processFrame prepends a zeroed context window on the first call and sends a correctly-shaped input/state/sr", async () => {
  const { ort, runCalls } = fakeOrt({ outputs: [{ output: 0.87, stateN: new Float32Array(256).fill(1) }] });
  const vad = createSileroVad({ ort, modelUrl: "model.onnx" });

  const frame = new Float32Array(FRAME_SAMPLES).fill(0.1);
  const probability = await vad.processFrame(frame);

  assert.equal(probability, 0.87);
  assert.equal(runCalls.length, 1);
  const feeds = runCalls[0];
  assert.deepEqual(feeds.input.dims, [1, CONTEXT_SIZE + FRAME_SAMPLES]);
  // First CONTEXT_SIZE samples are the (still-zero) context; the rest is the frame verbatim.
  assert.ok(feeds.input.data.slice(0, CONTEXT_SIZE).every((v) => v === 0));
  assert.deepEqual(Array.from(feeds.input.data.slice(CONTEXT_SIZE)), Array.from(frame));
  assert.deepEqual(feeds.state.dims, STATE_SHAPE);
  assert.equal(feeds.sr.type, "int64");
  assert.deepEqual(feeds.sr.dims, []);
  assert.equal(feeds.sr.data[0], BigInt(SAMPLE_RATE));
});

test("the context window for the next call is the trailing CONTEXT_SIZE samples of this call's frame", async () => {
  const { ort, runCalls } = fakeOrt();
  const vad = createSileroVad({ ort, modelUrl: "model.onnx" });

  const firstFrame = new Float32Array(FRAME_SAMPLES);
  for (let i = 0; i < firstFrame.length; i += 1) firstFrame[i] = i;
  await vad.processFrame(firstFrame);
  await vad.processFrame(new Float32Array(FRAME_SAMPLES));

  const secondCallContext = runCalls[1].input.data.slice(0, CONTEXT_SIZE);
  const expectedContext = firstFrame.slice(firstFrame.length - CONTEXT_SIZE);
  assert.deepEqual(Array.from(secondCallContext), Array.from(expectedContext));
});

test("mutating the caller's frame array after processFrame() doesn't corrupt the saved context", async () => {
  const { ort, runCalls } = fakeOrt();
  const vad = createSileroVad({ ort, modelUrl: "model.onnx" });

  const frame = new Float32Array(FRAME_SAMPLES).fill(5);
  await vad.processFrame(frame);
  frame.fill(999); // simulates an AnalyserNode reusing its buffer on the next tick
  await vad.processFrame(new Float32Array(FRAME_SAMPLES));

  const secondCallContext = runCalls[1].input.data.slice(0, CONTEXT_SIZE);
  assert.ok(secondCallContext.every((v) => v === 5), "context must be a copy, not a live view into the caller's array");
});

test("recurrent state from stateN is fed back into the next processFrame call", async () => {
  const secondState = new Float32Array(256).fill(3);
  const { ort, runCalls } = fakeOrt({
    outputs: [
      { output: 0.1, stateN: secondState },
      { output: 0.9, stateN: new Float32Array(256).fill(9) },
    ],
  });
  const vad = createSileroVad({ ort, modelUrl: "model.onnx" });

  await vad.processFrame(new Float32Array(FRAME_SAMPLES));
  await vad.processFrame(new Float32Array(FRAME_SAMPLES));

  // The second call's `state` input must be exactly the first call's stateN output.
  assert.equal(runCalls[1].state.data, secondState);
});

test("reset() zeroes both the recurrent state and the context window", async () => {
  const { ort, runCalls } = fakeOrt({
    outputs: [{ output: 0.2, stateN: new Float32Array(256).fill(5) }],
  });
  const vad = createSileroVad({ ort, modelUrl: "model.onnx" });

  await vad.processFrame(new Float32Array(FRAME_SAMPLES).fill(1));
  vad.reset();
  await vad.processFrame(new Float32Array(FRAME_SAMPLES));

  const secondCallState = runCalls[1].state.data;
  assert.ok(secondCallState.every((value) => value === 0), "state should be all zeros after reset()");
  const secondCallContext = runCalls[1].input.data.slice(0, CONTEXT_SIZE);
  assert.ok(secondCallContext.every((value) => value === 0), "context should be all zeros after reset()");
});

test("the ONNX session is created once and reused across calls", async () => {
  const { ort, getCreateCalls } = fakeOrt();
  const vad = createSileroVad({ ort, modelUrl: "model.onnx" });

  await vad.processFrame(new Float32Array(FRAME_SAMPLES));
  await vad.processFrame(new Float32Array(FRAME_SAMPLES));

  assert.equal(getCreateCalls(), 1);
});

test("processFrame rejects a frame that isn't exactly FRAME_SAMPLES long", async () => {
  const { ort } = fakeOrt();
  const vad = createSileroVad({ ort, modelUrl: "model.onnx" });

  await assert.rejects(() => vad.processFrame(new Float32Array(FRAME_SAMPLES - 1)), /512/);
  await assert.rejects(() => vad.processFrame([0, 1, 2]), /Float32Array/);
});

test("isSpeech compares against the configured threshold, defaulting to 0.5", () => {
  const { ort } = fakeOrt();
  const defaultVad = createSileroVad({ ort, modelUrl: "model.onnx" });
  assert.equal(defaultVad.isSpeech(0.49), false);
  assert.equal(defaultVad.isSpeech(0.5), true);
  assert.equal(defaultVad.isSpeech(0.51), true);

  const strictVad = createSileroVad({ ort, modelUrl: "model.onnx", threshold: 0.8 });
  assert.equal(strictVad.isSpeech(0.7), false);
  assert.equal(strictVad.isSpeech(0.85), true);
});

test("createSileroVad requires an ort instance and a modelUrl", () => {
  assert.throws(() => createSileroVad({ modelUrl: "model.onnx" }), /ort/);
  assert.throws(() => createSileroVad({ ort: fakeOrt().ort }), /modelUrl/);
});
