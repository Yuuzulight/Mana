const assert = require("node:assert/strict");
const test = require("node:test");

const { pickDefaultCompareProfiles } = require("../renderer/compare-mode");

test("pickDefaultCompareProfiles prefers default vs quality when both exist", () => {
  assert.deepEqual(
    pickDefaultCompareProfiles(["default", "fast", "quality", "coding"]),
    ["default", "quality"],
  );
});

test("pickDefaultCompareProfiles falls back to the first two distinct keys", () => {
  assert.deepEqual(pickDefaultCompareProfiles(["fast", "coding"]), ["fast", "coding"]);
});

test("pickDefaultCompareProfiles handles a single profile without crashing", () => {
  assert.deepEqual(pickDefaultCompareProfiles(["fast"]), ["fast", "fast"]);
});

test("pickDefaultCompareProfiles handles no profiles without crashing", () => {
  assert.deepEqual(pickDefaultCompareProfiles([]), [null, null]);
  assert.deepEqual(pickDefaultCompareProfiles(undefined), [null, null]);
});
