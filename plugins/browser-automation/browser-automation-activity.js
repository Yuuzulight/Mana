// Issue #418: a transient, in-memory activity feed (action log + latest
// screenshot) for the launcher UI to poll while browser automation runs --
// entirely separate from what browser-automation-tool-source.js returns to
// the model. Global, not per-session-scoped, matching index.js's own
// documented single-browser-session-per-process architecture. No
// persistence: this is "what's happening right now," not an audit trail --
// acp-autonomous-loop.js's own tool-call counters use the same
// process-lifetime-only Map convention for the equivalent reason.
const MAX_LOG_ENTRIES = 20;

function describeBrowserAction(action, args) {
  if (action === "navigate") return `Navigating to ${args?.url || "an unknown URL"}`;
  if (action === "click") return `Clicking element ${args?.ref ?? "?"}`;
  if (action === "type") return `Typing into element ${args?.ref ?? "?"}`;
  if (action === "snapshot") return "Reading the current page";
  return action;
}

function createBrowserActivityLog(options = {}) {
  const now = options.now || (() => new Date().toISOString());
  const maxEntries = Math.max(1, Number(options.maxEntries || MAX_LOG_ENTRIES));
  let log = [];
  let latestScreenshot = null; // { base64, at } | null

  function recordActivity({ action, args, status, error } = {}) {
    const entry = {
      action,
      status: status || "ok",
      summary:
        describeBrowserAction(action, args) +
        (status === "error" ? ` (failed: ${error || "unknown error"})` : ""),
      at: now(),
    };
    log.push(entry);
    if (log.length > maxEntries) {
      log = log.slice(log.length - maxEntries);
    }
    return entry;
  }

  // base64 is optional -- a capture failure (page mid-navigation, closed
  // tab, etc.) must never break the real tool call it happened alongside,
  // so callers pass null on failure rather than skip the call entirely.
  function recordScreenshot(base64) {
    latestScreenshot = base64 ? { base64, at: now() } : null;
  }

  function getActivity() {
    return { log, screenshot: latestScreenshot };
  }

  function reset() {
    log = [];
    latestScreenshot = null;
  }

  return { recordActivity, recordScreenshot, getActivity, reset };
}

module.exports = { createBrowserActivityLog, describeBrowserAction, MAX_LOG_ENTRIES };
