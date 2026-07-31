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
  classifyViseme,
  computeMfcc,
  DEFAULT_MOUTH_FORM_GAIN,
  DEFAULT_MOUTH_FORM_PARAM,
  expressionForState,
  normalizeAvatarConfig,
  pickIdleSaccadeTarget,
  randomSaccadeInterval,
  smoothTowardTarget,
  spectralCentroidHz,
  validateModelReferences,
  visemeToMouthForm,
} = require("../avatar/live2d-logic");

const FFT_SIZE = 512;
const SAMPLE_RATE = 48000;
const NUM_BINS = FFT_SIZE / 2 + 1;
const BIN_HZ = SAMPLE_RATE / FFT_SIZE;

function spectrumForHz(hzList, loudDb = -10, floorDb = -100) {
  const mags = new Float32Array(NUM_BINS).fill(floorDb);
  for (const hz of hzList) {
    mags[Math.round(hz / BIN_HZ)] = loudDb;
  }
  return mags;
}

function fakeFsWithFiles(existingPaths) {
  const set = new Set(existingPaths);
  return { existsSync: (p) => set.has(p) };
}

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

// Issue #275: MFCC-based viseme classification, duplicated here from
// windows-launcher/avatar/lip-sync.js per this file's own existing
// duplication convention (see the top-of-file note on module.exports).
test("computeMfcc returns the expected shape and neutral classifyViseme for silence", () => {
  const silent = new Float32Array(NUM_BINS).fill(-100);
  const result = computeMfcc(silent, SAMPLE_RATE, FFT_SIZE);
  assert.equal(result.mfcc.length, 13);
  assert.equal(result.melEnergies.length, 26);
  assert.equal(classifyViseme(result), "neutral");
});

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
  assert.equal(visemeToMouthForm(undefined), 0);
});

test("validateModelReferences distinguishes fatal (Moc/Texture) from non-fatal missing files", () => {
  const settings = {
    FileReferences: {
      Moc: "model.moc3",
      Textures: ["tex/00.png"],
      Physics: "missing.physics3.json",
      Expressions: [{ Name: "sad", File: "missing.exp3.json" }],
    },
  };
  const fsLike = fakeFsWithFiles([
    "C:\\model\\model.moc3",
    "C:\\model\\tex\\00.png",
  ]);
  const result = validateModelReferences(settings, "C:\\model", fsLike);
  assert.equal(result.valid, true); // only non-fatal entries missing
  assert.equal(result.missing.length, 2);
  assert.ok(result.missing.every((entry) => !entry.fatal));

  const brokenMoc = validateModelReferences(
    { FileReferences: { Moc: "missing.moc3" } },
    "C:\\model",
    fakeFsWithFiles([]),
  );
  assert.equal(brokenMoc.valid, false);
  assert.equal(brokenMoc.missing[0].fatal, true);
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

test("expressionForState tries preferredName first, before state-based preferences", () => {
  // Issue #253: an LLM-chosen expression wins over the automatic
  // state-based guess when the model's name matches something the loaded
  // model actually has.
  assert.equal(
    expressionForState("excited", ["happy", "wink"], null, "wink"),
    "wink",
  );
  assert.equal(
    expressionForState("excited", ["Smirk"], null, "smirk"),
    "Smirk",
  );
});

test("expressionForState falls through to state-based preferences when preferredName doesn't match anything", () => {
  // An invalid/unrecognized expression name is silently ignored, exactly
  // as if the tool had never been called -- no separate validation layer.
  assert.equal(
    expressionForState("excited", ["happy", "joy"], null, "not-a-real-expression"),
    "happy",
  );
  assert.equal(expressionForState("idle", ["happy"], null, "nonexistent"), null);
});
