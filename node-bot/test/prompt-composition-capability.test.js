const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");

const { promptCompositionCapability } = require("../capabilities/prompt-composition-capability");
const { withServer } = require("./helpers");

test("prompt composition capability returns the recorded composition for a session", async () => {
  const app = express();
  app.use(express.json());
  promptCompositionCapability.registerRoutes(app, {
    getPromptComposition: (sessionId) =>
      sessionId === "known"
        ? { blocks: [{ name: "system-prompt", chars: 100, estTokens: 25 }], totalChars: 100, totalEstTokens: 25 }
        : null,
  });

  await withServer(app, async (baseUrl) => {
    const ok = await fetch(`${baseUrl}/prompt-composition/known`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.totalChars, 100);

    const missing = await fetch(`${baseUrl}/prompt-composition/unknown`);
    assert.equal(missing.status, 404);
  });
});

test("prompt composition capability reports health", () => {
  const health = promptCompositionCapability.getHealth();
  assert.equal(health.status, "configured");
});
