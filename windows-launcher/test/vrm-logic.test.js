const assert = require("node:assert/strict");
const test = require("node:test");

const {
  findVrmFile,
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
