const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createModelManagement } = require("../model-management");

test("model management reports available and missing profile candidates", () => {
  const root = path.join("C:", "ManaAI", "Mana", "tools", "llama", "gguf-models");
  const fourB = path.join(root, "Qwen3-4B-Q4_K_M.gguf");
  const onePointFiveB = path.join(root, "qwen2.5-1.5b-instruct-q4_k_m.gguf");
  const manager = createModelManagement({
    env: {},
    localGgufs: [fourB, onePointFiveB],
  });

  const status = manager.getModelStatus();

  assert.equal(status.activeProfile, "default");
  assert.equal(status.remoteAiEnabled, false);
  assert.equal(status.remoteAiWarning, null);
  assert.equal(status.profiles.default.label, "Default chat");
  assert.equal(status.profiles.default.available, true);
  assert.equal(status.profiles.default.selectedModel, fourB);
  assert.equal(status.profiles.fast.selectedModel, onePointFiveB);
  assert.equal(
    status.profiles.quality.missing.includes("Qwen3-8B-Q4_K_M.gguf"),
    true,
  );
  assert.deepEqual(
    status.profiles.default.candidates.map((candidate) => candidate.name),
    [
      "Qwen3-4B-Q4_K_M.gguf",
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "Qwen3-8B-Q4_K_M.gguf",
    ],
  );
});

test("model management switches active profile and rejects unknown profiles", () => {
  const manager = createModelManagement({ env: {}, localGgufs: [] });

  assert.equal(manager.getActiveProfile(), "default");
  assert.equal(manager.setActiveProfile("coding").activeProfile, "coding");
  assert.equal(manager.getActiveProfile(), "coding");
  assert.throws(
    () => manager.setActiveProfile("unknown"),
    /profile must be one of: default, fast, quality, coding/,
  );
  assert.equal(manager.getActiveProfile(), "coding");
});

test("model management warns when remote AI is enabled", () => {
  const manager = createModelManagement({
    env: {
      OPENAI_API_KEY: "present",
      MANA_ALLOW_REMOTE_AI: "1",
    },
    localGgufs: [],
  });

  const status = manager.getModelStatus();

  assert.equal(status.remoteAiEnabled, true);
  assert.match(status.remoteAiWarning, /Remote AI is enabled/i);
});
