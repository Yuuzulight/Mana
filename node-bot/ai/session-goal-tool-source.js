// Issue #401: lets Mana genuinely finish a multi-round tool-calling reply
// early when she decides the session's user-stated goal has been reached,
// instead of only stopping when she naturally runs out of tool calls to
// make or the loop hits its round/time/error caps. Only offered (see
// server.js's tool-source array construction) when a session actually has
// a goal set -- there'd be nothing to finish otherwise.
//
// The goal itself is set via acp-memory-store.js's setSessionGoal, by the
// user only -- never by the model. Per #401's own scoping: "an inferred
// goal that is subtly wrong is worse than none, because the loop would
// then pursue it confidently." This tool only lets the model SIGNAL it
// believes the stated goal is done; it cannot set or change the goal.
const SESSION_GOAL_TOOL_PREFIX = "session_goal__";
const SESSION_GOAL_FINISH_TOOL_NAME = `${SESSION_GOAL_TOOL_PREFIX}finish`;

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: SESSION_GOAL_FINISH_TOOL_NAME,
      description:
        "Call this when you believe the session's stated goal has been fully achieved, to stop working and give your final answer now instead of continuing to use more tools.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "One short sentence on why the goal is now met.",
          },
        },
        required: ["reason"],
      },
    },
  },
];

function isSessionGoalToolName(name) {
  return typeof name === "string" && name.startsWith(SESSION_GOAL_TOOL_PREFIX);
}

function createSessionGoalToolSource() {
  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  async function executeTool(qualifiedName, args) {
    if (qualifiedName !== SESSION_GOAL_FINISH_TOOL_NAME) {
      throw new Error(`unknown session_goal tool: ${qualifiedName}`);
    }
    const reason = String(args?.reason || "").trim();
    if (!reason) {
      throw new Error("reason is required");
    }
    return JSON.stringify({ status: "ok", finished: true, reason });
  }

  return { listToolSchemas, executeTool, isKnownToolName: isSessionGoalToolName };
}

module.exports = {
  SESSION_GOAL_TOOL_PREFIX,
  SESSION_GOAL_FINISH_TOOL_NAME,
  TOOL_SCHEMAS,
  isSessionGoalToolName,
  createSessionGoalToolSource,
};
