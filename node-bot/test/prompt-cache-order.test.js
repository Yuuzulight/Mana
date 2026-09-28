// Issue #660: llama-server reuses its prompt cache for whatever prefix of
// the prompt is byte-identical to the previous request, so the system
// prompt, anything spliced "early" and the tool schemas must not change
// between turns -- per-turn content (session memory, related facts,
// screen text) has to come after them.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Before requiring server.js: its module-level memory store reads this.
process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-prompt-cache-"));

const { createApp } = require("../server");

test("the prompt prefix is byte-identical across turns and per-turn context comes after it", async () => {
  const calls = [];
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true },
    runToolAwareReply: async (prompt, policy, opts) => {
      calls.push({ prompt, tools: JSON.stringify(policy.tools), opts });
      return { content: "tool-aware reply", toolCalls: [], rounds: 1 };
    },
  });
  const store = app.locals.acpMemoryStore;
  store.rememberFact({ key: "the user's GPU", text: "NVIDIA RTX 5080 graphics card", sessionId: "sess-other" });
  store.appendTurn({ sessionId: "sess-660", user: "hello there", assistant: "hi!" });

  await app.locals.buildAssistantReply(
    "how was your day?", "screen A text", "", "default", "sess-660", "everyday", null, {},
  );
  // A reply can make more than one model call (e.g. a regeneration); the
  // first call of each turn is the one that follows the previous turn.
  const first = calls[0];
  calls.length = 0;
  store.appendTurn({ sessionId: "sess-660", user: "how was your day?", assistant: "great" });
  await app.locals.buildAssistantReply(
    "what graphics card do I have?", "screen B text", "", "default", "sess-660", "everyday", null, {},
  );
  const second = calls[0];
  const allCalls = [first, ...calls];
  // The cached prefix: system prompt, early messages, tool schemas.
  assert.equal(first.opts.overrideSystemPrompt, second.opts.overrideSystemPrompt);
  assert.deepEqual(first.opts.extraMessages.early, []);
  assert.deepEqual(second.opts.extraMessages.early, []);
  assert.equal(first.tools, second.tools);

  // Per-turn context differs between the turns and sits after the prefix.
  const lateText = (call) => call.opts.extraMessages.late.map((m) => m.content).join("\n");
  assert.match(lateText(first), /Conversation memory:/);
  assert.notEqual(lateText(first), lateText(second));
  assert.match(lateText(second), /RTX 5080/);
  assert.match(first.prompt, /screen A text/);
  assert.match(second.prompt, /screen B text/);
  for (const call of allCalls) {
    assert.doesNotMatch(call.opts.overrideSystemPrompt, /screen [AB] text|RTX 5080|Conversation memory:/);
  }
});
