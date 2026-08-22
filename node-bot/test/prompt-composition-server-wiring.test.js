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

// Regression coverage for a review finding: skillsOmittedCount is scraped
// out of buildSkillsIndexBlock's own embedded "(N more skill(s) omitted for
// length)" text via a regex (server.js does not change that function's
// return shape, since it's separately exported/tested as a bare string).
// Nothing previously exercised that regex end-to-end -- if the wording in
// buildSkillsIndexBlock ever changes, this is what would catch it reverting
// to always reporting 0.
test("skillsOmitted in the system-prompt block's dropped info reflects a real skills-index truncation", async () => {
  resetPromptCompositionReport();
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  // SKILLS_INDEX_MAX_CHARS is 2000 -- enough long descriptions guarantees
  // buildSkillsIndexBlock actually has to omit some.
  const manySkills = Array.from({ length: 40 }, (_, i) => ({
    name: `skill-${i}`,
    description: "A".repeat(100),
  }));
  const app = createApp({
    skillsStore: { listSkills: () => manySkills },
    llamaServerRuntime: { isEnabled: () => true },
    runToolAwareReply: async () => ({ content: "tool-aware reply", toolCalls: [], rounds: 1 }),
  });

  const reply = await app.locals.buildAssistantReply(
    "hi", "", "", "default", "sess-skills-omitted", null, null, {},
  );
  delete process.env.MANA_TOOL_CALLING_ENABLED;
  assert.equal(reply, "tool-aware reply");

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/prompt-composition/sess-skills-omitted`);
    const composition = await res.json();
    const systemPromptBlock = composition.blocks.find((b) => b.name === "system-prompt");
    assert.ok(systemPromptBlock.dropped.skillsOmitted > 0);
  });
});
