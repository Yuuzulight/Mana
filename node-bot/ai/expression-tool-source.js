// A single LLM-callable tool that lets Mana pick her own Live2D expression
// mid-reply, instead of only ever reacting to reply-emotion.js's coarse
// keyword/emoji-detected state bucket (issue #253). No persisted write and
// no approval-gate needed -- unlike skill__create, picking a transient
// expression for one reply has no lasting effect to review. Same merge
// shape every other tool source uses (ai/tool-source.js's buildToolPolicy).
//
// Deliberately does no validation against a "real" expression list: node-bot
// has no way to know what Live2D model (if any) is currently loaded
// client-side, and expressionForState's existing fuzzy-match
// (live2d-logic.js, both apps) already degrades gracefully on an
// unrecognized name, falling through to the normal state-based preference
// list exactly as if this tool had never been called.
const EXPRESSION_TOOL_PREFIX = "expression__";
const MAX_EXPRESSION_NAME_CHARS = 40;

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: `${EXPRESSION_TOOL_PREFIX}set`,
      description:
        "Set your own Live2D facial expression for this reply, when a specific expression fits better than automatic mood detection would guess (e.g. a wink, a smirk, a specific named expression you know this model has). Optional -- most replies don't need this; automatic detection already handles ordinary excited/angry/sad/disgusted reactions.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The expression's name, matched case-insensitively against whatever expressions the currently-loaded Live2D model actually has. If it doesn't match anything, this is silently ignored and automatic detection is used instead.",
          },
        },
        required: ["name"],
      },
    },
  },
];

function isExpressionToolName(name) {
  return typeof name === "string" && name.startsWith(EXPRESSION_TOOL_PREFIX);
}

function createExpressionToolSource() {
  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  async function executeTool(qualifiedName, args) {
    const action = qualifiedName.slice(EXPRESSION_TOOL_PREFIX.length);
    if (action !== "set") {
      throw new Error(`unknown expression tool: ${qualifiedName}`);
    }
    const name = String(args?.name || "").trim().slice(0, MAX_EXPRESSION_NAME_CHARS);
    if (!name) {
      throw new Error("name is required");
    }
    return JSON.stringify({ ok: true, expression: name });
  }

  return { listToolSchemas, executeTool, isKnownToolName: isExpressionToolName };
}

module.exports = {
  EXPRESSION_TOOL_PREFIX,
  TOOL_SCHEMAS,
  MAX_EXPRESSION_NAME_CHARS,
  isExpressionToolName,
  createExpressionToolSource,
};
