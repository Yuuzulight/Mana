const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer, useTestAdminToken } = require("./helpers");

// Every route but a few public ones needs an admin key (admin-key.js).
const fetch = useTestAdminToken();
const {
  createBrowserActivityLog,
} = require("../../plugins/browser-automation/browser-automation-activity");

// Issue #418: GET /browser-automation/activity is a thin read-only window
// onto whatever activityLog the running browserAutomationToolSource is
// already writing to -- this test only proves the route reads the right
// instance and shapes the response correctly; browser-automation-tool-
// source.test.js already covers the log/screenshot recording logic itself.
function makeFakeToolSource(activityLog) {
  return {
    listToolSchemas: () => [],
    isKnownToolName: () => false,
    executeTool: async () => {
      throw new Error("not used in this test");
    },
    activityLog,
  };
}

test("GET /browser-automation/activity returns the current log and screenshot", async () => {
  const activityLog = createBrowserActivityLog({ now: () => "2026-01-01T00:00:00.000Z" });
  activityLog.recordActivity({ action: "navigate", args: { url: "https://example.com" }, status: "ok" });
  activityLog.recordScreenshot("base64-jpeg-data");

  const app = createApp({ browserAutomationToolSource: makeFakeToolSource(activityLog) });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/browser-automation/activity`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.log.length, 1);
    assert.equal(body.log[0].action, "navigate");
    assert.match(body.log[0].summary, /Navigating to https:\/\/example\.com/);
    assert.deepEqual(body.screenshot, { base64: "base64-jpeg-data", at: "2026-01-01T00:00:00.000Z" });
  });
});

test("GET /browser-automation/activity returns an empty log and null screenshot before anything has happened", async () => {
  const activityLog = createBrowserActivityLog();
  const app = createApp({ browserAutomationToolSource: makeFakeToolSource(activityLog) });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/browser-automation/activity`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.log, []);
    assert.equal(body.screenshot, null);
    // #1139: nobody has taken over, and she isn't asking.
    assert.deepEqual(body.takeOver, { active: false, needsYou: null });
  });
});

test("GET /browser-automation/activity/stream sends an initial snapshot and live screencast updates", async () => {
  const activityLog = createBrowserActivityLog({ now: () => "2026-01-01T00:00:00.000Z" });
  const app = createApp({ browserAutomationToolSource: makeFakeToolSource(activityLog) });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/browser-automation/activity/stream`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    async function nextEvent() {
      while (!buffered.includes("\n\n")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      const [event, ...rest] = buffered.split("\n\n");
      buffered = rest.join("\n\n");
      return JSON.parse(event.replace(/^data: /, ""));
    }

    const initial = await nextEvent();
    assert.deepEqual(initial.log, []);
    assert.equal(initial.screenshot, null);

    activityLog.recordScreencastFrame({ data: "live-frame", width: 640, height: 360 });
    const update = await nextEvent();
    assert.deepEqual(update.screenshot, {
      base64: "live-frame",
      at: "2026-01-01T00:00:00.000Z",
      source: "screencast",
      width: 640,
      height: 360,
    });
    await reader.cancel();
  });
});

test("#1161: GET /browser-automation/site-test serves the latest report in the reader's shape, 404 before one", async () => {
  const activityLog = createBrowserActivityLog();
  const app = createApp({ browserAutomationToolSource: makeFakeToolSource(activityLog) });
  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/browser-automation/site-test`)).status, 404);
    activityLog.recordSiteTest({ title: "Site test: a.test", text: "# Site test: a.test", images: { "shot-1": "data:image/jpeg;base64,AAA" } });
    const body = await (await fetch(`${baseUrl}/browser-automation/site-test`)).json();
    assert.deepEqual(body, { url: "", title: "Site test: a.test", text: "# Site test: a.test", images: { "shot-1": "data:image/jpeg;base64,AAA" }, truncated: false, needsBrowser: null });
  });
});
