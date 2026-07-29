// Pure helpers for the VRM avatar renderer (issue #161), kept three.js-free
// so tests can cover them directly -- mirrors live2d-logic.js's split
// between pure logic and the PIXI-driven wrapper.
const { rmsToMouth, smoothMouthValue, vrmMouthBlendShapes } = require("./lip-sync");
// Reuses the exact same idle-saccade timing distribution as Live2D (see
// live2d-logic.js's own comment) instead of duplicating the table for a
// second avatar renderer.
const { randomSaccadeInterval, smoothTowardTarget } = require("./live2d-logic");

// Finds the lexicographically first .vrm file under rootDir (recursive),
// or null. Sorted so the pick stays deterministic when several exist.
// Mirrors live2d-logic.js's findModelJson.
function findVrmFile(rootDir, fsLike) {
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
        if (entry.name.toLowerCase().endsWith(".vrm")) {
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

// Decides which avatar renderer to use: VRM is preferred when a model is
// configured (issue #161's "second avatar option alongside Live2D"), and
// this degrades to Live2D, then to no avatar at all, exactly like Mana
// already degrades when the Live2D model itself is missing -- no sprite/
// PNG fallback is invented here, matching the existing renderer.js comment
// that only the model is ever shown.
function resolveAvatarKind({ vrmPath, live2dPath }) {
  if (vrmPath) return "vrm";
  if (live2dPath) return "live2d";
  return "none";
}

// VRM's standard expression preset names (VRMC_vrm 1.0 / VRM 0.x share the
// same core set: happy, angry, sad, relaxed, surprised, plus the aa/ih/ou/
// ee/oh mouth shapes used for lip sync and blink/blinkLeft/blinkRight).
// Maps the same avatar states Live2D already reacts to
// (live2d-logic.js's STATE_EXPRESSION_PREFERENCES) onto the closest VRM
// preset -- VRM has no native "disgusted", so that maps to "relaxed" (a
// neutral-ish face) rather than inventing a non-standard expression name.
const STATE_VRM_EXPRESSION = {
  idle: null,
  talking: null,
  excited: "happy",
  angry: "angry",
  sad: "sad",
  disgusted: "relaxed",
};

function vrmExpressionForState(state) {
  return STATE_VRM_EXPRESSION[state] || null;
}

// VRM has no built-in auto-blink manager the way Cubism/Live2D does (the
// SDK drives that internally); this has to be timed manually. Values match
// Project AIRI's useBlink() timing. rng is injectable for deterministic
// tests.
const MIN_BLINK_INTERVAL_MS = 1000;
const MAX_BLINK_INTERVAL_MS = 6000;
const BLINK_DURATION_MS = 200;

function nextBlinkDelay(rng = Math.random) {
  return (
    MIN_BLINK_INTERVAL_MS + rng() * (MAX_BLINK_INTERVAL_MS - MIN_BLINK_INTERVAL_MS)
  );
}

// Blink expression value (0..1) at `progressMs` into a BLINK_DURATION_MS
// blink -- a sine curve so it eases into closed and back open instead of
// snapping, same shape as AIRI's useBlink().
function blinkValueAt(progressMs) {
  const t = Math.max(0, Math.min(1, (Number(progressMs) || 0) / BLINK_DURATION_MS));
  return Math.sin(Math.PI * t);
}

// Standard smoothstep-style ease used to crossfade between VRM expression
// presets (see crossfadeValue) instead of snapping between them in one
// frame -- ported from Project AIRI's useVRMEmote, which explicitly fixed a
// "too raw / smiles too much" bug by easing this transition.
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

// Blends from `from` to `to` (both 0..1 expression weights) over
// `durationMs`, given `elapsedMs` since the transition started. A
// durationMs of 0 (or elapsedMs already past it) snaps straight to `to`.
function crossfadeValue(from, to, elapsedMs, durationMs) {
  if (!durationMs || durationMs <= 0) {
    return to;
  }
  const t = Math.max(0, Math.min(1, (Number(elapsedMs) || 0) / durationMs));
  const eased = easeInOutCubic(t);
  return from + (to - from) * eased;
}

// Idle eye-saccade jitter for VRM's look-at target: a small offset in the
// plane facing the character (x/y only, z/depth stays fixed), matching
// AIRI's useIdleEyeSaccades comment ("simulating random content on a 27in
// monitor at 65cm distance"). Paired with live2d-logic.js's
// randomSaccadeInterval for timing (re-exported below) rather than a
// second copy of that distribution.
const IDLE_SACCADE_JITTER = 0.25;

function pickVrmSaccadeOffset(rng = Math.random) {
  return {
    x: (rng() * 2 - 1) * IDLE_SACCADE_JITTER,
    y: (rng() * 2 - 1) * IDLE_SACCADE_JITTER,
  };
}

module.exports = {
  BLINK_DURATION_MS,
  MAX_BLINK_INTERVAL_MS,
  MIN_BLINK_INTERVAL_MS,
  blinkValueAt,
  crossfadeValue,
  easeInOutCubic,
  findVrmFile,
  nextBlinkDelay,
  pickVrmSaccadeOffset,
  randomSaccadeInterval,
  resolveAvatarKind,
  rmsToMouth,
  smoothMouthValue,
  smoothTowardTarget,
  vrmExpressionForState,
  vrmMouthBlendShapes,
};
