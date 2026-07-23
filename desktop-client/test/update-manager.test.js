const assert = require("node:assert/strict");
const test = require("node:test");

const { isAutoUpdateEnabled } = require("../update-manager");

test("isAutoUpdateEnabled defaults to true when unset", () => {
  assert.equal(isAutoUpdateEnabled({}), true);
});

test("isAutoUpdateEnabled is true for any value other than '0'", () => {
  assert.equal(isAutoUpdateEnabled({ MANA_AUTO_UPDATE_ENABLED: "1" }), true);
  assert.equal(isAutoUpdateEnabled({ MANA_AUTO_UPDATE_ENABLED: "yes" }), true);
});

test("isAutoUpdateEnabled is false when explicitly set to '0'", () => {
  assert.equal(isAutoUpdateEnabled({ MANA_AUTO_UPDATE_ENABLED: "0" }), false);
});
