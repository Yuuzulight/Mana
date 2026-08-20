// Coding-mode replies routinely need more room than the 180-token budget
// sized for spoken conversation (a function plus explanation plus a usage
// example) -- LLAMA_MAX_TOKENS_CODING (default 768) applies instead,
// wherever buildAssistantReply actually generates a reply.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");

test("plain/everyday replies use the default LLAMA_MAX_TOKENS budget", async () => {
  let capturedMaxTokens = null;
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true },
    runLocalAssistantReply: async (prompt, maxTokens) => {
      capturedMaxTokens = maxTokens;
      return "plain reply";
    },
  });

  const reply = await app.locals.buildAssistantReply(
    "hi", "", "", "default", null, "everyday", null, {},
  );

  assert.equal(reply, "plain reply");
  assert.equal(capturedMaxTokens, 180);
});

test("coding-mode replies use the larger LLAMA_MAX_TOKENS_CODING budget", async () => {
  let capturedMaxTokens = null;
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true },
    runLocalAssistantReply: async (prompt, maxTokens) => {
      capturedMaxTokens = maxTokens;
      return "plain reply";
    },
  });

  const reply = await app.locals.buildAssistantReply(
    "write a function", "", "", "default", null, "coding", null, {},
  );

  assert.equal(reply, "plain reply");
  assert.equal(capturedMaxTokens, 768);
});

test("developer mode (an alias for coding) also gets the larger budget", async () => {
  let capturedMaxTokens = null;
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true },
    runLocalAssistantReply: async (prompt, maxTokens) => {
      capturedMaxTokens = maxTokens;
      return "plain reply";
    },
  });

  await app.locals.buildAssistantReply(
    "fix this bug", "", "", "default", null, "developer", null, {},
  );

  assert.equal(capturedMaxTokens, 768);
});

test("coding-mode maxTokens is also threaded into the tool-aware call site when tool-calling is active", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  let capturedMaxTokens = null;
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true },
    runToolAwareReply: async (prompt, toolPolicy, options) => {
      capturedMaxTokens = options.maxTokens;
      return { content: "tool-aware reply", toolCalls: [], rounds: 1 };
    },
  });

  // Tool-calling only activates for the "default" profile, per its own
  // gate -- assistantMode is what selects "coding" here.
  await app.locals.buildAssistantReply(
    "write a function", "", "", "default", null, "coding", null, {},
  );

  delete process.env.MANA_TOOL_CALLING_ENABLED;

  assert.equal(capturedMaxTokens, 768);
});
