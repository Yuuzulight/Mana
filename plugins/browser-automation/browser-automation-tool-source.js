// Issue #188: exposes browser-automation's navigate/click/type/snapshot as
// tool-calling schemas, reusing the same live session index.js's own HTTP
// routes use (its exported getSession) -- a tool-calling-initiated browser
// action and an HTTP-route-initiated one operate on the same tab, not two
// separate Chromium instances.
const { createBrowserActivityLog } = require("./browser-automation-activity");
const { wrapUntrusted } = require("../../node-bot/ai/untrusted-content");

const BROWSER_TOOL_PREFIX = "browser_automation__";
// Gates the *first* tool-calling use, not every individual call -- once a
// human "always-allow"s this actionType, subsequent navigate/click/type/
// snapshot calls execute immediately, same as approval-gate.js's existing
// design for any other already-trusted action. Blocking every single call
// on a human would freeze the tool-calling loop mid-reply, which nothing
// else in this codebase does either (read_file has never needed approval;
// an MCP server's tools are approved once, at registration, not per call).
const APPROVAL_ACTION_TYPE = "browser-automation-tool-use";

const REF_PARAM = { type: "string", description: "The element's ref from the page snapshot, like e5." };
function tool(name, description, properties = {}, required = []) {
  return {
    type: "function",
    function: { name: `${BROWSER_TOOL_PREFIX}${name}`, description, parameters: { type: "object", properties, required } },
  };
}

// #1138: a small vocabulary, acting by the snapshot's refs.
const TOOL_SCHEMAS = [
  tool("navigate", "Open an http(s) URL in her browser and read the page.", {
    url: { type: "string", description: "The http(s) URL to open." },
  }, ["url"]),
  tool("snapshot", "Read the current page again: its interactive elements with their refs, and a short text excerpt."),
  tool("click", "Click an element by its ref.", { ref: REF_PARAM }, ["ref"]),
  tool("type", "Replace the text in a field by its ref; submit presses Enter after.", {
    ref: REF_PARAM,
    text: { type: "string", description: "The text to put in the field." },
    submit: { type: "boolean", description: "Press Enter after typing (e.g. to search)." },
  }, ["ref", "text"]),
  tool("select", "Choose an option in a dropdown by its ref.", {
    ref: REF_PARAM,
    value: { type: "string", description: "The option's label or value." },
  }, ["ref", "value"]),
  tool("scroll", "Scroll the page by most of a screen, to load more of it.", {
    direction: { type: "string", enum: ["down", "up"] },
  }, ["direction"]),
  tool("back", "Go back to the previous page."),
];
const ACTIONS = TOOL_SCHEMAS.map((t) => t.function.name.slice(BROWSER_TOOL_PREFIX.length));

// What the model reads: everything from the page sits inside one untrusted
// frame.
function describeForModel(result) {
  const lines = [`URL: ${result.url}`, `Title: ${result.title}`, ""];
  if (result.elements) {
    lines.push("Interactive elements:", ...result.elements);
  } else if (result.added.length || result.removed.length) {
    lines.push("Changed elements (the rest are as in the last snapshot):");
    lines.push(...result.added.map((l) => `new: ${l}`), ...result.removed.map((l) => `gone: ${l}`));
  } else {
    lines.push("The elements didn't change.");
  }
  if (result.text !== undefined) lines.push("", "Page text (start):", result.text);
  return wrapUntrusted("browser page", lines.join("\n"));
}

function isBrowserAutomationToolName(name) {
  return typeof name === "string" && name.startsWith(BROWSER_TOOL_PREFIX);
}

// options.getSession: browser-automation/index.js's exported getSession.
// options.approvalGate: required -- gates first tool-calling use.
// options.sessionDeps: forwarded to getSession() (env/chromium overrides).
// options.activityLog: issue #418's human-facing activity feed -- defaults
// to a fresh one, but server.js passes a shared instance so its own
// GET /browser-automation/activity route reads from the same log this
// tool source writes to.
function createBrowserAutomationToolSource(options = {}) {
  const getSession = options.getSession;
  const approvalGate = options.approvalGate;
  const sessionDeps = options.sessionDeps || {};
  const activityLog = options.activityLog || createBrowserActivityLog();

  if (!approvalGate) {
    throw new Error("an approvalGate is required");
  }
  approvalGate.registerExecutor(APPROVAL_ACTION_TYPE, async () => ({ approved: true }));

  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  async function executeTool(qualifiedName, args) {
    // isGranted, not isAlwaysAllowed: an "allow for this session" (#669)
    // counts too.
    if (!approvalGate.isGranted(APPROVAL_ACTION_TYPE)) {
      // Not yet trusted -- ask, and report back through the same
      // error-to-the-model path runToolAwareReply already uses for a
      // failed tool call (see tool-policy.js's ToolPolicyError handling),
      // rather than blocking this call on a human decision.
      const result = await approvalGate.requestApproval(APPROVAL_ACTION_TYPE, {
        summary: "Allow Mana to use browser-automation (open, read, click, type, select, scroll, back) as a tool during replies",
        payload: null,
      });
      throw new Error(
        result.status === "pending"
          ? `browser-automation tool use needs approval first (request ${result.requestId}) -- see GET /approvals/pending`
          : "browser-automation tool use is not approved",
      );
    }

    const action = qualifiedName.slice(BROWSER_TOOL_PREFIX.length);
    if (!ACTIONS.includes(action)) {
      throw new Error(`unknown browser-automation tool: ${qualifiedName}`);
    }

    // #1137: her page loads images only while the Browser panel watches.
    const session = await getSession({ ...sessionDeps, isWatched: activityLog.isWatched });
    let result;
    try {
      if (action === "navigate") result = await session.navigate(args?.url);
      else if (action === "snapshot") result = await session.snapshot();
      else if (action === "click") result = await session.click(args?.ref);
      else if (action === "type") result = await session.type(args?.ref, args?.text, args?.submit === true);
      else if (action === "select") result = await session.select(args?.ref, args?.value);
      else if (action === "scroll") result = await session.scroll(args?.direction);
      else result = await session.back();
    } catch (err) {
      // Issue #418: the launcher's activity feed should show a failed step
      // too ("clicking element 5 -- failed"), not just successful ones --
      // the human watching benefits from seeing where it got stuck. The
      // real error still propagates to the model unchanged.
      activityLog.recordActivity({ action, args, status: "error", error: err.message });
      throw err;
    }

    activityLog.recordActivity({ action, args, status: "ok" });
    activityLog.recordPage(result);
    // Screenshots are for the Browser panel only, taken while it's on
    // screen. Best-effort: a capture failure (page mid-navigation, tab
    // closed) must never break the real tool call it happened alongside.
    // Wrapped in try/catch, not just a .catch() on the call, so a session
    // that doesn't even expose screenshot as a function (a synchronous
    // TypeError, not a rejected promise) is caught the same way.
    // An unwatched step clears the old one: it showed an earlier page.
    let screenshotBase64 = null;
    try {
      if (activityLog.isWatched()) screenshotBase64 = await session.screenshot();
    } catch (e) {
      screenshotBase64 = null;
    }
    activityLog.recordScreenshot(screenshotBase64);

    return describeForModel(result);
  }

  return {
    listToolSchemas,
    executeTool,
    isKnownToolName: isBrowserAutomationToolName,
    activityLog,
  };
}

// Same merge shape #169's buildToolPolicyWithMcp already established --
// combines a base {tools, isKnownTool, executeTool} policy with this
// source's tools into one object matching that exact shape.
async function buildToolPolicyWithBrowserAutomation(basePolicy, browserToolSource) {
  return {
    tools: [...basePolicy.tools, ...browserToolSource.listToolSchemas()],
    isKnownTool: (name) => basePolicy.isKnownTool(name) || isBrowserAutomationToolName(name),
    executeTool: async (name, args) => {
      if (isBrowserAutomationToolName(name)) return browserToolSource.executeTool(name, args);
      return basePolicy.executeTool(name, args);
    },
  };
}

module.exports = {
  BROWSER_TOOL_PREFIX,
  APPROVAL_ACTION_TYPE,
  TOOL_SCHEMAS,
  describeForModel,
  isBrowserAutomationToolName,
  createBrowserAutomationToolSource,
  buildToolPolicyWithBrowserAutomation,
};
