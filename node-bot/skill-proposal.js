// Idle-triggered skill-proposal pass (issue #262): reviews recent session
// summaries for a genuinely reusable, repeated multi-step pattern and
// stages -- never writes directly -- a new skill proposal through the
// approval gate (issue #152). Conservative by design: most idle reviews
// find nothing, and finding something never skips approval -- there's no
// "auto-apply" mode here, only "propose" (default) or "off".
//
// Extracted out of server.js's background-memory closure into its own
// module (matching skills-store.js/approval-gate.js/session-search-index.js's
// existing pattern) so its actual logic -- JSON-parse-with-fallback, the
// min-summaries/mode gating, the dedup check -- is directly unit testable
// instead of only reachable through a fully-mocked HTTP route.
const { findMatchingSkill } = require("./capabilities/skills-capability");

// Uses its own distinct action type ("skill-write-idle") rather than
// reusing "skill-write" -- if a user ever picks "always-allow" while
// reviewing a manual/conversational skill write, that shouldn't silently
// also auto-apply every future *autonomous* proposal nobody's reviewed.
const IDLE_SKILL_WRITE_ACTION = "skill-write-idle";

// A summary containing the prompt's own literal delimiter text (plausible
// if it summarized attacker-controlled page content Mana browsed) could
// otherwise break the BEGIN/END framing and inject its own instructions.
// Neutered, not stripped, so the summary's actual content is unchanged.
function neuterDelimiters(text) {
  return String(text || "")
    .replace(/BEGIN SUMMARIES/gi, "[begin summaries]")
    .replace(/END SUMMARIES/gi, "[end summaries]");
}

function extractJson(reply) {
  try {
    return JSON.parse(reply);
  } catch (e) {
    const m = reply.match(/\{[\s\S]*\}/m);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (e2) {
      return null;
    }
  }
}

// options: the real implementations, bound once at construction time.
// skillsStore/approvalGate here are just the defaults -- run()'s own
// deps.skillsStore/deps.approvalGate (per-call) win when provided, matching
// the same "registerRoutes deps override the module-level singleton"
// pattern every other capability in server.js already follows.
function createSkillProposalRunner(options = {}) {
  const {
    asyncLoadBackgroundMemory,
    shouldUseRemoteAi,
    runOpenAIReply,
    localLlamaReplyAvailable,
    runLocalLlamaReply,
    skillsStore: defaultSkillsStore,
    approvalGate: defaultApprovalGate,
  } = options;
  if (typeof asyncLoadBackgroundMemory !== "function") {
    throw new Error("asyncLoadBackgroundMemory is required");
  }

  async function run(deps = {}) {
    try {
      if (
        String(process.env.MANA_SKILL_PROPOSAL_MODE || "").toLowerCase() ===
        "off"
      ) {
        return { ok: false, reason: "disabled" };
      }

      const idleSkillsStore = deps.skillsStore || defaultSkillsStore;
      const idleApprovalGate = deps.approvalGate || defaultApprovalGate;
      if (!idleSkillsStore || !idleApprovalGate) {
        return { ok: false, reason: "missing_dependencies" };
      }

      const res = await asyncLoadBackgroundMemory();
      const processedFiles =
        res && res.processedFiles ? res.processedFiles : [];
      const minSummaries = Number(
        process.env.MANA_SKILL_PROPOSAL_MIN_SUMMARIES || 5,
      );
      if (!processedFiles || processedFiles.length < minSummaries) {
        return { ok: false, reason: "not_enough_summaries" };
      }

      const maxSummaries = Number(
        process.env.MANA_SKILL_PROPOSAL_MAX_SUMMARIES || 20,
      );
      const numbered = processedFiles
        .slice(0, maxSummaries)
        .map(
          (p, idx) =>
            `${idx + 1}. ${neuterDelimiters(String(p.summary || "").slice(0, 300))}`,
        )
        .join("\n\n");

      const existingSkills = idleSkillsStore.listSkills();
      const existingList = existingSkills.length
        ? existingSkills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
        : "(none yet)";

      const prompt = `You are reviewing recent session summaries for a genuinely reusable, repeated multi-step workflow -- something done the same way at least twice, that would save future tool/model calls if captured as a skill. Be conservative: most reviews find nothing. Never propose something already covered by an existing skill.\n\nEXISTING SKILLS:\n${existingList}\n\nBEGIN SUMMARIES:\n${numbered}\n\nEND SUMMARIES\n\nIf you find a genuinely reusable pattern not already covered, respond with strict JSON: {"found": true, "name": "kebab-case-skill-name", "description": "one sentence: when to use this", "body": "the general step-by-step procedure, written for future reuse, not tied to this one instance", "category": "optional short category"}. If nothing qualifies, respond with exactly: {"found": false}. Respond with valid JSON only, no commentary.`;

      let reply = null;
      try {
        if (shouldUseRemoteAi()) {
          reply = await runOpenAIReply(prompt, 400);
        }
      } catch (e) {
        console.warn("Skill proposal (remote) failed:", e && e.message ? e.message : e);
      }
      if (!reply) {
        try {
          if (localLlamaReplyAvailable()) {
            reply = await runLocalLlamaReply(
              prompt,
              300,
              process.env.MANA_BACKGROUND_REVIEW_PROFILE || "background",
            );
          }
        } catch (e) {
          console.warn("Skill proposal (local) failed:", e && e.message ? e.message : e);
          reply = null;
        }
      }

      if (!reply || typeof reply !== "string") {
        return { ok: false, reason: "no_reply" };
      }

      const parsed = extractJson(reply);
      if (!parsed || !parsed.found) {
        return { ok: true, found: false };
      }

      const name = String(parsed.name || "").trim();
      const description = String(parsed.description || "").trim();
      const body = String(parsed.body || "").trim();
      if (!name || !description || !body) {
        return { ok: false, reason: "incomplete_proposal" };
      }

      // Skip if an existing skill already matches this name/description --
      // same keyword-overlap matcher the retrieval path already uses, so a
      // proposal never duplicates a skill that would already surface on
      // its own.
      const alreadyCovered = findMatchingSkill(existingSkills, `${name} ${description}`);
      if (alreadyCovered) {
        return {
          ok: true,
          found: false,
          reason: "already_covered",
          matched: alreadyCovered.name,
        };
      }

      // Also skip if the same pattern is already sitting pending -- either
      // from an earlier idle pass, or because a human separately staged it
      // through the conversational/manual "skill-write" path. Neither is a
      // persisted skill yet (so the check above wouldn't catch it), but
      // re-proposing it every idle period until someone reviews the first
      // one just piles up duplicate pending requests.
      const pendingProposals =
        typeof idleApprovalGate.listPending === "function"
          ? idleApprovalGate
              .listPending()
              .filter((p) => p.actionType === IDLE_SKILL_WRITE_ACTION || p.actionType === "skill-write")
              .map((p) => ({ name: p.payload?.name, description: p.payload?.description }))
          : [];
      const alreadyPending = findMatchingSkill(pendingProposals, `${name} ${description}`);
      if (alreadyPending) {
        return {
          ok: true,
          found: false,
          reason: "already_pending",
          matched: alreadyPending.name,
        };
      }

      const outcome = await idleApprovalGate.requestApproval(IDLE_SKILL_WRITE_ACTION, {
        summary: `Auto-detected reusable pattern: create skill "${name}"`,
        payload: { name, description, body, category: parsed.category },
        scanText: body,
      });

      console.log(`Idle-triggered skill proposal staged: "${name}" (status: ${outcome.status})`);
      return { ok: true, found: true, name, outcome };
    } catch (e) {
      console.warn("Skill proposal pass failed:", e && e.message ? e.message : e);
      return { ok: false, reason: "exception", error: String(e) };
    }
  }

  return { run };
}

module.exports = { createSkillProposalRunner, IDLE_SKILL_WRITE_ACTION };
