// A model-callable skill_create tool -- distinct from the idle-triggered
// autonomous skill-proposal pass (issue #262, server.js's runSkillProposal):
// that one watches for a repeated pattern nobody asked about; this one fires
// when the user directly asks mid-conversation to save something as a named
// skill ("make a skill called X that does Y"), similar in spirit to a
// skill-authoring interview -- Mana should ask clarifying questions if the
// procedure is underspecified before calling this, not guess. Same merge
// shape #169/#188/#198/#260 already established (buildToolPolicyWithMcp/
// WithMemory/WithBrowserAutomation/WithSessionSearch).
const SKILL_TOOL_PREFIX = "skill__";

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: `${SKILL_TOOL_PREFIX}create`,
      description:
        "Save a new procedural-memory skill when the user explicitly asks to create/save one, or asks Mana to remember a specific named procedure for reuse. Ask clarifying questions first if the name, when-to-use, or steps are unclear or underspecified -- don't guess at a vague procedure. Not for routine facts (use memory__remember) and not something to call speculatively; only when the user is clearly asking for a reusable skill. After a successful create, show the user what was actually saved by quoting the full skill (name, description, and body from the tool result) back in a fenced markdown code block in your reply -- that lets them review or reopen it as its own artifact, the same as any other long content Mana produces.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "A short, specific skill name (e.g. \"Restart SearXNG\"). Must not already exist.",
          },
          description: {
            type: "string",
            description: "One sentence: when should this skill be used? Shown in the retrieval index.",
          },
          body: {
            type: "string",
            description:
              "The general step-by-step procedure, written for future reuse -- not tied to this one conversation's specific instance of it.",
          },
          category: {
            type: "string",
            description: "Optional short category label. Defaults to \"general\".",
          },
        },
        required: ["name", "description", "body"],
      },
    },
  },
];

function isSkillToolName(name) {
  return typeof name === "string" && name.startsWith(SKILL_TOOL_PREFIX);
}

// options.approvalGate: required -- a skill write always goes through the
// same "skill-write" gate a human-authored Settings write does (issue #152).
// Unlike the idle-triggered proposal pass, though, the user is directly
// present asking for this right now -- same "human is right here" reasoning
// the Settings > Skills UI already uses for its own create flow -- so a
// "pending" outcome is immediately auto-decided ("allow-once") instead of
// left stuck pending with no conversational review surface.
function createSkillToolSource(options = {}) {
  const approvalGate = options.approvalGate;
  if (!approvalGate) {
    throw new Error("approvalGate is required");
  }

  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  async function executeTool(qualifiedName, args) {
    const action = qualifiedName.slice(SKILL_TOOL_PREFIX.length);
    if (action !== "create") {
      throw new Error(`unknown skill tool: ${qualifiedName}`);
    }
    const payload = {
      name: args?.name,
      description: args?.description,
      body: args?.body,
      category: args?.category,
    };

    try {
      const outcome = await approvalGate.requestApproval("skill-write", {
        summary: `Create skill "${payload.name}" (requested in conversation)`,
        payload,
        scanText: payload.body,
      });
      if (outcome.status === "pending" && outcome.requestId) {
        return JSON.stringify(await approvalGate.decide(outcome.requestId, "allow-once"));
      }
      return JSON.stringify(outcome);
    } catch (e) {
      return JSON.stringify({ status: "error", error: e.message || String(e) });
    }
  }

  return { listToolSchemas, executeTool };
}

async function buildToolPolicyWithSkillCreate(basePolicy, skillToolSource) {
  return {
    tools: [...basePolicy.tools, ...skillToolSource.listToolSchemas()],
    isKnownTool: (name) => basePolicy.isKnownTool(name) || isSkillToolName(name),
    executeTool: async (name, args) => {
      if (isSkillToolName(name)) return skillToolSource.executeTool(name, args);
      return basePolicy.executeTool(name, args);
    },
  };
}

module.exports = {
  SKILL_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isSkillToolName,
  createSkillToolSource,
  buildToolPolicyWithSkillCreate,
};
