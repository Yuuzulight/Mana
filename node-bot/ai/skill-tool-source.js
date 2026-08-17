// A model-callable skill_create tool -- distinct from the idle-triggered
// autonomous skill-proposal pass (issue #262, server.js's runSkillProposal):
// that one watches for a repeated pattern nobody asked about; this one fires
// when the user directly asks mid-conversation to save something as a named
// skill ("make a skill called X that does Y"), similar in spirit to a
// skill-authoring interview -- Mana should ask clarifying questions if the
// procedure is underspecified before calling this, not guess. Same merge
// shape #169/#188/#198/#260 already established (buildToolPolicyWithMcp/
// WithMemory/WithBrowserAutomation/WithSessionSearch).
const { extractSkillScript, extractSkillInputs } = require("../skills-store");
const { runToolScript } = require("../tools/script-runner");

const SKILL_TOOL_PREFIX = "skill__";

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: `${SKILL_TOOL_PREFIX}view`,
      description:
        "Read a named skill's full step-by-step body. Every skill you have is listed by name and description in the system prompt's [AVAILABLE SKILLS] index -- call this when one clearly matches what's being asked, before acting, instead of guessing at the steps from the description alone.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The exact skill name, as shown in the skills index." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: `${SKILL_TOOL_PREFIX}run`,
      description:
        "Execute a skill's bundled script (a fenced ```skill-script block in its body) instead of re-deriving the same computation by reasoning through the prose. Only works for skills that actually have one -- call skill__view first if you're not sure. If the skill declares inputs (shown in skill__view's result), pass them via `inputs`, matching the declared names. The script runs in an isolated sandbox with no filesystem/network access of its own and returns whatever it returns.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The exact skill name, as shown in the skills index." },
          inputs: {
            type: "object",
            description: "Optional named input values, matching the skill's declared ```skill-inputs (if any). Available inside the script as the `inputs` object.",
          },
        },
        required: ["name"],
      },
    },
  },
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
            description:
              "A specific, assertive sentence naming exactly when to reach for this skill -- name the concrete trigger phrases or situations, not a vague summary of the steps. This is the only thing shown in the always-visible skill index (other than the name), so a vague description means this skill effectively never gets noticed later.",
          },
          body: {
            type: "string",
            description:
              "The general step-by-step procedure, written for future reuse -- not tied to this one conversation's specific instance of it. If the procedure has a genuinely deterministic, mechanical part (a computation, a format conversion), you may embed it as a fenced ```skill-script code block so skill__run can execute it directly later instead of you re-deriving it by reasoning every time -- the script has no filesystem/network access of its own, pure computation only.",
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
// options.skillsStore: required for skill__view/skill__run -- both read a
// skill's actual body, unlike skill__create which only stages one.
// options.runScript: injectable for tests; defaults to the real sandboxed
// runner (tools/script-runner.js).
function createSkillToolSource(options = {}) {
  const approvalGate = options.approvalGate;
  if (!approvalGate) {
    throw new Error("approvalGate is required");
  }
  const skillsStore = options.skillsStore;
  if (!skillsStore) {
    throw new Error("skillsStore is required");
  }
  const runScript = options.runScript || runToolScript;

  // Issue #355: registered here rather than in server.js because this module
  // already owns both the script runner and the skill lookup. Without it an
  // approved "skill-run" request would resolve to nothing.
  //
  // touch: false -- executeTool already counted this invocation when it
  // looked the skill up to check its permission, and one run should not
  // increment useCount twice.
  approvalGate.registerExecutor("skill-run", async (payload) => {
    const skill = skillsStore.viewSkill(payload?.name, { touch: false });
    if (!skill) throw new Error(`no skill named "${payload?.name}"`);
    const code = extractSkillScript(skill.body);
    if (!code) throw new Error(`"${skill.name}" has no skill-script block`);
    return runScript(code, { inputs: payload?.inputs });
  });

  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  async function executeTool(qualifiedName, args) {
    const action = qualifiedName.slice(SKILL_TOOL_PREFIX.length);

    if (action === "view") {
      const skill = skillsStore.viewSkill(args?.name);
      if (!skill) return JSON.stringify({ status: "error", error: `no skill named "${args?.name}"` });
      const inputs = extractSkillInputs(skill.body);
      return JSON.stringify({
        status: "ok",
        name: skill.name,
        description: skill.description,
        body: skill.body,
        ...(inputs.length ? { inputs } : {}),
      });
    }

    if (action === "run") {
      const skill = skillsStore.viewSkill(args?.name);
      if (!skill) return JSON.stringify({ status: "error", error: `no skill named "${args?.name}"` });
      const code = extractSkillScript(skill.body);
      if (!code) return JSON.stringify({ status: "error", error: `"${skill.name}" has no \`\`\`skill-script block` });

      // Issue #355: approval-to-exist and permission-to-run are separate
      // checks. The approval gate already decided this skill was safe to
      // keep; that says nothing about whether performing it right now,
      // unwatched, is safe. A skill marked "confirm" routes through the
      // gate on every invocation instead of executing.
      //
      // A distinct action type, for the same reason skill-proposal.js keeps
      // "skill-write-idle" apart from "skill-write": an "always allow"
      // chosen while approving a skill's *text* must not also stand as
      // blanket consent to *run* it from then on.
      if (skill.permission === "confirm") {
        try {
          const outcome = await approvalGate.requestApproval("skill-run", {
            summary: `Run skill "${skill.name}"`,
            payload: { name: skill.name, inputs: args?.inputs },
            scanText: code,
          });
          return JSON.stringify(outcome);
        } catch (e) {
          return JSON.stringify({ status: "error", error: e.message || String(e) });
        }
      }

      try {
        const { result, logs } = await runScript(code, { inputs: args?.inputs });
        return JSON.stringify({ status: "ok", result, logs });
      } catch (e) {
        return JSON.stringify({ status: "error", error: e.message || String(e) });
      }
    }

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

  return { listToolSchemas, executeTool, isKnownToolName: isSkillToolName };
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
