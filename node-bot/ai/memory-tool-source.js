// Issue #198: an explicit "hot path" memory tool -- lets Mana save/update/
// forget a specific fact mid-reply when something is clearly worth
// persisting right now, distinct from the passive idle-triggered
// consolidation ("Dream Mode", server.js) and the automatic getRelatedFacts
// injection (acp-memory-store.js), which only ever infer facts, never let
// the model assert one directly. Same merge shape #169/#188 already
// established (buildToolPolicyWithMcp/buildToolPolicyWithBrowserAutomation)
// -- combines a base {tools, isKnownTool, executeTool} policy with this
// source's tool into one object matching that exact shape.
const MEMORY_TOOL_PREFIX = "memory__";

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: `${MEMORY_TOOL_PREFIX}remember`,
      description:
        "Explicitly save, update, or forget a specific fact worth remembering across future conversations -- for something clearly worth persisting right now (a stated preference, a correction, a decision), not for routine chat, which is already remembered automatically.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "A short, stable label for this fact (e.g. \"Aurora's GPU\"), used to find/update/forget it later. Reuse the same key to update or forget an existing fact.",
          },
          text: {
            type: "string",
            description: "The fact itself, as a short sentence. Required unless action is \"remove\".",
          },
          action: {
            type: "string",
            enum: ["insert", "patch", "remove"],
            description:
              "\"insert\" (default): save as a new fact. \"patch\": update the existing fact with this key (or insert if none exists yet). \"remove\": mark the existing fact with this key as no longer current.",
          },
        },
        required: ["key"],
      },
    },
  },
];

function isMemoryToolName(name) {
  return typeof name === "string" && name.startsWith(MEMORY_TOOL_PREFIX);
}

// options.acpMemoryStore: required.
// options.sessionId: bound at creation time, not trusted from model-supplied
// args -- same "server-managed context, not model-supplied identifiers"
// principle browser-automation's tool source already follows for its
// session.
// options.approvalGate: optional, matching issue #152's existing skill-write
// gating -- when provided, a remember call is staged for approval the same
// way a skill write is, instead of landing immediately. Omitted in
// tests/callers that don't wire one, which write immediately (back-compat).
function createMemoryToolSource(options = {}) {
  const acpMemoryStore = options.acpMemoryStore;
  const sessionId = options.sessionId || null;
  const approvalGate = options.approvalGate || null;
  if (!acpMemoryStore) {
    throw new Error("acpMemoryStore is required");
  }

  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  async function executeTool(qualifiedName, args) {
    const action = qualifiedName.slice(MEMORY_TOOL_PREFIX.length);
    if (action !== "remember") {
      throw new Error(`unknown memory tool: ${qualifiedName}`);
    }
    const payload = {
      sessionId,
      key: args?.key,
      text: args?.text,
      action: args?.action,
    };

    if (!approvalGate) {
      return JSON.stringify(acpMemoryStore.rememberFact(payload));
    }

    const outcome = await approvalGate.requestApproval("memory-write", {
      summary: `Remember "${payload.key}"${payload.text ? `: ${payload.text}` : ""}`,
      payload,
      scanText: payload.text,
    });
    return JSON.stringify(outcome);
  }

  return { listToolSchemas, executeTool };
}

async function buildToolPolicyWithMemory(basePolicy, memoryToolSource) {
  return {
    tools: [...basePolicy.tools, ...memoryToolSource.listToolSchemas()],
    isKnownTool: (name) => basePolicy.isKnownTool(name) || isMemoryToolName(name),
    executeTool: async (name, args) => {
      if (isMemoryToolName(name)) return memoryToolSource.executeTool(name, args);
      return basePolicy.executeTool(name, args);
    },
  };
}

module.exports = {
  MEMORY_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isMemoryToolName,
  createMemoryToolSource,
  buildToolPolicyWithMemory,
};
