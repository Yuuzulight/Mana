// Issue #188: exposes browser-automation's navigate/click/type/snapshot as
// tool-calling schemas, reusing the same live session index.js's own HTTP
// routes use (its exported getSession) -- a tool-calling-initiated browser
// action and an HTTP-route-initiated one operate on the same tab, not two
// separate Chromium instances.
const BROWSER_TOOL_PREFIX = "browser_automation__";
// Gates the *first* tool-calling use, not every individual call -- once a
// human "always-allow"s this actionType, subsequent navigate/click/type/
// snapshot calls execute immediately, same as approval-gate.js's existing
// design for any other already-trusted action. Blocking every single call
// on a human would freeze the tool-calling loop mid-reply, which nothing
// else in this codebase does either (read_file has never needed approval;
// an MCP server's tools are approved once, at registration, not per call).
const APPROVAL_ACTION_TYPE = "browser-automation-tool-use";

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: `${BROWSER_TOOL_PREFIX}navigate`,
      description: "Navigate the browser to a URL and return a snapshot of the resulting page.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The http(s) URL to navigate to." } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: `${BROWSER_TOOL_PREFIX}snapshot`,
      description: "Read the current page: title, URL, visible text, and interactive elements with their refs.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: `${BROWSER_TOOL_PREFIX}click`,
      description: "Click an interactive element on the current page by its ref (from a prior snapshot).",
      parameters: {
        type: "object",
        properties: { ref: { type: "string", description: "The element's data-mana-ref, from a prior snapshot." } },
        required: ["ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: `${BROWSER_TOOL_PREFIX}type`,
      description: "Type text into an interactive element on the current page by its ref (from a prior snapshot).",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "The element's data-mana-ref, from a prior snapshot." },
          text: { type: "string", description: "The text to type." },
        },
        required: ["ref", "text"],
      },
    },
  },
];

function isBrowserAutomationToolName(name) {
  return typeof name === "string" && name.startsWith(BROWSER_TOOL_PREFIX);
}

// options.getSession: browser-automation/index.js's exported getSession.
// options.approvalGate: required -- gates first tool-calling use.
// options.sessionDeps: forwarded to getSession() (env/chromium overrides).
function createBrowserAutomationToolSource(options = {}) {
  const getSession = options.getSession;
  const approvalGate = options.approvalGate;
  const sessionDeps = options.sessionDeps || {};

  if (!approvalGate) {
    throw new Error("an approvalGate is required");
  }
  approvalGate.registerExecutor(APPROVAL_ACTION_TYPE, async () => ({ approved: true }));

  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  async function executeTool(qualifiedName, args) {
    if (!approvalGate.isAlwaysAllowed(APPROVAL_ACTION_TYPE)) {
      // Not yet trusted -- ask, and report back through the same
      // error-to-the-model path runToolAwareReply already uses for a
      // failed tool call (see tool-policy.js's ToolPolicyError handling),
      // rather than blocking this call on a human decision.
      const result = await approvalGate.requestApproval(APPROVAL_ACTION_TYPE, {
        summary: "Allow Mana to use browser-automation (navigate/click/type/snapshot) as a tool during replies",
        payload: null,
      });
      throw new Error(
        result.status === "pending"
          ? `browser-automation tool use needs approval first (request ${result.requestId}) -- see GET /approvals/pending`
          : "browser-automation tool use is not approved",
      );
    }

    const action = qualifiedName.slice(BROWSER_TOOL_PREFIX.length);
    const session = await getSession(sessionDeps);
    let result;
    if (action === "navigate") result = await session.navigate(args?.url);
    else if (action === "snapshot") result = await session.snapshot();
    else if (action === "click") result = await session.click(args?.ref);
    else if (action === "type") result = await session.type(args?.ref, args?.text);
    else throw new Error(`unknown browser-automation tool: ${qualifiedName}`);
    return JSON.stringify(result);
  }

  return { listToolSchemas, executeTool };
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
  isBrowserAutomationToolName,
  createBrowserAutomationToolSource,
  buildToolPolicyWithBrowserAutomation,
};
