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
        "Draft a new procedural-memory skill when the user explicitly asks to create/save one, or asks Mana to remember a specific named procedure for reuse. Ask clarifying questions first if the name, when-to-use, or steps are unclear or underspecified -- don't guess at a vague procedure. Not for routine facts (use memory__remember) and not something to call speculatively; only when the user is clearly asking for a reusable skill. This stages the skill for approval -- it isn't saved yet, even though the user asked for it, since the draft is still your own text, not theirs verbatim; tell them it's ready to review in Settings > Skills. Quote the drafted skill (name, description, body from the tool result's payload) back in a fenced markdown code block in your reply so they can read it right away -- that also lets Mana's existing renderable-artifacts view open it as its own preview.",
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
// Deliberately NOT auto-decided here, unlike the Settings UI's own create
// flow: a Settings form submission is a human typing their own words
// directly; this tool call is the model's own inference of what the user
// meant, drafted in the model's own text. That's exactly the trust
// boundary the approval gate exists to enforce, and it stays real even
// when the user's request was genuine -- a page Mana read earlier in the
// same turn (browser automation is merged into this same tool policy)
// could otherwise talk the model into staging attacker-authored content
// that lands with no human ever looking at it. Always stays pending;
// reviewed via the Settings > Skills pending-approvals list.
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
