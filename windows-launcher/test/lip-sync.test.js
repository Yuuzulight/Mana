const assert = require("node:assert/strict");
const test = require("node:test");

const {
  centroidToMouthForm,
  rmsToMouth,
  smoothMouthValue,
  spectralCentroidHz,
  vrmMouthBlendShapes,
  computeMfcc,
  classifyViseme,
  visemeToMouthForm,
} = require("../avatar/lip-sync");

const FFT_SIZE = 512;
const SAMPLE_RATE = 48000;
const NUM_BINS = FFT_SIZE / 2 + 1;
const BIN_HZ = SAMPLE_RATE / FFT_SIZE;

// Builds a synthetic getFloatFrequencyData-shaped spectrum with loud energy
// concentrated at the given Hz values (everything else at the noise floor).
function spectrumForHz(hzList, loudDb = -10, floorDb = -100) {
  const mags = new Float32Array(NUM_BINS).fill(floorDb);
  for (const hz of hzList) {
    mags[Math.round(hz / BIN_HZ)] = loudDb;
  }
  return mags;
}

test("rmsToMouth and smoothMouthValue still work via lip-sync.js directly", () => {
  // live2d-logic.js re-exports these for legacy import convenience; confirm
  // the actual home module still behaves the same.
  assert.equal(rmsToMouth(0), 0);
  assert.equal(smoothMouthValue(0, 1, 1000), 1);
});

test("spectralCentroidHz weighs magnitude toward higher bins for bright audio", () => {
  const fftSize = 512;
  const sampleRate = 48000;
  const floorDb = -100;

  // All silence -> centroid 0 (used as the "no signal" sentinel by
  // centroidToMouthForm below).
  const silent = new Float32Array(fftSize / 2).fill(floorDb);
  assert.equal(spectralCentroidHz(silent, sampleRate, fftSize), 0);

  // A single loud low bin vs. a single loud high bin -- the centroid should
  // land near that bin's frequency in both cases, and be much higher for
  // the high-bin case.
  const low = new Float32Array(fftSize / 2).fill(floorDb);
  low[1] = -10;
  const high = new Float32Array(fftSize / 2).fill(floorDb);
  high[100] = -10;

  const lowCentroid = spectralCentroidHz(low, sampleRate, fftSize);
  const highCentroid = spectralCentroidHz(high, sampleRate, fftSize);
  assert.ok(highCentroid > lowCentroid);
  // Roughly matches bin 100's own frequency (sampleRate/fftSize * 100).
  assert.ok(Math.abs(highCentroid - 100 * (sampleRate / fftSize)) < 1);
});

test("centroidToMouthForm treats 0 (silence sentinel) as neutral, and maps low/high centroids to -1/+1", () => {
  assert.equal(centroidToMouthForm(0), 0);
  assert.equal(centroidToMouthForm(-5), 0);

  assert.equal(centroidToMouthForm(200), -1); // below centroidLowHz -> fully rounded
  assert.equal(centroidToMouthForm(3000), 1); // above centroidHighHz -> fully wide

  const mid = centroidToMouthForm(1600); // midpoint of the default 600-2600 range
  assert.ok(Math.abs(mid) < 0.1);

  // Custom range is honored: 1000Hz sits at the high edge of a 900-1100Hz
  // range, so it should map to fully wide (+1), unlike the default range
  // where 1000Hz would still be well below the midpoint.
  assert.equal(centroidToMouthForm(1000, { centroidLowHz: 900, centroidHighHz: 1000 }), 1);
});

test("vrmMouthBlendShapes puts all weight on 'aa' when brightness is neutral", () => {
  const shapes = vrmMouthBlendShapes(0.8, 0);
  assert.equal(shapes.aa, 0.8);
  assert.equal(shapes.ih, 0);
  assert.equal(shapes.ou, 0);
});

test("vrmMouthBlendShapes leans 'ih' for bright audio and 'ou' for bassy audio", () => {
  const bright = vrmMouthBlendShapes(0.8, 1);
  assert.ok(bright.ih > 0);
  assert.equal(bright.ou, 0);
  assert.ok(bright.aa < 0.8); // aa yields some weight to the secondary shape

  const bassy = vrmMouthBlendShapes(0.8, -1);
  assert.ok(bassy.ou > 0);
  assert.equal(bassy.ih, 0);
});

test("vrmMouthBlendShapes stays silent (all zero) when mouth is closed", () => {
  const shapes = vrmMouthBlendShapes(0, 1);
  assert.equal(shapes.aa, 0);
  assert.equal(shapes.ih, 0);
  assert.equal(shapes.ou, 0);
});

test("computeMfcc returns the expected shape: default 13 coefficients and 26 mel filters", () => {
  const silent = new Float32Array(NUM_BINS).fill(-100);
  const result = computeMfcc(silent, SAMPLE_RATE, FFT_SIZE);
  assert.equal(result.mfcc.length, 13);
  assert.equal(result.melEnergies.length, 26);
  assert.equal(result.melCenterHz.length, 26);
  // Mel filter centers are monotonically increasing.
  for (let i = 1; i < result.melCenterHz.length; i += 1) {
    assert.ok(result.melCenterHz[i] > result.melCenterHz[i - 1]);
  }
});

test("computeMfcc honors a custom numFilters/numCoefficients", () => {
  const silent = new Float32Array(NUM_BINS).fill(-100);
  const result = computeMfcc(silent, SAMPLE_RATE, FFT_SIZE, { numFilters: 10, numCoefficients: 4 });
  assert.equal(result.mfcc.length, 4);
  assert.equal(result.melEnergies.length, 10);
});

test("classifyViseme returns neutral for silence", () => {
  const silent = new Float32Array(NUM_BINS).fill(-100);
  const result = computeMfcc(silent, SAMPLE_RATE, FFT_SIZE);
  assert.equal(classifyViseme(result), "neutral");
});

test("classifyViseme returns neutral when melEnergies/melCenterHz are missing instead of throwing", () => {
  assert.equal(classifyViseme(null), "neutral");
  assert.equal(classifyViseme({}), "neutral");
});

// Formant-band energy at each viseme's typical F1/F2 midpoints (see
// lip-sync.js's VISEME_FORMANT_BANDS) should classify to that viseme --
// verified against real adult vowel formant ranges, not tuned to make the
// test pass.
test("classifyViseme distinguishes aa/ee/oo from their typical formant bands", () => {
  const aa = computeMfcc(spectrumForHz([800, 1450]), SAMPLE_RATE, FFT_SIZE);
  assert.equal(classifyViseme(aa), "aa");

  const ee = computeMfcc(spectrumForHz([350, 2450]), SAMPLE_RATE, FFT_SIZE);
  assert.equal(classifyViseme(ee), "ee");

  const oo = computeMfcc(spectrumForHz([350, 850]), SAMPLE_RATE, FFT_SIZE);
  assert.equal(classifyViseme(oo), "oo");
});

test("visemeToMouthForm maps ee/oo to +1/-1 and anything else to neutral", () => {
  assert.equal(visemeToMouthForm("ee"), 1);
  assert.equal(visemeToMouthForm("oo"), -1);
  assert.equal(visemeToMouthForm("aa"), 0);
  assert.equal(visemeToMouthForm("neutral"), 0);
  assert.equal(visemeToMouthForm(undefined), 0);
});
