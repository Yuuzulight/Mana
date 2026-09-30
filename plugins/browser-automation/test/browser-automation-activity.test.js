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

test("the current page and this turn's fetched pages are kept until the next ones, and reset clears them", () => {
  const log = createBrowserActivityLog();
  log.recordPage({ url: "https://a.test/", title: "A", text: "not kept" });
  log.recordTurnPages([{ source: "web search", url: "https://b.test/" }]);
  assert.deepEqual(log.getActivity().page, { url: "https://a.test/", title: "A" });
  assert.deepEqual(log.getActivity().turnPages, [{ source: "web search", url: "https://b.test/" }]);
  log.recordTurnPages(undefined);
  assert.deepEqual(log.getActivity().turnPages, []);
  log.reset();
  assert.equal(log.getActivity().page, null);
});

test("describeBrowserAction covers every known action and falls back to the raw name", () => {
  const { describeBrowserAction } = require("../browser-automation-activity");
  assert.match(describeBrowserAction("navigate", { url: "https://x.test" }), /Navigating to https:\/\/x\.test/);
  assert.match(describeBrowserAction("click", { ref: "9" }), /Clicking element 9/);
  assert.match(describeBrowserAction("type", { ref: "2" }), /Typing into element 2/);
  assert.equal(describeBrowserAction("snapshot", {}), "Reading the current page");
  assert.equal(describeBrowserAction("something_else", {}), "something_else");
});

test("#1137: isWatched is true for 5 seconds after the Browser panel reads the feed", () => {
  let clock = 1000;
  const log = createBrowserActivityLog({ clock: () => clock });
  assert.equal(log.isWatched(), false);
  log.getActivity();
  clock += 4999;
  assert.equal(log.isWatched(), true);
  clock += 1;
  assert.equal(log.isWatched(), false);
});
