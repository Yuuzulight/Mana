const assert = require("node:assert/strict");
const test = require("node:test");

// live2d-logic.js is a classic-script IIFE for the context-isolated
// renderer, but it also assigns to module.exports when required from Node
// (see the file's own dual-export tail) -- so it's directly testable here,
// same as windows-launcher's copy. Only the functions newly ported from
// Project AIRI are covered; the rest of this file has no prior test
// coverage in desktop-client and porting that backfill is out of scope
// here.
const {
  centroidToMouthForm,
  DEFAULT_MOUTH_FORM_GAIN,
  DEFAULT_MOUTH_FORM_PARAM,
  normalizeAvatarConfig,
  pickIdleSaccadeTarget,
  randomSaccadeInterval,
  smoothTowardTarget,
  spectralCentroidHz,
} = require("../avatar/live2d-logic");

test("pickIdleSaccadeTarget opts out at amplitude 0 and stays in range otherwise", () => {
  assert.deepEqual(pickIdleSaccadeTarget(0), {
    angleX: 0,
    eyeBallX: 0,
    eyeBallY: 0,
  });

  const low = pickIdleSaccadeTarget(6, () => 0);
  assert.equal(low.angleX, -6);
  assert.equal(low.eyeBallX, -1);
  assert.equal(low.eyeBallY, -0.7);

  const high = pickIdleSaccadeTarget(6, () => 1);
  assert.equal(high.angleX, 6);
  assert.equal(high.eyeBallX, 1);
  assert.equal(high.eyeBallY, 0.7);
});

test("randomSaccadeInterval stays inside its weighted table's bounds and scales linearly", () => {
  const first = randomSaccadeInterval(() => 0);
  assert.ok(first >= 800 && first <= 1200);

  const last = randomSaccadeInterval(() => 0.999999);
  assert.ok(last >= 4000);

  const base = randomSaccadeInterval(() => 0, 1);
  const scaled = randomSaccadeInterval(() => 0, 2);
  assert.equal(scaled, base * 2);
  assert.equal(randomSaccadeInterval(() => 0, 0), base);
});

test("smoothTowardTarget settles toward target over time and holds steady at dt=0", () => {
  assert.equal(smoothTowardTarget(0, 1, 0, 500), 0);
  assert.ok(smoothTowardTarget(0, 1, 250, 500) > 0);
  assert.equal(smoothTowardTarget(0, 1, 5000, 500), 1);
});

test("spectralCentroidHz returns 0 for silence and weighs magnitude toward the loud bin", () => {
  const fftSize = 512;
  const sampleRate = 48000;
  const floorDb = -100;

  const silent = new Float32Array(fftSize / 2).fill(floorDb);
  assert.equal(spectralCentroidHz(silent, sampleRate, fftSize), 0);

  const high = new Float32Array(fftSize / 2).fill(floorDb);
  high[100] = -10;
  const centroid = spectralCentroidHz(high, sampleRate, fftSize);
  assert.ok(Math.abs(centroid - 100 * (sampleRate / fftSize)) < 1);
});

test("centroidToMouthForm treats 0 as the silence sentinel and maps low/high centroids to -1/+1", () => {
  assert.equal(centroidToMouthForm(0), 0);
  assert.equal(centroidToMouthForm(200), -1);
  assert.equal(centroidToMouthForm(3000), 1);
});

test("normalizeAvatarConfig fills in mouthForm defaults and honors overrides including 0", () => {
  const empty = normalizeAvatarConfig(null);
  assert.equal(empty.mouthFormParam, DEFAULT_MOUTH_FORM_PARAM);
  assert.equal(empty.mouthFormGain, DEFAULT_MOUTH_FORM_GAIN);

  const custom = normalizeAvatarConfig({
    mouthFormParam: "ParamCustomForm",
    mouthFormGain: 0,
  });
  assert.equal(custom.mouthFormParam, "ParamCustomForm");
  assert.equal(custom.mouthFormGain, 0);
});
