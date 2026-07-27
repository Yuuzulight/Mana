const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");

const KEY = "skills";
const DEFAULT_STALE_DAYS = 30;
const DEFAULT_ARCHIVE_DAYS = 90;

function registerSkillsRoutes(app, context = {}) {
  const skillsStore = context.skillsStore;

  // The cheap call (issue #140): index only, no skill body loaded.
  app.get("/skills", (req, res) => {
    try {
      return res.json({ skills: skillsStore.listSkills() });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  // The expensive call: full content, only hit when a specific skill is
  // actually being used.
  app.get("/skills/:name", (req, res) => {
    try {
      const name = requireString(req.params?.name, "name");
      const skill = skillsStore.viewSkill(name);
      if (!skill) return res.status(404).json({ error: "skill not found" });
      return res.json(skill);
    } catch (e) {
      if (e instanceof ValidationError) return sendValidationError(res, e);
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  // Gated (issue #152): a skill write is agent-authored content, so it
  // pauses for approval before taking effect instead of landing silently --
  // see approval-gate.js. The actual write only happens once approved (via
  // the "skill-write" executor registered in server.js), so a 202 here
  // means "queued for review," not "created."
  app.post("/skills", async (req, res) => {
    try {
      const name = requireString(req.body?.name, "name");
      const description = requireString(req.body?.description, "description");
      const body = requireString(req.body?.body, "body");
      const category =
        typeof req.body?.category === "string" ? req.body.category : undefined;
      const approvalGate = context.approvalGate;
      const outcome = await approvalGate.requestApproval("skill-write", {
        summary: `Create skill "${name}"`,
        payload: { name, description, body, category },
        scanText: body,
      });
      if (outcome.status === "approved") return res.status(201).json(outcome.result);
      return res.status(202).json(outcome);
    } catch (e) {
      if (e instanceof ValidationError) return sendValidationError(res, e);
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  // Manual trigger for the idle-gated prune pass -- lets the Doctor panel
  // (or a test) exercise it without waiting for real idle time. The actual
  // idle trigger lives in server.js's triggerIdleConsolidation, same as the
  // background-memory reviewer.
  app.post("/skills/prune", (req, res) => {
    try {
      const staleDays = Number(req.body?.staleDays) || DEFAULT_STALE_DAYS;
      const archiveDays = Number(req.body?.archiveDays) || DEFAULT_ARCHIVE_DAYS;
      const result = skillsStore.pruneStaleSkills({ staleDays, archiveDays });
      return res.json({ ok: true, ...result });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });
}

function normalizeText(text) {
  return String(text || "").toLowerCase();
}

function significantWords(text) {
  return [
    ...new Set(
      normalizeText(text)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    ),
  ];
}

// Keyword-match a skill's name/description against the message. Only
// contribute when something looks relevant -- registry.js's
// contributePluginPromptContext takes the first non-empty result across
// every capability in array order, so unconditionally returning the index
// here would starve every other plugin's context on every single turn.
// This mirrors ffxiv-market/stock-market's own self-guarding convention,
// just with a generic word-overlap heuristic instead of a hardcoded
// vocabulary, since skills are user-defined rather than a fixed domain.
function findMatchingSkill(skills, text) {
  const normalizedText = normalizeText(text);
  if (!normalizedText.trim()) return null;
  for (const skill of skills) {
    const namePhrase = String(skill.name || "")
      .toLowerCase()
      .replace(/[-_]+/g, " ")
      .trim();
    if (namePhrase && normalizedText.includes(namePhrase)) return skill;

    const words = significantWords(`${skill.name} ${skill.description}`);
    if (!words.length) continue;
    const hits = words.filter((w) => normalizedText.includes(w));
    if (hits.length >= Math.min(2, words.length)) return skill;
  }
  return null;
}

async function contributePromptContext(text, context = {}) {
  const skillsStore = context.skillsStore;
  if (!skillsStore) return "";
  const skills = skillsStore.listSkills();
  const matched = findMatchingSkill(skills, text);
  if (!matched) return "";
  const full = skillsStore.viewSkill(matched.name);
  if (!full) return "";
  return `[SKILL: ${full.name}]\n${full.body}\n[END SKILL]`;
}

const skillsCapability = {
  key: KEY,
  registerRoutes: registerSkillsRoutes,
  contributePromptContext,
  getHealth: (context = {}) => {
    const skillsStore = context.skillsStore;
    const count = skillsStore ? skillsStore.listSkills().length : 0;
    return {
      status: "configured",
      configured: true,
      message: `${count} skill(s) available.`,
      count,
    };
  },
};

module.exports = {
  registerSkillsRoutes,
  skillsCapability,
  findMatchingSkill,
};
