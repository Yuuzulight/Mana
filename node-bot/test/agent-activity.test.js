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

  assert.deepEqual(activity.list(), [
    { id: busy.id, elapsedMs: 3000, tool: "web_search", toolElapsedMs: 3000, toolCount: 1, lastTool: null, stopping: false },
  ]);

  activity.toolEnded(busy, "web_search");
  assert.equal(activity.stop(busy.id), true);
  assert.equal(activity.stop("nope"), false);
  assert.equal(idle.stopRequested, false);
  assert.deepEqual(activity.list()[0], {
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
      llamaServerRuntime: { isEnabled: () => true },
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
      assert.deepEqual(after, { runs: [] });
    });

    assert.equal(seen.runs.length, 1);
    assert.equal(seen.runs[0].lastTool, "no_such_tool");
    assert.equal(seen.runs[0].toolCount, 1);
    assert.match(refused, /Stopped by the user/);
    // The refused call never started.
    assert.deepEqual(events, [
      { name: "no_such_tool", phase: "start" },
      { name: "no_such_tool", phase: "end" },
    ]);
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
  }
});
