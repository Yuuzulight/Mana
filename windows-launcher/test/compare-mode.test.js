const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatCompareProfileLabel,
  pickDefaultCompareProfiles,
} = require("../renderer/compare-mode");

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

test("formatCompareProfileLabel shows the backing GGUF filename for an available profile", () => {
  const profiles = {
    quality: {
      label: "Quality fallback",
      available: true,
      selectedModel: "C:\\ManaAI\\Mana\\tools\\llama\\gguf-models\\Qwen3-14B-Q4_K_M.gguf",
    },
  };
  assert.equal(
    formatCompareProfileLabel("quality", profiles),
    "Quality fallback (Qwen3-14B-Q4_K_M.gguf)",
  );
});

test("formatCompareProfileLabel falls back to just the label when no model file is selected", () => {
  const profiles = { default: { label: "Default chat", available: true, selectedModel: null } };
  assert.equal(formatCompareProfileLabel("default", profiles), "Default chat");
});

test("formatCompareProfileLabel flags a profile with no matching GGUF as unavailable", () => {
  const profiles = { quality: { label: "Quality fallback", available: false } };
  assert.equal(formatCompareProfileLabel("quality", profiles), "Quality fallback (unavailable)");
});

test("formatCompareProfileLabel handles an unknown key without crashing", () => {
  assert.equal(formatCompareProfileLabel("missing", {}), "missing");
  assert.equal(formatCompareProfileLabel(undefined, {}), "");
});
