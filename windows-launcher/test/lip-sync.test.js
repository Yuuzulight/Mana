const assert = require("node:assert/strict");
const test = require("node:test");

const {
  centroidToMouthForm,
  rmsToMouth,
  smoothMouthValue,
  spectralCentroidHz,
  vrmMouthBlendShapes,
} = require("../avatar/lip-sync");

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
