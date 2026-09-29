// #675 Q12b: Mana turns deep thinking on herself (deep_thinking__set) when
// the user asks in any words; it lasts for the task, at most 10 replies, and
// the user's thinkHarder: false (clicking the lit Think button) ends it.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createDeepThinkingState, MAX_DEEP_THINKING_REPLIES } = require("../ai/deep-thinking-tool-source");
const { createApp } = require("../server");

test("deep thinking state: the reply that turns it on counts, 10 replies at most, re-asking doesn't extend it", () => {
  const state = createDeepThinkingState();
  assert.equal(state.takeReply("s"), false);
  state.set("s", true); // mid-reply 1
  assert.equal(state.takeReply("s"), true); // reply 2
  state.set("s", true); // asked again while on
  let replies = 2;
  while (state.takeReply("s")) replies += 1;
  assert.equal(replies, MAX_DEEP_THINKING_REPLIES);
  assert.equal(state.isOn("s"), false);

  state.set("s", true);
  state.set("s", false);
  assert.equal(state.takeReply("s"), false);
  state.set("other", true);
  assert.equal(state.isOn("s"), false, "per session");
});

test("Mana's deep_thinking__set thinks for the rest of the reply and later ones, until she or the user turns it off", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  try {
    const rounds = [];
    const tools = [];
    let callTool = null;
    const app = createApp({
      llamaServerRuntime: { isEnabled: () => true },
      runToolAwareReply: async (prompt, toolPolicy, opts) => {
        tools.push(toolPolicy.tools.map((t) => t.function.name));
        const before = opts.thinking();
        if (callTool) await toolPolicy.executeTool("deep_thinking__set", callTool);
        rounds.push([before, opts.thinking()]);
        return { content: "tool-aware reply", toolCalls: [], rounds: 1 };
      },
    });
    // [thinking before, after] of the reply's first tool round (rut
    // detection may regenerate it), plus replyMeta.deepThinking.
    const reply = async (replyMeta = {}, sessionId = "s1") => {
      const start = rounds.length;
      await app.locals.buildAssistantReply("be really careful with this one", "", "", "default", sessionId, null, null, replyMeta);
      return [...rounds[start], replyMeta?.deepThinking];
    };

    callTool = { on: true };
    assert.deepEqual(await reply(), [undefined, true, true]);
    callTool = null;
    assert.deepEqual(await reply(), [true, true, true]);

    // The user clicks the lit Think button off: the next reply doesn't think.
    assert.deepEqual(await reply({ thinkHarder: false }), [undefined, undefined, false]);

    // She turns it off herself when the task is done.
    callTool = { on: true };
    await reply();
    callTool = { on: false };
    assert.deepEqual(await reply(), [true, undefined, false]);

    // Cron/Discord jobs (no replyMeta) neither think from it nor get the tool.
    callTool = { on: true };
    await reply();
    callTool = null;
    assert.deepEqual(await reply(null), [undefined, undefined, undefined]);
    assert.equal(tools.at(-1).includes("deep_thinking__set"), false);
    assert.deepEqual(await reply({ scheduled: true }), [undefined, undefined, undefined]);
    assert.equal(tools.at(-1).includes("deep_thinking__set"), false);
    assert.equal(tools[0].includes("deep_thinking__set"), true);

    // Calling it on every reply doesn't get round the 10-reply cap.
    callTool = { on: true };
    const capped = [];
    for (let i = 0; i < 11; i += 1) capped.push((await reply({}, "s2"))[0]);
    assert.deepEqual(capped, [undefined, ...Array(9).fill(true), undefined]);
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
  }
});
