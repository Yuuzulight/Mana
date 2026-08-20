// The [AVAILABLE SKILLS] index tells the model it can call skill__view --
// but only replyMaybeWithTools's tool-calling attempt can actually execute
// that call, and only when toolCallingEnabled && normalizedModelProfile ===
// "default" && isLlamaServerAvailable(). Outside that condition (the
// default state: MANA_TOOL_CALLING_ENABLED unset, or any non-"default"
// profile such as "quality"), the model has no real tool-calling channel
// and narrates the call as plain text instead ("Skill needed: X\nCalling
// skill__view with name: X" leaking into the reply). The skills index must
// only be added to the system prompt under the same condition that lets it
// actually be used.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");

const ONE_SKILL = [
  { name: "diagnosing-a-stuck-tts-provider", description: "When TTS stops responding." },
];

function fakeSkillsStore(skills) {
  return { listSkills: () => skills };
}

test("skills index is NOT added to the system prompt when tool-calling is disabled (default state)", async () => {
  delete process.env.MANA_TOOL_CALLING_ENABLED;
  let capturedSystemPrompt = null;
  const app = createApp({
    skillsStore: fakeSkillsStore(ONE_SKILL),
    llamaServerRuntime: { isEnabled: () => true },
    runLocalAssistantReply: async (prompt, maxTokens, profile, overrideSystemPrompt) => {
      capturedSystemPrompt = overrideSystemPrompt;
      return "plain reply";
    },
  });

  const reply = await app.locals.buildAssistantReply(
    "hi", "", "", "default", null, null, null, {},
  );

  assert.equal(reply, "plain reply");
  assert.ok(capturedSystemPrompt !== null, "runLocalAssistantReply should have been called");
  assert.ok(
    !capturedSystemPrompt.includes("AVAILABLE SKILLS"),
    "system prompt must not advertise a skill the model can't actually call",
  );
});

test("skills index IS added to the system prompt when tool-calling is enabled and the profile is \"default\"", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  let capturedSystemPrompt = null;
  const app = createApp({
    skillsStore: fakeSkillsStore(ONE_SKILL),
    llamaServerRuntime: { isEnabled: () => true },
    runToolAwareReply: async (prompt, toolPolicy, options) => {
      capturedSystemPrompt = options.overrideSystemPrompt;
      return { content: "tool-aware reply", toolCalls: [], rounds: 1 };
    },
  });

  const reply = await app.locals.buildAssistantReply(
    "hi", "", "", "default", null, null, null, {},
  );

  delete process.env.MANA_TOOL_CALLING_ENABLED;

  assert.equal(reply, "tool-aware reply");
  assert.ok(capturedSystemPrompt !== null, "runToolAwareReply should have been called");
  assert.ok(
    capturedSystemPrompt.includes("AVAILABLE SKILLS"),
    "system prompt should advertise the skill when the model can actually call it",
  );
});

test("skills index is NOT added when tool-calling is enabled but the profile is not \"default\" (e.g. \"quality\")", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  let capturedSystemPrompt = null;
  const app = createApp({
    skillsStore: fakeSkillsStore(ONE_SKILL),
    llamaServerRuntime: { isEnabled: () => true },
    runToolAwareReply: async () => {
      throw new Error("tool-calling must not be attempted for a non-default profile");
    },
    runLocalAssistantReply: async (prompt, maxTokens, profile, overrideSystemPrompt) => {
      capturedSystemPrompt = overrideSystemPrompt;
      return "plain reply";
    },
  });

  const reply = await app.locals.buildAssistantReply(
    "hi", "", "", "quality", null, null, null, {},
  );

  delete process.env.MANA_TOOL_CALLING_ENABLED;

  assert.equal(reply, "plain reply");
  assert.ok(capturedSystemPrompt !== null, "runLocalAssistantReply should have been called");
  assert.ok(
    !capturedSystemPrompt.includes("AVAILABLE SKILLS"),
    "system prompt must not advertise a skill the current model profile can't call",
  );
});
