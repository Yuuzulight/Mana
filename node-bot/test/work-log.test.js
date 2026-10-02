// #1337: the chat reads like a work log -- she narrates before a tool round,
// each step knows where in the reply it goes (textOffset), the steps are
// saved with the turn, and a finished background task leaves a notice in
// the chat that her next reply sees.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Before requiring server.js: its module-level memory store reads this.
process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-work-log-"));

const { createApp } = require("../server");
const { createAgentActivity } = require("../agent-activity");
const { TOOL_NARRATION_PROMPT, launchedTask } = require("../ai/step-description");

const waitFor = async (check) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  return check();
};

test("a narrated tool round streams first, joins the reply, and its steps are saved at their text offset", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  try {
    const calls = [];
    let rounds = true;
    const app = createApp({
      llamaServerRuntime: { isEnabled: () => true },
      runToolAwareReply: async (prompt, toolPolicy, opts) => {
        calls.push(opts);
        if (!rounds) return { content: "Just an answer.", toolCalls: [], rounds: 1 };
        await opts.onRoundText("Next I'm checking the logs to see why it failed.");
        await Promise.resolve(toolPolicy.executeTool("no_such_tool", {})).catch(() => {});
        return { content: "Found it: a typo.", toolCalls: [], rounds: 2 };
      },
    });
    const events = [];
    const reply = await app.locals.buildAssistantReply(
      "why did it fail?", "", "", "default", "sess-1337", null, null,
      { onToolCall: (e) => events.push(["tool", e.phase, e.textOffset]) },
      (sentence) => events.push(["sentence", sentence]),
    );

    // The narration prompt is on the tool-aware path (in the cached prefix), kept short.
    assert.ok(calls[0].overrideSystemPrompt.includes(TOOL_NARRATION_PROMPT));
    assert.ok(TOOL_NARRATION_PROMPT.length < 400);
    const narration = "Next I'm checking the logs to see why it failed.";
    assert.equal(reply, `${narration} Found it: a typo.`);
    // Narration goes out before the round's steps, the answer after.
    assert.deepEqual(events.filter((e) => e[0] === "sentence" || e[1] === "start"), [
      ["sentence", narration],
      ["tool", "start", narration.length],
      ["sentence", "Found it: a typo."],
    ]);

    const store = app.locals.acpMemoryStore;
    assert.ok(await waitFor(() => store.getSession("sess-1337")?.turns.length === 1));
    const [turn] = store.getSession("sess-1337").turns;
    assert.deepEqual(turn.steps.map((s) => [s.tool, s.segment, s.textOffset]), [["no_such_tool", 0, narration.length]]);
    assert.ok(turn.steps[0].endedAt);
    // The saved text keeps the offset: the narration ends right there.
    assert.equal(turn.assistant.slice(0, narration.length), narration);

    // A reply without tools is unchanged and saves no steps.
    rounds = false;
    const plain = await app.locals.buildAssistantReply("hi", "", "", "default", "sess-1337", null, null, {});
    assert.equal(plain, "Just an answer.");
    assert.ok(await waitFor(() => store.getSession("sess-1337").turns.length === 2));
    assert.equal(store.getSession("sess-1337").turns[1].steps, undefined);

    // A finished background task: a notice in the chat, in her next prompt.
    store.appendEvent({ sessionId: "sess-1337", kind: "background_task", taskId: "self-work", title: "#5: Fix it", status: "done", text: "Background task completed" });
    assert.equal(store.appendEvent({ sessionId: "no-such-chat", kind: "background_task" }), null);
    const event = store.getSession("sess-1337").turns[2];
    assert.equal(event.role, "event");
    assert.equal(event.title, "#5: Fix it");
    assert.ok(event.at);
    await app.locals.buildAssistantReply("anything new?", "", "", "default", "sess-1337", null, null, {});
    const late = calls.at(-1).extraMessages.late.map((m) => m.content).join("\n");
    assert.match(late, /System note: background task "#5: Fix it" completed\./);
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
  }
});

test("a step that started a background task carries its taskId and sanitized title", () => {
  assert.equal(launchedTask("not json"), null);
  assert.equal(launchedTask(JSON.stringify({ status: "ok" })), null);
  const task = launchedTask(JSON.stringify({ taskId: "self-work", title: "#7: <b>Fix</b>\nthe `gate`" }));
  assert.deepEqual(task, { taskId: "self-work", title: "#7: b Fix /b the gate" });

  const activity = createAgentActivity();
  const run = activity.start();
  activity.toolStarted(run, "self_work__start", { kind: "agent" });
  activity.toolEnded(run, "self_work__start", { task });
  assert.equal(activity.latestSteps().steps[0].taskId, "self-work");
  assert.equal(activity.latestSteps().steps[0].title, task.title);
});
