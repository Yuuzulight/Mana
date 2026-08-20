// Wraps Silero VAD's streaming ONNX model for live speech/silence
// classification in recordUntilSilence() (see issue #135). `ort` is
// injected (an onnxruntime-web instance, or a fake in tests) rather than
// required internally -- loaded via a classic <script> tag in index.html,
// same as pixi.js/pixi-live2d-display, since Electron's nodeIntegration
// renderer would otherwise resolve require("onnxruntime-web") to its
// Node-native export condition instead of the browser WASM build.
//
// Model I/O contract (confirmed against the actual ONNX graph AND the
// official Python wrapper (utils_vad.py's OnnxWrapper) -- not just docs,
// since a wrong-shaped `input` doesn't error (dynamic axis) but silently
// produces near-zero probability for real speech):
//   inputs:  input float32 [1, CONTEXT_SIZE + FRAME_SAMPLES] @ 16kHz --
//              the model expects the last CONTEXT_SIZE samples of the
//              *previous* chunk prepended to the new FRAME_SAMPLES chunk,
//              not just the new chunk alone (starts as zeros),
//            state float32 [2, 1, 128] (recurrent, persists across calls),
//            sr int64 scalar (16000)
//   outputs: output float32 [1, 1] speech probability (0-1),
//            stateN float32 [2, 1, 128] (feed back in as `state` next call)
//
// Unlike windows-launcher (nodeIntegration:true, so its renderer.js can
// require() this directly), desktop-client's renderer runs with
// nodeIntegration:false/contextIsolation:true (see main.js), so this file
// is also loaded as a classic <script> tag and needs to attach itself to
// `window` -- same dual module.exports/window pattern already used by
// streaming-chunk-queue.js in this directory. Wrapped in an IIFE so the
// top-level consts below don't leak into the shared global scope.
(function () {

const FRAME_SAMPLES = 512;
const CONTEXT_SIZE = 64;
const SAMPLE_RATE = 16000;
const STATE_SIZE = 2 * 1 * 128;
const STATE_SHAPE = [2, 1, 128];
const DEFAULT_THRESHOLD = 0.5;

function createSileroVad({ ort, modelUrl, threshold = DEFAULT_THRESHOLD } = {}) {
  if (!ort) {
    throw new Error("createSileroVad requires an onnxruntime-web `ort` instance");
  }
  if (!modelUrl) {
    throw new Error("createSileroVad requires modelUrl (path to silero_vad.onnx)");
  }

  let sessionPromise = null;
  let state = new Float32Array(STATE_SIZE);
  let context = new Float32Array(CONTEXT_SIZE);

  function load() {
    if (!sessionPromise) {
      sessionPromise = ort.InferenceSession.create(modelUrl);
    }
    return sessionPromise;
  }

  // New utterance: neither the recurrent state nor the leading context
  // window should carry over speech from a previous, unrelated recording.
  function reset() {
    state = new Float32Array(STATE_SIZE);
    context = new Float32Array(CONTEXT_SIZE);
  }

  async function processFrame(frame) {
    if (!(frame instanceof Float32Array) || frame.length !== FRAME_SAMPLES) {
      throw new Error(
        `processFrame expects a Float32Array of exactly ${FRAME_SAMPLES} samples at ${SAMPLE_RATE}Hz, got ${frame && frame.length}`,
      );
    }
    const session = await load();
    const input = new Float32Array(CONTEXT_SIZE + FRAME_SAMPLES);
    input.set(context, 0);
    input.set(frame, CONTEXT_SIZE);

    const feeds = {
      input: new ort.Tensor("float32", input, [1, CONTEXT_SIZE + FRAME_SAMPLES]),
      state: new ort.Tensor("float32", state, STATE_SHAPE),
      sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
    };
    const results = await session.run(feeds);
    state = results.stateN.data;
    // Copied (not a view) -- `frame` may be a subarray into a buffer the
    // caller reuses (e.g. an AnalyserNode's sample array) on its next tick.
    context = input.slice(input.length - CONTEXT_SIZE);
    return results.output.data[0];
  }

  function isSpeech(probability) {
    return probability >= threshold;
  }

  return { processFrame, reset, isSpeech, load };
}

const exportsObj = {
  createSileroVad,
  FRAME_SAMPLES,
  CONTEXT_SIZE,
  SAMPLE_RATE,
  STATE_SHAPE,
  DEFAULT_THRESHOLD,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = exportsObj;
}
if (typeof window !== "undefined") {
  window.ManaSileroVad = exportsObj;
}

})();
