const assert = require("node:assert/strict");
const test = require("node:test");

const { createBrowserActivityLog } = require("../browser-automation-activity");

test("recordActivity builds a readable summary and getActivity returns it", () => {
  const log = createBrowserActivityLog({ now: () => "2026-01-01T00:00:00.000Z" });

  log.recordActivity({ action: "navigate", args: { url: "https://example.com" }, status: "ok" });
  const { log: entries } = log.getActivity();

  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "navigate");
  assert.equal(entries[0].status, "ok");
  assert.equal(entries[0].summary, "Navigating to https://example.com");
  assert.equal(entries[0].at, "2026-01-01T00:00:00.000Z");
});

test("recordActivity folds the error message into the summary on failure", () => {
  const log = createBrowserActivityLog();
  log.recordActivity({ action: "click", args: { ref: "5" }, status: "error", error: "element not found" });

  const { log: entries } = log.getActivity();
  assert.equal(entries[0].status, "error");
  assert.match(entries[0].summary, /Clicking element 5 \(failed: element not found\)/);
});

test("recordActivity caps the log at maxEntries, dropping the oldest first", () => {
  const log = createBrowserActivityLog({ maxEntries: 3 });
  ["a", "b", "c", "d", "e"].forEach((name) =>
    log.recordActivity({ action: name, args: {}, status: "ok" }),
  );
  const { log: entries } = log.getActivity();
  assert.deepEqual(entries.map((e) => e.action), ["c", "d", "e"]);
});

test("recordScreenshot stores and clears the latest screenshot", () => {
  const log = createBrowserActivityLog({ now: () => "2026-01-01T00:00:00.000Z" });

  log.recordScreenshot("base64-jpeg-data");
  assert.deepEqual(log.getActivity().screenshot, { base64: "base64-jpeg-data", at: "2026-01-01T00:00:00.000Z" });

  log.recordScreenshot(null);
  assert.equal(log.getActivity().screenshot, null);
});

test("reset clears both the log and the latest screenshot", () => {
  const log = createBrowserActivityLog();
  log.recordActivity({ action: "navigate", args: { url: "https://example.com" } });
  log.recordScreenshot("some-base64");

  log.reset();
  const activity = log.getActivity();
  assert.deepEqual(activity.log, []);
  assert.equal(activity.screenshot, null);
});

test("describeBrowserAction covers every known action and falls back to the raw name", () => {
  const { describeBrowserAction } = require("../browser-automation-activity");
  assert.match(describeBrowserAction("navigate", { url: "https://x.test" }), /Navigating to https:\/\/x\.test/);
  assert.match(describeBrowserAction("click", { ref: "9" }), /Clicking element 9/);
  assert.match(describeBrowserAction("type", { ref: "2" }), /Typing into element 2/);
  assert.equal(describeBrowserAction("snapshot", {}), "Reading the current page");
  assert.equal(describeBrowserAction("something_else", {}), "something_else");
});
