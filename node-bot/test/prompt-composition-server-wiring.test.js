// Issue #400: end-to-end check that a real reply's system-prompt/memory/
// related-facts sizes actually reach prompt-composition-report.js and
// GET /prompt-composition/:sessionId -- same technique
// session-token-usage-server-wiring.test.js uses for #421.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");
const { resetPromptCompositionReport } = require("../prompt-composition-report");

test("a local reply's prompt composition is recorded and surfaced via /prompt-composition/:sessionId", async () => {
  resetPromptCompositionReport();
  const app = createApp({ runLocalAssistantReply: async () => "local reply" });
  const reply = await app.locals.buildAssistantReply("hi", "", "", "default", "sess-400");
  assert.equal(reply, "local reply");

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/prompt-composition/sess-400`);
    assert.equal(res.status, 200);
    const composition = await res.json();
    const blockNames = composition.blocks.map((b) => b.name);
    assert.ok(blockNames.includes("system-prompt"));
    assert.ok(blockNames.includes("prompt-memory"));
    assert.ok(blockNames.includes("related-facts"));
    assert.ok(composition.totalChars > 0);
  });
});

test("/prompt-composition/:sessionId 404s for a session nothing has been recorded for", async () => {
  resetPromptCompositionReport();
  const app = createApp({ runLocalAssistantReply: async () => "local reply" });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/prompt-composition/never-replied-to`);
    assert.equal(res.status, 404);
  });
});
