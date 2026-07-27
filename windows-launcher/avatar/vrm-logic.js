// Pure helpers for the VRM avatar renderer (issue #161), kept three.js-free
// so tests can cover them directly -- mirrors live2d-logic.js's split
// between pure logic and the PIXI-driven wrapper.
const { rmsToMouth, smoothMouthValue } = require("./lip-sync");

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

module.exports = {
  findVrmFile,
  resolveAvatarKind,
  vrmExpressionForState,
  rmsToMouth,
  smoothMouthValue,
};
