// #661: buildAssistantReply reports each tool call's start/end through
// replyMeta.onToolCall (relayed by /reply/stream so the native avatar can
// show she's working) -- except expression__set, which is her face, not work.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");

test("tool-aware replies report tool start/end via replyMeta.onToolCall, skipping expression tools", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  try {
    const app = createApp({
      llamaServerRuntime: { isEnabled: () => true },
      runToolAwareReply: async (prompt, toolPolicy) => {
        await Promise.resolve(toolPolicy.executeTool("expression__set", { name: "smile" })).catch(() => {});
        await Promise.resolve(toolPolicy.executeTool("no_such_tool", {})).catch(() => {});
        return { content: "tool-aware reply", toolCalls: [], rounds: 1 };
      },
    });
    const events = [];

    const reply = await app.locals.buildAssistantReply(
      "look something up", "", "", "default", null, null, null,
      { onToolCall: (event) => events.push(event) },
    );

    assert.equal(reply, "tool-aware reply");
    // #1318: each event carries its step; the unknown tool waits for
    // approval in between.
    assert.deepEqual(events.map((e) => [e.name, e.phase, e.status]), [
      ["no_such_tool", "start", "running"],
      ["no_such_tool", "waiting", "awaiting_approval"],
      ["no_such_tool", "resumed", "running"],
      ["no_such_tool", "end", events[3].status],
    ]);
    assert.equal(events[0].description, "No such tool");
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
  }
});
