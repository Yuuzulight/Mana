// #646: GET /agent/activity shows the chat tool loop's live run (tool,
// elapsed), and POST /agent/stop makes every later tool call in it refuse.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { createAgentActivity } = require("../agent-activity");
const { useTestAdminToken, withServer } = require("./helpers");
// #842: these routes are admin-only; every request here sends ADMIN_TOKEN.
const fetch = useTestAdminToken();

test("agent activity lists only runs that called a tool, with the running tool and elapsed times", () => {
  let now = 1000;
  const activity = createAgentActivity({ now: () => now });
  const idle = activity.start();
  const busy = activity.start();
  activity.toolStarted(busy, "web_search");
  now = 4000;

  const pick = ({ id, elapsedMs, tool, toolElapsedMs, toolCount, lastTool, stopping }) =>
    ({ id, elapsedMs, tool, toolElapsedMs, toolCount, lastTool, stopping });
  assert.deepEqual(activity.list().map(pick), [
    { id: busy.id, elapsedMs: 3000, tool: "web_search", toolElapsedMs: 3000, toolCount: 1, lastTool: null, stopping: false },
  ]);

  activity.toolEnded(busy, "web_search");
  assert.equal(activity.stop(busy.id), true);
  assert.equal(activity.stop("nope"), false);
  assert.equal(idle.stopRequested, false);
  assert.deepEqual(pick(activity.list()[0]), {
    id: busy.id, elapsedMs: 3000, tool: null, toolElapsedMs: null, toolCount: 1, lastTool: "web_search", stopping: true,
  });

  activity.finish(busy);
  assert.deepEqual(activity.list(), []);
});

test("POST /agent/stop refuses the running reply's later tool calls; the run leaves /agent/activity when it ends", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  try {
    let seen = null;
    let refused = null;
    let baseUrl = null;
    const app = createApp({
      llamaServerRuntime: { isEnabled: () => true, getStatus: () => ({ model: "D:\\models\\qwen.gguf" }) },
      runToolAwareReply: async (prompt, toolPolicy) => {
        await Promise.resolve(toolPolicy.executeTool("no_such_tool", {})).catch(() => {});
        seen = await (await fetch(`${baseUrl}/agent/activity`)).json();
        const stop = await fetch(`${baseUrl}/agent/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: seen.runs[0].id }),
        });
        assert.deepEqual(await stop.json(), { stopped: true });
        refused = await Promise.resolve(toolPolicy.executeTool("no_such_tool", {})).then(() => null, (e) => e.message);
        return { content: "tool-aware reply", toolCalls: [], rounds: 1 };
      },
    });
    const events = [];

    await withServer(app, async (url) => {
      baseUrl = url;
      const reply = await app.locals.buildAssistantReply(
        "look something up", "", "", "default", null, null, null,
        { onToolCall: (event) => events.push(event) },
      );
      assert.equal(reply, "tool-aware reply");
      const after = await (await fetch(`${url}/agent/activity`)).json();
      assert.deepEqual(after.runs, []);
      // #1318: the last reply's steps stay readable for the chat.
      assert.equal(after.running, false);
      assert.deepEqual(after.steps.map((s) => [s.tool, Boolean(s.endedAt)]), [["no_such_tool", true]]);
    });

    assert.equal(seen.runs.length, 1);
    // #1338: a Windows model path shows as its file name only.
    assert.equal(seen.runs[0].model, "qwen.gguf");
    assert.equal(seen.runs[0].lastTool, "no_such_tool");
    assert.equal(seen.runs[0].toolCount, 1);
    assert.match(refused, /Stopped by the user/);
    // The refused call never started.
    // #1318: (an approval wait in between shows as waiting/resumed.)
    const startEnd = events.filter((e) => e.phase === "start" || e.phase === "end");
    assert.deepEqual(startEnd.map((e) => [e.name, e.phase, e.description]), [
      ["no_such_tool", "start", "No such tool"],
      ["no_such_tool", "end", "No such tool"],
    ]);
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
  }
});

// #1318
test("agent activity records each step with its description, status, times and result", () => {
  let now = Date.parse("2026-10-03T00:00:00Z");
  const activity = createAgentActivity({ now: () => now });
  const run = activity.start({ model: "Qwen3.5-9B" });
  activity.toolStarted(run, "dc__start_process", { kind: "command", description: "Run the tests", detail: { command: "npm test" } });
  activity.toolWaiting(run, true);
  assert.equal(activity.list()[0].waiting, true);
  assert.equal(activity.latestSteps().steps[0].status, "awaiting_approval");
  activity.toolWaiting(run, false);
  now += 1500;
  activity.toolEnded(run, "dc__start_process", { ok: true, result: "2 passed", tokens: 7100 });
  const [step] = activity.latestSteps().steps;
  assert.deepEqual(step, {
    id: "s1",
    kind: "command",
    tool: "dc__start_process",
    description: "Run the tests",
    detail: { command: "npm test", resultPreview: "2 passed" },
    segment: 0,
    textOffset: 0,
    status: "done",
    startedAt: "2026-10-03T00:00:00.000Z",
    endedAt: "2026-10-03T00:00:01.500Z",
  });
  assert.equal(activity.list()[0].description, "Run the tests");
  // Text between rounds starts a new segment, once however much text.
  // #1337: placed at the reply's length so far.
  activity.textShown(run, 12);
  activity.textShown(run, 30);
  activity.toolStarted(run, "x__y", {});
  assert.equal(activity.latestSteps().steps[1].segment, 1);
  assert.equal(activity.latestSteps().steps[1].textOffset, 30);
  assert.equal(activity.list()[0].tokens, 7100);
  activity.finish(run);
  assert.deepEqual(activity.list(), []);
  assert.equal(activity.listRecent()[0].model, "Qwen3.5-9B");
  assert.equal(activity.steps(run.id).length, 2);
  assert.equal(activity.steps("nope"), null);
});
