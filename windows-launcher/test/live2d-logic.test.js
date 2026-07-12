const assert = require("node:assert/strict");
const test = require("node:test");

const {
  augmentModelSettings,
  computeZoomFraming,
  DEFAULT_EYE_BLINK_PARAM_IDS,
  DEFAULT_ZOOM_FRACTIONS,
  expressionForState,
  findModelJson,
  fitModelToView,
  motionGroupForState,
  nextZoomLevel,
  rmsToMouth,
  smoothMouthValue,
} = require("../avatar/live2d-logic");

function makeFakeFs(tree) {
  // tree: { "C:\\dir": [{ name, dir }] }
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(tree, p),
    readdirSync: (p) =>
      (tree[p] || []).map((entry) => ({
        name: entry.name,
        isDirectory: () => Boolean(entry.dir),
      })),
  };
}

test("findModelJson locates a model3.json nested in subfolders", () => {
  const fakeFs = makeFakeFs({
    "C:\\model": [
      { name: "readme.txt" },
      { name: "Mana", dir: true },
    ],
    "C:\\model\\Mana": [
      { name: "mana.model3.json" },
      { name: "mana.moc3" },
    ],
  });
  assert.equal(
    findModelJson("C:\\model", fakeFs),
    "C:\\model\\Mana\\mana.model3.json",
  );
});

test("findModelJson returns null when the folder is missing or empty", () => {
  assert.equal(findModelJson("C:\\missing", makeFakeFs({})), null);
  assert.equal(
    findModelJson("C:\\model", makeFakeFs({ "C:\\model": [] })),
    null,
  );
});

test("rmsToMouth applies a noise floor and clamps to 1", () => {
  assert.equal(rmsToMouth(0), 0);
  assert.equal(rmsToMouth(0.009), 0);
  assert.equal(rmsToMouth(1), 1);
  const mid = rmsToMouth(0.06);
  assert.equal(mid > 0.3 && mid < 0.6, true);
});

test("rmsToMouth gain option scales openness for the same voice level", () => {
  // The launcher passes gain 18 (MANA_LIVE2D_MOUTH_GAIN) to double the
  // default openness; verify doubling holds below the clamp.
  const quiet = rmsToMouth(0.03);
  assert.equal(rmsToMouth(0.03, { gain: 18 }), Math.min(1, quiet * 2));
  // Loud speech saturates at fully open instead of overshooting.
  assert.equal(rmsToMouth(0.2, { gain: 18 }), 1);
});

test("smoothMouthValue opens fast and closes slowly", () => {
  const opening = smoothMouthValue(0, 1, 20);
  const closing = smoothMouthValue(1, 0, 20);
  assert.equal(opening > 1 - closing, true);
  // Converges when given plenty of time.
  assert.equal(smoothMouthValue(0, 1, 1000), 1);
});

test("motionGroupForState prefers matching groups and is case-insensitive", () => {
  assert.equal(motionGroupForState("idle", ["idle", "Talk"]), "idle");
  assert.equal(motionGroupForState("talking", ["Idle", "Talk"]), "Talk");
  assert.equal(motionGroupForState("excited", ["Idle", "happy"]), "happy");
  assert.equal(motionGroupForState("angry", ["Idle"]), null);
  assert.equal(motionGroupForState("unknown-state", ["Idle"]), "Idle");
});

test("sad state maps to its own motion/expression preferences", () => {
  assert.equal(motionGroupForState("sad", ["Idle", "Cry"]), "Cry");
  // Doesn't fall back to idle's "Idle"/"idle" names when no sad group exists.
  assert.equal(motionGroupForState("sad", ["Idle", "Talk"]), null);
  assert.equal(expressionForState("sad", ["angry", "cry"]), "cry");
});

test("disgusted state maps to a blank/white-eyes style expression", () => {
  assert.equal(
    expressionForState("disgusted", ["angry", "cry", "white-eyes"]),
    "white-eyes",
  );
  assert.equal(motionGroupForState("disgusted", ["Idle", "Talk"]), null);
});

test("augmentModelSettings registers loose VTS motions and expressions", () => {
  const settings = {
    Version: 3,
    FileReferences: { Moc: "mana.moc3", Textures: ["t.png"] },
  };
  const augmented = augmentModelSettings(
    settings,
    ["yaotou.motion3.json", "keshui.motion3.json"],
    ["angry.exp3.json", "cry.exp3.json"],
  );

  assert.deepEqual(Object.keys(augmented.FileReferences.Motions), [
    "yaotou",
    "keshui",
  ]);
  assert.deepEqual(augmented.FileReferences.Motions.yaotou, [
    { File: "yaotou.motion3.json" },
  ]);
  assert.deepEqual(augmented.FileReferences.Expressions, [
    { Name: "angry", File: "angry.exp3.json" },
    { Name: "cry", File: "cry.exp3.json" },
  ]);
  // Original settings object stays untouched.
  assert.equal(settings.FileReferences.Motions, undefined);
});

test("augmentModelSettings leaves registered motions and expressions alone", () => {
  const settings = {
    FileReferences: {
      Motions: { Idle: [{ File: "idle.motion3.json" }] },
      Expressions: [{ Name: "smile", File: "smile.exp3.json" }],
    },
  };
  const augmented = augmentModelSettings(
    settings,
    ["extra.motion3.json"],
    ["extra.exp3.json"],
  );
  assert.deepEqual(Object.keys(augmented.FileReferences.Motions), ["Idle"]);
  assert.equal(augmented.FileReferences.Expressions.length, 1);
});

test("augmentModelSettings backfills a blank EyeBlink group so the model blinks", () => {
  const settings = {
    Groups: [
      { Target: "Parameter", Name: "EyeBlink", Ids: [] },
      { Target: "Parameter", Name: "LipSync", Ids: [] },
    ],
  };
  const augmented = augmentModelSettings(settings);
  const eyeBlink = augmented.Groups.find((g) => g.Name === "EyeBlink");
  assert.deepEqual(eyeBlink.Ids, DEFAULT_EYE_BLINK_PARAM_IDS);
  // LipSync (handled by our own manual lip sync) is left untouched.
  assert.deepEqual(
    augmented.Groups.find((g) => g.Name === "LipSync").Ids,
    [],
  );
  // Original settings object stays untouched.
  assert.deepEqual(settings.Groups[0].Ids, []);
});

test("augmentModelSettings adds a missing EyeBlink group, respects an already-populated one, and honors overrides", () => {
  const noGroups = augmentModelSettings({});
  assert.deepEqual(
    noGroups.Groups.find((g) => g.Name === "EyeBlink").Ids,
    DEFAULT_EYE_BLINK_PARAM_IDS,
  );

  const alreadySet = augmentModelSettings({
    Groups: [{ Target: "Parameter", Name: "EyeBlink", Ids: ["CustomEye"] }],
  });
  assert.deepEqual(
    alreadySet.Groups.find((g) => g.Name === "EyeBlink").Ids,
    ["CustomEye"],
  );

  const customIds = augmentModelSettings({}, [], [], ["ParamEyeOpen"]);
  assert.deepEqual(
    customIds.Groups.find((g) => g.Name === "EyeBlink").Ids,
    ["ParamEyeOpen"],
  );

  const disabled = augmentModelSettings({}, [], [], []);
  assert.equal(
    (disabled.Groups || []).find((g) => g.Name === "EyeBlink"),
    undefined,
  );
});

test("expressionForState maps emotions to expressions case-insensitively", () => {
  assert.equal(expressionForState("angry", ["Angry", "cry"]), "Angry");
  assert.equal(expressionForState("excited", ["happy", "angry"]), "happy");
  assert.equal(expressionForState("talking", ["happy", "angry"]), null);
  assert.equal(expressionForState("idle", ["happy", "angry"]), null);
  assert.equal(expressionForState("angry", []), null);
});

test("state mapping overrides beat the built-in preferences", () => {
  const { parseStateMappingOverrides } = require("../avatar/live2d-logic");
  const overrides = parseStateMappingOverrides(
    '{"excited":"haoqi","angry":["yaotou","Angry"],"talking":"Scene1"}',
  );

  assert.equal(
    motionGroupForState("excited", ["haoqi", "Happy"], overrides),
    "haoqi",
  );
  assert.equal(
    motionGroupForState("angry", ["Scene1", "yaotou"], overrides),
    "yaotou",
  );
  // Falls back to built-in preferences when the override name is absent.
  assert.equal(
    motionGroupForState("angry", ["Shake"], overrides),
    "Shake",
  );
  assert.equal(
    expressionForState("excited", ["happy"], overrides),
    "happy",
  );

  // Bad JSON and non-object input degrade to no overrides.
  assert.deepEqual(parseStateMappingOverrides("not json"), {});
  assert.deepEqual(parseStateMappingOverrides('["array"]'), {});
  assert.deepEqual(parseStateMappingOverrides(undefined), {});
});

test("normalizeAvatarConfig validates mappings and random motions", () => {
  const {
    normalizeAvatarConfig,
    mergeStateMappings,
    nextRandomDelay,
  } = require("../avatar/live2d-logic");

  const config = normalizeAvatarConfig({
    stateMotions: { excited: "curious", idle: "sleepy" },
    stateExpressions: { idle: "hug-pillow" },
    randomMotions: [
      { group: "spirit", minIntervalMs: 120000, maxIntervalMs: 480000 },
      { minIntervalMs: 1 },
      { group: "tooFast", minIntervalMs: 10 },
    ],
  });

  assert.deepEqual(config.stateMotions, {
    excited: ["curious"],
    idle: ["sleepy"],
  });
  assert.deepEqual(config.stateExpressions, { idle: ["hug-pillow"] });
  assert.equal(config.randomMotions.length, 2);
  assert.deepEqual(config.randomMotions[0], {
    group: "spirit",
    minIntervalMs: 120000,
    maxIntervalMs: 480000,
    states: ["idle"],
  });
  // Intervals are clamped to a sane floor.
  assert.equal(config.randomMotions[1].minIntervalMs >= 5000, true);

  // Missing/invalid config degrades to safe defaults.
  const empty = normalizeAvatarConfig(null);
  assert.deepEqual(empty.stateMotions, {});
  assert.deepEqual(empty.randomMotions, []);

  // Env overrides come before config names.
  const merged = mergeStateMappings(
    { idle: ["Special"] },
    { idle: ["sleepy"], excited: ["curious"] },
  );
  assert.deepEqual(merged.idle, ["Special", "sleepy"]);
  assert.deepEqual(merged.excited, ["curious"]);

  // Random delays stay inside the configured range.
  assert.equal(nextRandomDelay(100, 200, () => 0), 100);
  assert.equal(nextRandomDelay(100, 200, () => 1), 200);
});

test("fitModelToView scales to fit and anchors to the bottom", () => {
  const fit = fitModelToView(1000, 2000, 234, 288);
  assert.equal(fit.scale, 288 / 2000);
  assert.equal(fit.y, 0);
  assert.equal(Math.round(fit.x * 100) / 100, (234 - 1000 * fit.scale) / 2);

  const wide = fitModelToView(2000, 1000, 234, 288);
  assert.equal(wide.scale, 234 / 2000);
  assert.equal(wide.y, 288 - 1000 * wide.scale);
});

test("computeZoomFraming 'full' matches fitModelToView exactly", () => {
  const fit = fitModelToView(1000, 2000, 234, 288);
  const zoomed = computeZoomFraming("full", 1000, 2000, 234, 288);
  assert.deepEqual(zoomed, fit);

  // Unknown levels fall back to "full" instead of throwing.
  assert.deepEqual(
    computeZoomFraming("nonsense", 1000, 2000, 234, 288),
    fit,
  );
});

test("computeZoomFraming crops tighter and scales up for waist/bust", () => {
  const full = computeZoomFraming("full", 1000, 2000, 234, 288);
  const waist = computeZoomFraming("waist", 1000, 2000, 234, 288);
  const bust = computeZoomFraming("bust", 1000, 2000, 234, 288);

  // Tighter crops need more scale to fill the same viewport height.
  assert.equal(waist.scale > full.scale, true);
  assert.equal(bust.scale > waist.scale, true);

  // Framing stays horizontally centered.
  assert.equal(waist.x, (234 - 1000 * waist.scale) / 2);
  assert.equal(bust.x, (234 - 1000 * bust.scale) / 2);

  // Anchored near the top (small margin) rather than the bottom.
  assert.equal(waist.y, 288 * 0.04);
  assert.equal(bust.y, 288 * 0.04);
});

test("computeZoomFraming honors custom per-model fractions", () => {
  const custom = computeZoomFraming("waist", 1000, 2000, 234, 288, {
    ...DEFAULT_ZOOM_FRACTIONS,
    waist: 0.9,
  });
  const defaultWaist = computeZoomFraming("waist", 1000, 2000, 234, 288);
  // A larger visible fraction means less scale is needed.
  assert.equal(custom.scale < defaultWaist.scale, true);
});

test("nextZoomLevel cycles full -> waist -> bust -> full", () => {
  assert.equal(nextZoomLevel("full"), "waist");
  assert.equal(nextZoomLevel("waist"), "bust");
  assert.equal(nextZoomLevel("bust"), "full");
  // Unknown input treated as before "full", so it advances to "full".
  assert.equal(nextZoomLevel("unknown"), "full");
});

test("normalizeAvatarConfig fills in default zoom fractions and allows overrides", () => {
  const { normalizeAvatarConfig } = require("../avatar/live2d-logic");

  const empty = normalizeAvatarConfig(null);
  assert.deepEqual(empty.zoomFractions, DEFAULT_ZOOM_FRACTIONS);

  const custom = normalizeAvatarConfig({
    zoomFractions: { bust: 0.2 },
  });
  assert.equal(custom.zoomFractions.bust, 0.2);
  assert.equal(custom.zoomFractions.waist, DEFAULT_ZOOM_FRACTIONS.waist);
  assert.equal(custom.zoomFractions.full, DEFAULT_ZOOM_FRACTIONS.full);
});
