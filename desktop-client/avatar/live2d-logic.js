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
const DEFAULT_EYE_OPEN_SCALE = 1.5;
const DEFAULT_IDLE_TILT_DEG = 16;
const DEFAULT_IDLE_MAX_PITCH_DEG = 8;

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
  const augmented = JSON.parse(JSON.stringify(settings || {}));
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

function expressionForState(state, availableNames, overrides = null) {
  const names = Array.isArray(availableNames) ? availableNames : [];
  const custom = overrides && overrides[state] ? overrides[state] : [];
  const preferences = custom.concat(
    STATE_EXPRESSION_PREFERENCES[state] || STATE_EXPRESSION_PREFERENCES.idle,
  );
  return pickByPreference(preferences, names);
}

// Maps speech RMS amplitude to a 0..1 mouth-open value with a noise floor.
function rmsToMouth(rms, options = {}) {
  const floor = options.floor === undefined ? 0.01 : options.floor;
  const gain = options.gain === undefined ? 9 : options.gain;
  const value = (Number(rms) || 0) - floor;
  if (value <= 0) {
    return 0;
  }
  return Math.min(1, value * gain);
}

// Fast attack, slower decay so the mouth snaps open but closes smoothly.
function smoothMouthValue(previous, target, dtMs, options = {}) {
  const attackMs = options.attackMs === undefined ? 40 : options.attackMs;
  const decayMs = options.decayMs === undefined ? 140 : options.decayMs;
  const prev = Number(previous) || 0;
  const next = Number(target) || 0;
  const tau = next > prev ? attackMs : decayMs;
  const alpha = Math.min(1, (Number(dtMs) || 0) / Math.max(1, tau));
  return prev + (next - prev) * alpha;
}

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
  };
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
  DEFAULT_IDLE_MAX_PITCH_DEG,
  DEFAULT_IDLE_TILT_DEG,
  DEFAULT_MOUTH_GAIN,
  DEFAULT_MOUTH_PARAM,
  DEFAULT_SMILE_PARAM_IDS,
  DEFAULT_ZOOM_FRACTIONS,
  ZOOM_LEVELS,
  computeZoomFraming,
  nextZoomLevel,
  parseParamIdList,
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
};
