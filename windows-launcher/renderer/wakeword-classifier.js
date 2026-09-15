// Acoustic pre-filter for wake-word detection (#342): mirrors
// silero-vad.js's factory/injected-`ort` pattern, but chains three ONNX
// sessions instead of one, exactly as openWakeWord's own Python
// AudioFeatures class does. Ported from, and verified against, the real
// models' actual input/output shapes (confirmed via onnxruntime's own
// introspection plus real numeric Python runs before writing a line of
// this file -- see windows-native-launcher/WakeWordClassifier.cs's
// header comment for the full verification this was ported from, not
// re-derived independently):
//
//   raw 16-bit PCM audio (1, samples)
//     -> melspectrogram.onnx -> (1, 1, time, 32), squeezed to (time, 32),
//        transformed by x/10+2 to match the original TF implementation
//     -> a sliding window of 76 mel-frames, stepped by 8, over the time
//        axis -- each full window becomes one (76, 32, 1) input
//     -> embedding_model.onnx, batched over all windows -> (windows, 1, 1, 96),
//        squeezed to (windows, 96)
//     -> mana.onnx (ours, trained in tools/wakeword-training/) -> (1, 1)
//        sigmoid score, when windows === EMBEDDING_FRAMES (16)
//
// melspectrogram.onnx/embedding_model.onnx are openWakeWord's own
// third-party pretrained models (fetched at build/install time, same
// convention as silero_vad.onnx -- see scripts/fetch-silero-vad.js's
// sibling for these). mana.onnx is ours, committed directly since nothing
// else hosts it.
const SAMPLE_RATE = 16000;

// The fixed embedding-frame window mana.onnx was trained on -- confirmed
// empirically in tools/wakeword-training/train_model.py, not assumed.
const EMBEDDING_FRAMES = 16;

// 2.0 seconds at 16kHz -- the audio length that produces exactly
// EMBEDDING_FRAMES embedding windows against the real ONNX models.
const WINDOW_SAMPLES = SAMPLE_RATE * 2;

const MEL_WINDOW_SIZE = 76;
const MEL_STEP_SIZE = 8;
const MEL_BINS = 32;
const EMBEDDING_DIM = 96;

// See tools/wakeword-training/README.md's measured false-positive-rate-
// by-threshold table: 7.2/hour at 0.5, 1.0/hour at 0.99. 0.9 is a
// reasonable middle ground for a v1 model.
const DEFAULT_THRESHOLD = 0.9;

function createWakeWordClassifier({
  ort,
  melspecModelUrl,
  embeddingModelUrl,
  classifierModelUrl,
  threshold = DEFAULT_THRESHOLD,
} = {}) {
  if (!ort) {
    throw new Error("createWakeWordClassifier requires an onnxruntime-web `ort` instance");
  }
  if (!melspecModelUrl || !embeddingModelUrl || !classifierModelUrl) {
    throw new Error(
      "createWakeWordClassifier requires melspecModelUrl, embeddingModelUrl, and classifierModelUrl",
    );
  }

  let sessionsPromise = null;

  function load() {
    if (!sessionsPromise) {
      sessionsPromise = Promise.all([
        ort.InferenceSession.create(melspecModelUrl),
        ort.InferenceSession.create(embeddingModelUrl),
        ort.InferenceSession.create(classifierModelUrl),
      ]);
    }
    return sessionsPromise;
  }

  // samples: Int16Array at 16kHz, any length. Right-aligned/padded to
  // exactly WINDOW_SAMPLES to match how the training clips were aligned
  // (the wake phrase ends near the window's end, with a small start
  // jitter -- see train_model.py's `starts` calculation) -- mana.onnx
  // only ever saw fixed 2.0s windows during training.
  function alignToWindow(samples) {
    if (samples.length === WINDOW_SAMPLES) {
      return samples;
    }
    const aligned = new Int16Array(WINDOW_SAMPLES);
    if (samples.length > WINDOW_SAMPLES) {
      // Rightmost WINDOW_SAMPLES -- matches training's end-aligned
      // convention when the real segment ran longer than the model's
      // training window.
      aligned.set(samples.subarray(samples.length - WINDOW_SAMPLES));
    } else {
      // Left-pad with silence so the (shorter) real segment still ends
      // at the window's end, same alignment as training.
      aligned.set(samples, WINDOW_SAMPLES - samples.length);
    }
    return aligned;
  }

  // Raw int16 samples cast to float32, NOT normalized to [-1,1] -- this
  // model's own training/inference convention (confirmed against
  // openwakeword.utils.AudioFeatures._get_melspectrogram).
  async function melspectrogram(session, samples) {
    const floatSamples = Float32Array.from(samples);
    const feeds = { input: new ort.Tensor("float32", floatSamples, [1, floatSamples.length]) };
    const results = await session.run(feeds);
    const output = results.output;

    // Real shape confirmed as (1, 1, time, 32) -- the two leading size-1
    // dims contribute nothing to a flat-array stride, so a
    // flat[t * MEL_BINS + b] index is equivalent to squeezing them away
    // first, without needing to actually reshape the array.
    const dims = output.dims;
    const frames = dims[dims.length - 2];
    const flat = output.data;
    const mel = new Float32Array(frames * MEL_BINS);
    for (let t = 0; t < frames; t += 1) {
      for (let b = 0; b < MEL_BINS; b += 1) {
        // The fixed transform openWakeWord applies to match the
        // original TensorFlow implementation's scale.
        mel[t * MEL_BINS + b] = flat[t * MEL_BINS + b] / 10 + 2;
      }
    }
    return { mel, frames };
  }

  // Slides a MEL_WINDOW_SIZE-frame window over the mel spectrogram's time
  // axis, stepped by MEL_STEP_SIZE, dropping any short trailing window --
  // matches openwakeword.utils.AudioFeatures._get_embeddings exactly.
  async function embed(session, mel, frames) {
    const windowStarts = [];
    for (let i = 0; i + MEL_WINDOW_SIZE <= frames; i += MEL_STEP_SIZE) {
      windowStarts.push(i);
    }

    const windowCount = windowStarts.length;
    const batchData = new Float32Array(windowCount * MEL_WINDOW_SIZE * MEL_BINS);
    for (let w = 0; w < windowCount; w += 1) {
      const start = windowStarts[w];
      for (let t = 0; t < MEL_WINDOW_SIZE; t += 1) {
        for (let b = 0; b < MEL_BINS; b += 1) {
          batchData[w * MEL_WINDOW_SIZE * MEL_BINS + t * MEL_BINS + b] = mel[(start + t) * MEL_BINS + b];
        }
      }
    }

    const feeds = {
      input_1: new ort.Tensor("float32", batchData, [windowCount, MEL_WINDOW_SIZE, MEL_BINS, 1]),
    };
    const results = await session.run(feeds);
    const output = results.conv2d_19;
    const flat = output.data;

    // Real shape confirmed as (windows, 1, 1, 96) -- same stride-through-
    // size-1-dims reasoning as melspectrogram() above.
    const embeddings = new Float32Array(windowCount * EMBEDDING_DIM);
    for (let w = 0; w < windowCount; w += 1) {
      for (let d = 0; d < EMBEDDING_DIM; d += 1) {
        embeddings[w * EMBEDDING_DIM + d] = flat[w * EMBEDDING_DIM + d];
      }
    }
    return { embeddings, windowCount };
  }

  async function classify(session, embeddings, frames) {
    const feeds = { input: new ort.Tensor("float32", embeddings, [1, frames, EMBEDDING_DIM]) };
    const results = await session.run(feeds);
    return results.output.data[0];
  }

  async function score(samples) {
    const [melspecSession, embeddingSession, classifierSession] = await load();
    const aligned = alignToWindow(samples);
    const { mel, frames } = await melspectrogram(melspecSession, aligned);
    const { embeddings, windowCount } = await embed(embeddingSession, mel, frames);

    if (windowCount !== EMBEDDING_FRAMES) {
      // A 2.0s input should always produce exactly 16 windows against
      // these specific models -- if it doesn't, something upstream
      // changed shape in a way this port didn't anticipate. Fail loudly
      // rather than feed a wrong-shaped tensor into the classifier and
      // get a meaningless score back.
      throw new Error(
        `Expected ${EMBEDDING_FRAMES} embedding windows from a ${WINDOW_SAMPLES}-sample input, got ${windowCount}.`,
      );
    }

    return classify(classifierSession, embeddings, windowCount);
  }

  async function mayContainWakeWord(samples) {
    return (await score(samples)) >= threshold;
  }

  return { load, score, mayContainWakeWord, alignToWindow };
}

module.exports = {
  createWakeWordClassifier,
  SAMPLE_RATE,
  EMBEDDING_FRAMES,
  WINDOW_SAMPLES,
  DEFAULT_THRESHOLD,
};
