const assert = require("node:assert/strict");
const test = require("node:test");

const { shouldUseRemoteAi } = require("../server");

test("remote AI is disabled even when an API key is present unless explicitly allowed", () => {
  assert.equal(
    shouldUseRemoteAi({
      apiKey: "sk-test-key",
      allowRemoteAi: "",
    }),
    false,
  );
  assert.equal(
    shouldUseRemoteAi({
      apiKey: "sk-test-key",
      allowRemoteAi: "0",
    }),
    false,
  );
  assert.equal(
    shouldUseRemoteAi({
      apiKey: "sk-test-key",
      allowRemoteAi: undefined,
    }),
    false,
  );
});

test("remote AI requires both an API key and explicit opt-in", () => {
  assert.equal(
    shouldUseRemoteAi({
      apiKey: "",
      allowRemoteAi: "1",
    }),
    false,
  );
  assert.equal(
    shouldUseRemoteAi({
      apiKey: "sk-test-key",
      allowRemoteAi: "true",
    }),
    false,
  );
  assert.equal(
    shouldUseRemoteAi({
      apiKey: "sk-test-key",
      allowRemoteAi: "1",
    }),
    true,
  );
});
