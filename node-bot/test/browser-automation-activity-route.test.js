const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");
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
  });
});
