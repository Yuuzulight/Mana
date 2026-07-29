const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BLINK_DURATION_MS,
  MAX_BLINK_INTERVAL_MS,
  MIN_BLINK_INTERVAL_MS,
  blinkValueAt,
  crossfadeValue,
  findVrmFile,
  nextBlinkDelay,
  pickVrmSaccadeOffset,
  resolveAvatarKind,
  vrmExpressionForState,
  rmsToMouth,
  smoothMouthValue,
} = require("../avatar/vrm-logic");

function fakeFs(tree) {
  return {
    existsSync: (p) => p in tree,
    readdirSync: (dir, opts) =>
      (tree[dir] || []).map((entry) => ({
        name: entry.name,
        isDirectory: () => Boolean(entry.dir),
      })),
  };
}

test("findVrmFile finds a .vrm file and ignores unrelated files", () => {
  const fs = fakeFs({
    "C:\\models": [{ name: "mana.vrm" }, { name: "readme.txt" }],
  });
  assert.equal(findVrmFile("C:\\models", fs), "C:\\models\\mana.vrm");
});

test("findVrmFile recurses into subdirectories", () => {
  const fs = fakeFs({
    "C:\\models": [{ name: "sub", dir: true }],
    "C:\\models\\sub": [{ name: "avatar.VRM" }],
  });
  assert.equal(findVrmFile("C:\\models", fs), "C:\\models\\sub\\avatar.VRM");
});

test("findVrmFile picks the lexicographically first match for determinism", () => {
  const fs = fakeFs({
    "C:\\models": [{ name: "zeta.vrm" }, { name: "alpha.vrm" }],
  });
  assert.equal(findVrmFile("C:\\models", fs), "C:\\models\\alpha.vrm");
});

test("findVrmFile returns null when the root doesn't exist or has no vrm files", () => {
  const fs = fakeFs({ "C:\\models": [{ name: "readme.txt" }] });
  assert.equal(findVrmFile("C:\\missing", fs), null);
  assert.equal(findVrmFile("C:\\models", fs), null);
  assert.equal(findVrmFile("", fs), null);
});

test("resolveAvatarKind prefers vrm when configured", () => {
  assert.equal(resolveAvatarKind({ vrmPath: "a.vrm", live2dPath: "b.model3.json" }), "vrm");
});

test("resolveAvatarKind falls back to live2d without a vrm model", () => {
  assert.equal(resolveAvatarKind({ vrmPath: null, live2dPath: "b.model3.json" }), "live2d");
});

test("resolveAvatarKind returns none when neither is configured", () => {
  assert.equal(resolveAvatarKind({ vrmPath: null, live2dPath: null }), "none");
});

test("vrmExpressionForState maps known states to VRM standard presets", () => {
  assert.equal(vrmExpressionForState("excited"), "happy");
  assert.equal(vrmExpressionForState("angry"), "angry");
  assert.equal(vrmExpressionForState("sad"), "sad");
  assert.equal(vrmExpressionForState("disgusted"), "relaxed");
});

test("vrmExpressionForState returns null for idle/talking/unknown states", () => {
  assert.equal(vrmExpressionForState("idle"), null);
  assert.equal(vrmExpressionForState("talking"), null);
  assert.equal(vrmExpressionForState("nonsense"), null);
});

test("re-exports the shared lip-sync functions unchanged", () => {
  assert.equal(typeof rmsToMouth, "function");
  assert.equal(typeof smoothMouthValue, "function");
  assert.equal(rmsToMouth(1), 1);
});

test("nextBlinkDelay stays within [MIN_BLINK_INTERVAL_MS, MAX_BLINK_INTERVAL_MS]", () => {
  assert.equal(nextBlinkDelay(() => 0), MIN_BLINK_INTERVAL_MS);
  assert.equal(nextBlinkDelay(() => 1), MAX_BLINK_INTERVAL_MS);
  const mid = nextBlinkDelay(() => 0.5);
  assert.equal(mid, (MIN_BLINK_INTERVAL_MS + MAX_BLINK_INTERVAL_MS) / 2);
});

test("blinkValueAt eases through a full closed-then-open cycle", () => {
  assert.ok(blinkValueAt(0) < 1e-10); // fully open at the start
  assert.ok(blinkValueAt(BLINK_DURATION_MS) < 1e-10); // fully open again at the end
  const midway = blinkValueAt(BLINK_DURATION_MS / 2);
  assert.ok(midway > 0.9); // sin(pi/2) == 1, fully closed at the midpoint
  // Clamps past the end instead of going negative/oscillating.
  assert.ok(blinkValueAt(BLINK_DURATION_MS * 2) < 1e-10);
});

test("crossfadeValue eases from `from` to `to` and snaps at duration 0", () => {
  assert.equal(crossfadeValue(0, 1, 0, 300), 0);
  assert.equal(crossfadeValue(0, 1, 300, 300), 1);
  const midway = crossfadeValue(0, 1, 150, 300);
  assert.ok(midway > 0 && midway < 1);
  // durationMs of 0 (or missing) means "no crossfade", snap straight to target.
  assert.equal(crossfadeValue(0, 1, 0, 0), 1);
  assert.equal(crossfadeValue(0.4, 0.9, 1000, undefined), 0.9);
});

test("pickVrmSaccadeOffset stays within its jitter range and opts differently per rng call", () => {
  const low = pickVrmSaccadeOffset(() => 0);
  assert.equal(low.x, -0.25);
  assert.equal(low.y, -0.25);
  const high = pickVrmSaccadeOffset(() => 1);
  assert.equal(high.x, 0.25);
  assert.equal(high.y, 0.25);
});
