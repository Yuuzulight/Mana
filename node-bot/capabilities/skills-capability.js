const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");
const { significantWords: sharedSignificantWords } = require("../utils/word-overlap");
const { readSkillFolder } = require("../skills-store");

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
  // actually being used. ?touch=false skips the lastUsed/un-stale bump --
  // opening a skill to *browse or edit* isn't the same as Mana actually
  // reaching for it, and skipping the write is what the editor's Cancel
  // button needs to be a true no-op instead of quietly touching usage.
  app.get("/skills/:name", (req, res) => {
    try {
      const name = requireString(req.params?.name, "name");
      const touch = req.query?.touch !== "false";
      const skill = skillsStore.viewSkill(name, { touch });
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

  // Issue #664: import a SKILL.md folder (OpenClaw/AgentSkills). Always a
  // pending proposal -- forceReview, so no always-allow, session grant or
  // Guardian verdict can wave a third-party skill through -- whose summary
  // names its files, scripts and requirements. The files are read now and
  // carried in the request, so approving writes exactly what was shown.
  // Nothing in the folder runs, on import or on approval.
  // Local-only: it reads a path on this PC.
  context.approvalGate?.registerExecutor?.("skill-import", (payload) => skillsStore.importSkill(payload));

  // Q20: Settings > Skills' "Imported skills" choice -- free, each (ask
  // every time) or first (ask the first time; the default). Changing it is
  // local-only, like import: it loosens or tightens a safety gate.
  app.get("/skill-settings", (req, res) => {
    return res.json({ importedSkillUse: skillsStore.getImportedSkillUse() });
  });
  app.put("/skill-settings", (req, res) => {
    try {
      if (typeof context.isLocalRestartRequest !== "function" || !context.isLocalRestartRequest(req)) {
        return res.status(403).json({ error: "this endpoint is only available from this PC" });
      }
      skillsStore.setImportedSkillUse(req.body?.importedSkillUse);
      return res.json({ importedSkillUse: skillsStore.getImportedSkillUse() });
    } catch (e) {
      return res.status(400).json({ error: e.message || String(e) });
    }
  });
  app.post("/skills/import", async (req, res) => {
    try {
      if (typeof context.isLocalRestartRequest !== "function" || !context.isLocalRestartRequest(req)) {
        return res.status(403).json({ error: "this endpoint is only available from this PC" });
      }
      const folder = readSkillFolder(requireString(req.body?.path, "path"));
      const outcome = await context.approvalGate.requestApproval("skill-import", {
        summary: [
          `Import skill "${folder.name}" -- ${folder.files.length} file(s)`,
          folder.scripts.length ? `scripts (never run on import): ${folder.scripts.join(", ")}` : "no scripts",
          folder.requires.length ? `needs ${folder.requires.join(", ")}` : "",
        ].filter(Boolean).join("; "),
        payload: { files: folder.files },
        scanText: folder.files.filter((f) => f.encoding === "utf8").map((f) => f.content).join("\n"),
        forceReview: true,
        details: {
          name: folder.name,
          description: folder.description,
          files: folder.files.map((f) => f.path),
          scripts: folder.scripts,
          requires: folder.requires,
        },
      });
      return res.status(202).json(outcome);
    } catch (e) {
      if (e instanceof ValidationError) return sendValidationError(res, e);
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  // Direct human edit from the Settings > Skills UI -- unlike POST /skills
  // above, not approval-gated: a Settings form submission already is the
  // human decision the gate exists to require for agent-authored writes.
  app.patch("/skills/:name", (req, res) => {
    try {
      const name = requireString(req.params?.name, "name");
      const updates = {};
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "description")) {
        updates.description = requireString(req.body.description, "description");
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "body")) {
        updates.body = requireString(req.body.body, "body");
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "category")) {
        // null is an explicit "clear it back to general" request, distinct
        // from omitting the field entirely (which the hasOwnProperty guard
        // above already excludes) -- passed straight through so
        // updateSkill can tell the two apart. Anything else (a number,
        // array, object) is a malformed request, not a silent no-op.
        if (req.body.category !== null && typeof req.body.category !== "string") {
          throw new ValidationError("category must be a string or null");
        }
        updates.category = req.body.category;
      }
      const skill = skillsStore.updateSkill(name, updates);
      if (!skill) return res.status(404).json({ error: "skill not found" });
      return res.json(skill);
    } catch (e) {
      if (e instanceof ValidationError) return sendValidationError(res, e);
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  // Direct human delete from Settings > Skills -- permanent, distinct from
  // the idle prune pass's archive-to-.archive/ behavior below.
  app.delete("/skills/:name", (req, res) => {
    try {
      const name = requireString(req.params?.name, "name");
      const deleted = skillsStore.deleteSkill(name);
      if (!deleted) return res.status(404).json({ error: "skill not found" });
      return res.json({ deleted: true, name });
    } catch (e) {
      if (e instanceof ValidationError) return sendValidationError(res, e);
      console.error(e);
      return res.status(500).json({ error: String(e) });
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

  // Manual trigger for the idle-gated skill-proposal pass (issue #262) --
  // same "let the Doctor panel/tests exercise it without waiting for real
  // idle time" reasoning as /skills/prune above. The actual idle trigger
  // lives in server.js's triggerIdleConsolidation.
  app.post("/skills/propose", async (req, res) => {
    try {
      const runSkillProposal = context.runSkillProposalPublic;
      if (typeof runSkillProposal !== "function") {
        return res.status(500).json({ ok: false, error: "skill proposal pass not available" });
      }
      const result = await runSkillProposal({
        skillsStore: context.skillsStore,
        approvalGate: context.approvalGate,
      });
      return res.json(result);
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
  return sharedSignificantWords(normalizeText(text));
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
  // A skill that cannot run here (wrong OS, missing binary -- see
  // listSkills' missingRequirements) is still listed, just never offered.
  const skills = skillsStore.listSkills().filter((skill) => skill.available !== false);
  const matched = findMatchingSkill(skills, text);
  if (!matched) return "";
  const full = skillsStore.viewSkill(matched.name, { touch: false });
  if (!full) return "";
  // Q20: an imported skill's text only goes in unasked when Settings > Skills
  // allows it; otherwise Mana reaches it through skill__view, which asks.
  if (full.dir && !skillsStore.mayUseImportedSkill?.(full.name)) return "";
  skillsStore.touchSkillUsage?.(full.name);
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
