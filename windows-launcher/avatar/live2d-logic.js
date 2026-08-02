// Pure helpers for the Live2D avatar window. Kept DOM- and PIXI-free so the
// launcher tests can cover them directly.

// Finds the lexicographically first .model3.json under rootDir (recursive),
// or null. Sorted so the pick stays deterministic when several models exist.
function findModelJson(rootDir, fsLike) {
  const matches = [];
  try {
    if (!rootDir || !fsLike.existsSync(rootDir)) {
      return null;
    }
    const pending = [rootDir];
    while (pending.length) {
      const dir = pending.pop();
      const entries = fsLike.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = `${dir}\\${entry.name}`.replace(/[\\/]+/g, "\\");
        if (entry.isDirectory()) {
          pending.push(fullPath);
          continue;
        }
        if (entry.name.toLowerCase().endsWith(".model3.json")) {
          matches.push(fullPath);
        }
      }
    }
  } catch (e) {
    // fall through
  }
  matches.sort();
  return matches[0] || null;
}

// Checks that every file model3.json's FileReferences actually points to a
// real file on disk, so a broken/incomplete model produces a clear "here's
// what's missing" list instead of a silent Live2DModel.from() failure deep
// inside pixi-live2d-display. A portable subset of Project AIRI's
// live2d-validator.ts -- AIRI's version also checks zip-internal concerns
// (basename collisions, case-sensitivity from a zip's stored paths) that
// don't apply here, since Mana loads a real folder Electron's main process
// already has direct filesystem access to, not an uploaded zip.
//
// `settings` should be model3.json's contents AFTER augmentModelSettings
// has run, so VTube-Studio-style loose motion/expression files are already
// registered under FileReferences and get checked too, not just files the
// model author explicitly listed. `modelDir` is the directory containing
// the .model3.json itself (every FileReferences path is relative to it).
//
// Moc and Textures are "fatal" (rendering can't proceed without them);
// Physics/Pose/DisplayInfo and individual Expression/Motion files are not
// (that one feature just won't work, the rest of the model still renders).
function validateModelReferences(settings, modelDir, fsLike) {
  const missing = [];

  function resolve(relPath) {
    return `${modelDir}\\${relPath}`.replace(/[\\/]+/g, "\\");
  }

  function check(type, name, file, fatal) {
    if (!file) {
      return;
    }
    const resolvedPath = resolve(file);
    if (!fsLike.existsSync(resolvedPath)) {
      missing.push({ type, name: name || null, file, resolvedPath, fatal });
    }
  }

  const refs = (settings && settings.FileReferences) || {};

  check("Moc", null, refs.Moc, true);
  (Array.isArray(refs.Textures) ? refs.Textures : []).forEach((file) =>
    check("Texture", null, file, true),
  );
  check("Physics", null, refs.Physics, false);
  check("Pose", null, refs.Pose, false);
  check("DisplayInfo", null, refs.DisplayInfo, false);

  (Array.isArray(refs.Expressions) ? refs.Expressions : []).forEach(
    (expression) => {
      check(
        "Expression",
        expression && expression.Name,
        expression && expression.File,
        false,
      );
    },
  );

  const motionGroups =
    refs.Motions && typeof refs.Motions === "object" ? refs.Motions : {};
  for (const [group, motions] of Object.entries(motionGroups)) {
    (Array.isArray(motions) ? motions : []).forEach((motion) => {
      check("Motion", group, motion && motion.File, false);
    });
  }

  return {
    valid: !missing.some((entry) => entry.fatal),
    missing,
  };
}

function motionOrExpressionStem(file) {
  return String(file)
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/\.(motion3|exp3)\.json$/i, "");
}

// Standard Cubism 4 eye-open parameter names. Some model exports (e.g. from
// VTube Studio) ship a "EyeBlink" parameter group in model3.json with no
// Ids in it, which leaves pixi-live2d-display's automatic blink manager
// with nothing to drive — the model just never blinks on its own outside
// of whatever a motion clip animates. Fill the group in with the standard
// names when it's missing/empty so the SDK's built-in blink loop
// (randomized interval, natural close/open timing) takes over; harmless if
// a model genuinely doesn't have these parameters (unknown ids are a no-op).
const DEFAULT_EYE_BLINK_PARAM_IDS = ["ParamEyeLOpen", "ParamEyeROpen"];

// Standard Cubism 4 names for the eye-smile squint curve and eyebrow
// height/angle. Used to keep the iris visually constant-sized outside of
// idle (see live2d-avatar.js) — neutralizing these stops a motion's own
// squint or brow animation from covering part of the iris. Overridable per
// model via MANA_LIVE2D_SMILE_PARAMS / MANA_LIVE2D_BROW_PARAMS in case a
// model uses non-standard ids; unknown ids are a harmless no-op, so leaving
// the defaults in place is safe even for a model that lacks them entirely.
const DEFAULT_SMILE_PARAM_IDS = ["ParamEyeLSmile", "ParamEyeRSmile"];
const DEFAULT_BROW_PARAM_IDS = [
  "ParamBrowLY",
  "ParamBrowRY",
  "ParamBrowLAngle",
  "ParamBrowRAngle",
];

// Parses a comma-separated env var into a trimmed, non-empty parameter id
// list, falling back to `defaults` when the var is unset. An explicit empty
// string opts out entirely (returns []) — the same empty-disables
// convention every MANA_LIVE2D_*_PARAMS var uses.
function parseParamIdList(value, defaults) {
  if (value === undefined) {
    return defaults;
  }
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

// Hardcoded fallback defaults for the tuning knobs below, used when neither
// mana-avatar.json nor an env var sets them.
const DEFAULT_MOUTH_PARAM = "ParamMouthOpenY";
const DEFAULT_MOUTH_GAIN = 18;
// Varies mouth *shape* (not just openness) with the voice's spectral
// brightness -- see lip-sync.js's centroidToMouthForm. 0.6 keeps the swing
// inside a typical Cubism ParamMouthForm range (-1..1) without looking
// exaggerated; 0 opts out entirely for a model whose mouth-form curve is
// better left to its own motions/expressions.
const DEFAULT_MOUTH_FORM_PARAM = "ParamMouthForm";
const DEFAULT_MOUTH_FORM_GAIN = 0.6;
const DEFAULT_EYE_OPEN_SCALE = 1.5;
const DEFAULT_IDLE_TILT_DEG = 16;
const DEFAULT_IDLE_MAX_PITCH_DEG = 8;
// Subtle idle "looking around" drift (head + eyes), separate from the
// sleepy idle-tilt above -- gives idle some life beyond the motion clip
// alone. 0 opts out for a model whose own idle motion already covers this.
const DEFAULT_IDLE_GAZE_DEG = 6;
const DEFAULT_IDLE_GAZE_PERIOD_MS = 9000;

// VTube Studio exports usually ship motions and expressions as loose files
// without registering them in model3.json. Register them so the avatar can
// actually play them; already-registered models are left untouched. Also
// backfills a blank EyeBlink parameter group (see above).
function augmentModelSettings(
  settings,
  looseMotionFiles = [],
  looseExpressionFiles = [],
  eyeBlinkParamIds = DEFAULT_EYE_BLINK_PARAM_IDS,
) {
  const augmented = structuredClone(settings || {});
  augmented.FileReferences = augmented.FileReferences || {};
  const refs = augmented.FileReferences;

  const hasMotions =
    refs.Motions && Object.keys(refs.Motions).length > 0;
  if (!hasMotions && looseMotionFiles.length) {
    const groups = {};
    for (const file of looseMotionFiles) {
      groups[motionOrExpressionStem(file)] = [{ File: file }];
    }
    refs.Motions = groups;
  }

  const hasExpressions =
    Array.isArray(refs.Expressions) && refs.Expressions.length > 0;
  if (!hasExpressions && looseExpressionFiles.length) {
    refs.Expressions = looseExpressionFiles.map((file) => ({
      Name: motionOrExpressionStem(file),
      File: file,
    }));
  }

  if (eyeBlinkParamIds && eyeBlinkParamIds.length) {
    augmented.Groups = Array.isArray(augmented.Groups) ? augmented.Groups : [];
    let eyeBlinkGroup = augmented.Groups.find(
      (group) => group && group.Name === "EyeBlink",
    );
    if (!eyeBlinkGroup) {
      eyeBlinkGroup = { Target: "Parameter", Name: "EyeBlink", Ids: [] };
      augmented.Groups.push(eyeBlinkGroup);
    }
    if (!Array.isArray(eyeBlinkGroup.Ids) || eyeBlinkGroup.Ids.length === 0) {
      eyeBlinkGroup.Ids = eyeBlinkParamIds.slice();
    }
  }

  return augmented;
}

// Preferred Live2D expressions per avatar state. Empty means "reset to the
// model's default face".
const STATE_EXPRESSION_PREFERENCES = {
  idle: [],
  talking: [],
  excited: ["happy", "joy", "smile", "excited", "fun"],
  angry: ["angry", "mad", "grumpy", "annoyed"],
  sad: ["sad", "cry", "sniff", "tears", "upset"],
  disgusted: ["disgusted", "disgust", "white-eyes", "dead-eyes", "blank"],
};

// Issue #253: preferredName is the model's own expression__set tool choice
// for this reply, if any -- tried first (fuzzy-matched, same as everything
// else here), falling straight through to the normal state-based
// preferences on no match. An invalid/unrecognized name is silently
// ignored this way, exactly as if the tool had never been called; no
// separate validation layer needed.
function expressionForState(state, availableNames, overrides = null, preferredName = null) {
  const names = Array.isArray(availableNames) ? availableNames : [];
  const custom = overrides && overrides[state] ? overrides[state] : [];
  const preferred = preferredName ? [preferredName] : [];
  const preferences = preferred.concat(custom).concat(
    STATE_EXPRESSION_PREFERENCES[state] || STATE_EXPRESSION_PREFERENCES.idle,
  );
  return pickByPreference(preferences, names);
}

// rmsToMouth/smoothMouthValue moved to lip-sync.js (issue #161) so the VRM
// avatar renderer can share the exact same signal math -- re-exported here
// so existing callers/tests of live2d-logic.js don't need to change.
const { rmsToMouth, smoothMouthValue } = require("./lip-sync");

// Preferred Live2D motion groups per avatar state; returns the first group
// the loaded model actually has, or null when nothing matches.
const STATE_MOTION_PREFERENCES = {
  idle: ["Idle", "idle"],
  talking: ["Talk", "Speak", "Speaking", "TapBody", "Tap"],
  excited: ["Happy", "Joy", "Excited", "Tap", "TapBody"],
  angry: ["Angry", "Mad", "Shake", "FlickHead"],
  sad: ["Sad", "Cry", "Down", "Upset"],
  disgusted: ["Disgusted", "Disgust", "Recoil", "Dislike"],
};

// Normalizes a state mapping object like {"talking":"Scene1","excited":["a"]}
// into {state: [names...]}; invalid input degrades to {}.
function normalizeStateMapping(mapping) {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return {};
  }
  const overrides = {};
  for (const [state, value] of Object.entries(mapping)) {
    const names = (Array.isArray(value) ? value : [value])
      .map((name) => String(name))
      .filter(Boolean);
    if (names.length) {
      overrides[state.toLowerCase()] = names;
    }
  }
  return overrides;
}

// Parses a per-model state mapping from an env var; {} on any parse problem.
function parseStateMappingOverrides(jsonText) {
  try {
    return normalizeStateMapping(JSON.parse(jsonText || "{}"));
  } catch (e) {
    return {};
  }
}

// A number field that falls back to `def` when absent/non-finite, so a
// model config can still explicitly set 0 (unlike `Number(x) || def`).
function numberOrDefault(value, def) {
  if (value === undefined) {
    return def;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

// An id-list field: absent -> defaults, present (including []) -> used
// as-is, so a model can explicitly disable a param list the same way the
// MANA_LIVE2D_*_PARAMS env vars do.
function idListOrDefault(value, defaults) {
  if (!Array.isArray(value)) {
    return defaults;
  }
  return value.map((id) => String(id)).filter(Boolean);
}

// Normalizes a per-model avatar config (mana-avatar.json next to the model).
// Every field is optional; anything omitted falls back to the built-in
// default so a model swap only needs to specify what's actually different.
//   {
//     "stateMotions": { "excited": "curious", "idle": "sleepy" },
//     "stateExpressions": { "idle": "hug-pillow" },
//     "randomMotions": [
//       { "group": "spirit", "minIntervalMs": 120000,
//         "maxIntervalMs": 480000, "states": ["idle"] }
//     ],
//     "zoomFractions": { "waist": 0.55, "bust": 0.28 },
//     "mouthParam": "ParamMouthOpenY", "mouthGain": 18,
//     "mouthFormParam": "ParamMouthForm", "mouthFormGain": 0.6,
//     "eyeOpenScale": 1.5,
//     "eyeBlinkParams": ["ParamEyeLOpen", "ParamEyeROpen"],
//     "smileParams": ["ParamEyeLSmile", "ParamEyeRSmile"],
//     "browParams": ["ParamBrowLY", "ParamBrowRY"],
//     "idleTiltDeg": 16, "idleMaxPitchDeg": 8
//   }
function normalizeAvatarConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  const randomMotions = (Array.isArray(source.randomMotions)
    ? source.randomMotions
    : []
  )
    .filter((entry) => entry && typeof entry === "object" && entry.group)
    .map((entry) => {
      const minIntervalMs = Math.max(
        5000,
        Number(entry.minIntervalMs) || 120000,
      );
      return {
        group: String(entry.group),
        minIntervalMs,
        maxIntervalMs: Math.max(
          minIntervalMs,
          Number(entry.maxIntervalMs) || minIntervalMs * 4,
        ),
        states: (Array.isArray(entry.states) && entry.states.length
          ? entry.states
          : ["idle"]
        ).map((state) => String(state).toLowerCase()),
      };
    });

  const zoomFractions = {
    ...DEFAULT_ZOOM_FRACTIONS,
    ...(source.zoomFractions && typeof source.zoomFractions === "object"
      ? source.zoomFractions
      : {}),
  };

  return {
    stateMotions: normalizeStateMapping(source.stateMotions),
    stateExpressions: normalizeStateMapping(source.stateExpressions),
    randomMotions,
    zoomFractions,
    mouthParam:
      typeof source.mouthParam === "string" && source.mouthParam
        ? source.mouthParam
        : DEFAULT_MOUTH_PARAM,
    mouthGain: numberOrDefault(source.mouthGain, DEFAULT_MOUTH_GAIN),
    mouthFormParam:
      typeof source.mouthFormParam === "string" && source.mouthFormParam
        ? source.mouthFormParam
        : DEFAULT_MOUTH_FORM_PARAM,
    mouthFormGain: numberOrDefault(
      source.mouthFormGain,
      DEFAULT_MOUTH_FORM_GAIN,
    ),
    eyeOpenScale: numberOrDefault(source.eyeOpenScale, DEFAULT_EYE_OPEN_SCALE),
    eyeBlinkParams: idListOrDefault(
      source.eyeBlinkParams,
      DEFAULT_EYE_BLINK_PARAM_IDS,
    ),
    smileParams: idListOrDefault(source.smileParams, DEFAULT_SMILE_PARAM_IDS),
    browParams: idListOrDefault(source.browParams, DEFAULT_BROW_PARAM_IDS),
    idleTiltDeg: numberOrDefault(source.idleTiltDeg, DEFAULT_IDLE_TILT_DEG),
    idleMaxPitchDeg: numberOrDefault(
      source.idleMaxPitchDeg,
      DEFAULT_IDLE_MAX_PITCH_DEG,
    ),
    idleGazeDeg: numberOrDefault(source.idleGazeDeg, DEFAULT_IDLE_GAZE_DEG),
    idleGazePeriodMs: numberOrDefault(
      source.idleGazePeriodMs,
      DEFAULT_IDLE_GAZE_PERIOD_MS,
    ),
  };
}

// Weighted intervals between idle eye saccades: [probabilityMass, msOffset]
// pairs before cumulative summing. Ported from Project AIRI's
// stage-ui-live2d eye-motions.ts (MIT) -- modeled on real human microsaccade
// timing (mostly quick 0-800ms corrective glances, tailing off into rarer
// longer holds) rather than a fixed-period oscillation, which read as
// mechanical over a long idle stretch. The final [1.0, 0] entry is an
// intentional catch-all bucket (not a literal 100%-weighted one) that
// guarantees coverage past floating-point rounding on `rng()`.
const SACCADE_INTERVAL_STEP_MS = 400;
const SACCADE_INTERVAL_TABLE = (() => {
  const raw = [
    [0.075, 800],
    [0.11, 0],
    [0.125, 0],
    [0.14, 0],
    [0.125, 0],
    [0.05, 0],
    [0.04, 0],
    [0.03, 0],
    [0.02, 0],
    [1.0, 0],
  ];
  const table = raw.map((row) => row.slice());
  for (let i = 1; i < table.length; i += 1) {
    table[i][0] += table[i - 1][0];
    table[i][1] = table[i - 1][1] + SACCADE_INTERVAL_STEP_MS;
  }
  return table;
})();

// Random interval (ms) until the next idle eye saccade. `scale` lets a
// model's idleGazePeriodMs config speed up/slow down the whole distribution
// without changing its bursty shape; rng is injectable for deterministic
// tests.
function randomSaccadeInterval(rng = Math.random, scale = 1) {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const r = rng();
  for (let i = 0; i < SACCADE_INTERVAL_TABLE.length; i += 1) {
    const [cumProb, base] = SACCADE_INTERVAL_TABLE[i];
    if (r <= cumProb) {
      return (base + rng() * SACCADE_INTERVAL_STEP_MS) * factor;
    }
  }
  const last = SACCADE_INTERVAL_TABLE[SACCADE_INTERVAL_TABLE.length - 1];
  return (last[1] + rng() * SACCADE_INTERVAL_STEP_MS) * factor;
}

// Picks a new random idle-saccade target: head-angle offset in
// [-amplitudeDeg, amplitudeDeg] and eyeball offsets in Cubism's normal
// [-1, 1] range, independently randomized so eyes and head don't always
// move in lockstep. Replaces the old fixed-period sine drift -- see
// randomSaccadeInterval for why. rng is injectable for deterministic tests.
function pickIdleSaccadeTarget(amplitudeDeg, rng = Math.random) {
  const amp = Number(amplitudeDeg) || 0;
  if (amp === 0) {
    return { angleX: 0, eyeBallX: 0, eyeBallY: 0 };
  }
  return {
    angleX: (rng() * 2 - 1) * amp,
    eyeBallX: rng() * 2 - 1,
    eyeBallY: (rng() * 2 - 1) * 0.7,
  };
}

// Exponential smoothing toward a target, generalized from smoothMouthValue
// for values with no attack/decay asymmetry (idle saccade drift, mouth
// form): a symmetric time-based lerp so it settles the same regardless of
// frame rate.
function smoothTowardTarget(previous, target, dtMs, windowMs) {
  const prev = Number(previous) || 0;
  const next = Number(target) || 0;
  const win = Math.max(1, Number(windowMs) || 1);
  const alpha = Math.min(1, (Number(dtMs) || 0) / win);
  return prev + (next - prev) * alpha;
}

// Merges mapping sources so env overrides beat the model config file.
function mergeStateMappings(envOverrides, configMapping) {
  const merged = { ...configMapping };
  for (const [state, names] of Object.entries(envOverrides || {})) {
    merged[state] = names.concat(merged[state] || []);
  }
  return merged;
}

function nextRandomDelay(minMs, maxMs, rng = Math.random) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || min);
  return Math.round(min + (max - min) * rng());
}

function pickByPreference(preferences, availableNames) {
  const lower = new Map(
    availableNames.map((name) => [String(name).toLowerCase(), name]),
  );
  for (const preference of preferences) {
    const match = lower.get(String(preference).toLowerCase());
    if (match) {
      return match;
    }
  }
  return null;
}

function motionGroupForState(state, availableGroups, overrides = null) {
  const groups = Array.isArray(availableGroups) ? availableGroups : [];
  const custom = overrides && overrides[state] ? overrides[state] : [];
  const preferences = custom.concat(
    STATE_MOTION_PREFERENCES[state] || STATE_MOTION_PREFERENCES.idle,
  );
  return pickByPreference(preferences, groups);
}

// Fits a model of (width, height) into a (viewWidth, viewHeight) box,
// anchored to the bottom, returning { scale, x, y }.
function fitModelToView(modelWidth, modelHeight, viewWidth, viewHeight) {
  const safeModelWidth = Math.max(1, Number(modelWidth) || 1);
  const safeModelHeight = Math.max(1, Number(modelHeight) || 1);
  const scale = Math.min(
    viewWidth / safeModelWidth,
    viewHeight / safeModelHeight,
  );
  return {
    scale,
    x: (viewWidth - safeModelWidth * scale) / 2,
    y: viewHeight - safeModelHeight * scale,
  };
}

// Fraction of the model's total height to keep visible for each zoom
// preset. "full" delegates to fitModelToView's normal bottom-anchored fit;
// the others crop to the top f-fraction of the model (where the head is),
// scaled to fill the viewport height, with a small top margin so hair/ears
// aren't flush against the edge. Tunable per-model via mana-avatar.json's
// "zoomFractions" (see normalizeAvatarConfig).
const DEFAULT_ZOOM_FRACTIONS = {
  full: 1,
  waist: 0.55,
  bust: 0.28,
};
const ZOOM_LEVELS = ["full", "waist", "bust"];

function computeZoomFraming(
  zoomLevel,
  modelWidth,
  modelHeight,
  viewWidth,
  viewHeight,
  fractions = DEFAULT_ZOOM_FRACTIONS,
) {
  const level = ZOOM_LEVELS.includes(zoomLevel) ? zoomLevel : "full";
  if (level === "full") {
    return fitModelToView(modelWidth, modelHeight, viewWidth, viewHeight);
  }

  const safeModelWidth = Math.max(1, Number(modelWidth) || 1);
  const safeModelHeight = Math.max(1, Number(modelHeight) || 1);
  const fraction = Math.min(
    1,
    Math.max(0.05, Number(fractions[level]) || DEFAULT_ZOOM_FRACTIONS[level]),
  );
  const topMargin = viewHeight * 0.04;
  const scale = (viewHeight - topMargin) / (safeModelHeight * fraction);

  return {
    scale,
    x: (viewWidth - safeModelWidth * scale) / 2,
    y: topMargin,
  };
}

function nextZoomLevel(current) {
  const index = ZOOM_LEVELS.indexOf(current);
  return ZOOM_LEVELS[(index + 1 + ZOOM_LEVELS.length) % ZOOM_LEVELS.length];
}

module.exports = {
  DEFAULT_BROW_PARAM_IDS,
  DEFAULT_EYE_BLINK_PARAM_IDS,
  DEFAULT_EYE_OPEN_SCALE,
  DEFAULT_IDLE_GAZE_DEG,
  DEFAULT_IDLE_GAZE_PERIOD_MS,
  DEFAULT_IDLE_MAX_PITCH_DEG,
  DEFAULT_IDLE_TILT_DEG,
  DEFAULT_MOUTH_FORM_GAIN,
  DEFAULT_MOUTH_FORM_PARAM,
  DEFAULT_MOUTH_GAIN,
  DEFAULT_MOUTH_PARAM,
  DEFAULT_SMILE_PARAM_IDS,
  DEFAULT_ZOOM_FRACTIONS,
  SACCADE_INTERVAL_STEP_MS,
  ZOOM_LEVELS,
  computeZoomFraming,
  nextZoomLevel,
  parseParamIdList,
  pickIdleSaccadeTarget,
  randomSaccadeInterval,
  smoothTowardTarget,
  STATE_EXPRESSION_PREFERENCES,
  STATE_MOTION_PREFERENCES,
  augmentModelSettings,
  expressionForState,
  findModelJson,
  fitModelToView,
  mergeStateMappings,
  motionGroupForState,
  motionOrExpressionStem,
  nextRandomDelay,
  normalizeAvatarConfig,
  normalizeStateMapping,
  parseStateMappingOverrides,
  rmsToMouth,
  smoothMouthValue,
  validateModelReferences,
};
