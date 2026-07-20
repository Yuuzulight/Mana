const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../../node-bot/request-validation");
const { createJobApplicationsStore } = require("./job-applications-store");

function textLooksLikeJobApplicationQuestion(text) {
  return /\b(job applications?|applied to|application status|interview(ing|s)?|resume|r[ée]sum[ée]|cv|cover letter|job search|job hunt(ing)?)\b/i.test(
    String(text || ""),
  );
}

// /jobs/match (issue #116): the user pastes in a job posting, Mana tailors a
// resume + cover letter from the saved answer knowledge base, and stages the
// result as a "ready_to_apply" application. Deliberately prep-only -- Mana
// never submits anything to a job site, the user reviews and applies by
// hand. See the AskUserQuestion decision recorded for this feature: no
// auto-submission, no scraping, paste-in postings only for now.
const JOB_MATCH_MAX_TOKENS = 1400;
const JOB_MATCH_SYSTEM_PROMPT =
  "You are a careful job-application assistant. You are given a job " +
  "posting and the candidate's saved background material (resume bullets, " +
  "past cover letters, canned answers). Using ONLY the provided background " +
  "-- never invent skills, employers, dates, or achievements the candidate " +
  "hasn't provided -- produce:\n" +
  "1. The hiring company's name\n" +
  "2. The role title\n" +
  "3. A short honest fit assessment (2-4 sentences): where the candidate " +
  "genuinely matches the posting and any real gaps\n" +
  "4. A resume tailored to this posting, built only from the candidate's " +
  "provided background, reordered and reworded to foreground what's " +
  "relevant to this specific role\n" +
  "5. A cover letter tailored to this posting, in the candidate's voice\n\n" +
  "Reply in EXACTLY this format, with each label starting its own line and " +
  "nothing before COMPANY or after the cover letter:\n" +
  "COMPANY: <name, or Unknown if not stated>\n" +
  "ROLE: <title, or Unknown if not stated>\n" +
  "FIT: <assessment>\n" +
  "RESUME:\n<tailored resume>\n" +
  "COVER LETTER:\n<tailored cover letter>";

function buildJobMatchPrompt(postingText, answers = []) {
  const background = answers.length
    ? answers.map((a) => `${a.label}:\n${a.content}`).join("\n\n")
    : "(no saved background material yet -- work only from the posting itself and say so in the fit assessment)";
  return [
    "Job posting:",
    String(postingText || "").trim(),
    "",
    "Candidate's saved background material:",
    background,
  ].join("\n");
}

const JOB_MATCH_SECTION_KEYS = {
  company: "company",
  role: "role",
  fit: "fit",
  resume: "resume",
  "cover letter": "coverLetter",
};

// Local models don't reliably emit valid JSON on request, so the prompt
// asks for plain delimited sections instead -- this walks the reply
// line-by-line and buckets text under whichever marker was last seen.
function parseJobMatchResponse(raw) {
  const markerRe = /^(COMPANY|ROLE|FIT|RESUME|COVER LETTER):\s*(.*)$/i;
  const sections = { company: "", role: "", fit: "", resume: "", coverLetter: "" };
  let current = null;

  for (const line of String(raw || "").split(/\r?\n/)) {
    const match = line.match(markerRe);
    if (match) {
      current = JOB_MATCH_SECTION_KEYS[match[1].toLowerCase()];
      sections[current] = match[2] ? `${match[2]}\n` : "";
      continue;
    }
    if (current) {
      sections[current] += `${line}\n`;
    }
  }

  for (const key of Object.keys(sections)) {
    sections[key] = sections[key].trim();
  }
  return sections;
}

function registerJobApplicationsRoutes(app, context = {}) {
  const store = context.jobApplicationsStore;

  app.get("/jobs/applications", (req, res) => {
    try {
      return res.json({ applications: store.listApplications() });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/jobs/applications", (req, res) => {
    try {
      const company = requireString(req.body?.company, "company");
      const role = requireString(req.body?.role, "role");
      const application = store.createApplication({
        company,
        role,
        status: req.body?.status,
        url: req.body?.url,
        notes: req.body?.notes,
        appliedAt: req.body?.appliedAt,
      });
      return res.status(201).json(application);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.patch("/jobs/applications/:id", (req, res) => {
    try {
      const id = requireString(req.params?.id, "id");
      const updates = {};
      for (const field of [
        "company",
        "role",
        "status",
        "url",
        "notes",
        "appliedAt",
        "postingText",
        "fitSummary",
        "tailoredResume",
        "tailoredCoverLetter",
      ]) {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
          updates[field] = req.body[field];
        }
      }
      const application = store.updateApplication(id, updates);
      if (!application) {
        return res.status(404).json({ error: "application not found" });
      }
      return res.json(application);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.delete("/jobs/applications/:id", (req, res) => {
    try {
      const id = requireString(req.params?.id, "id");
      const deleted = store.deleteApplication(id);
      if (!deleted) {
        return res.status(404).json({ error: "application not found" });
      }
      return res.json({ deleted: true, id });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/jobs/answers", (req, res) => {
    try {
      return res.json({ answers: store.listAnswers() });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/jobs/answers/:key", (req, res) => {
    try {
      const key = requireString(req.params?.key, "key");
      const answer = store.getAnswer(key);
      if (!answer) {
        return res.status(404).json({ error: "answer not found" });
      }
      return res.json(answer);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  // Upsert by key, matching how presets/answers are meant to be used --
  // re-saving a refined draft under the same key overwrites it in place.
  app.post("/jobs/answers", (req, res) => {
    try {
      const key = requireString(req.body?.key, "key");
      const content = requireString(req.body?.content, "content");
      const answer = store.saveAnswer({ key, content, label: req.body?.label });
      return res.status(201).json(answer);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.delete("/jobs/answers/:key", (req, res) => {
    try {
      const key = requireString(req.params?.key, "key");
      const deleted = store.deleteAnswer(key);
      if (!deleted) {
        return res.status(404).json({ error: "answer not found" });
      }
      return res.json({ deleted: true, key });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  // Paste in a job posting -> Mana tailors a resume + cover letter from the
  // saved answer knowledge base and stages it as a "ready_to_apply"
  // application. Prep-only: nothing is ever submitted anywhere by this
  // route, the user reviews the draft and applies by hand (issue #116).
  app.post("/jobs/match", async (req, res) => {
    try {
      const postingText = requireString(req.body?.postingText, "postingText");
      const synthesizeJobMatch = context.synthesizeJobMatch;
      if (typeof synthesizeJobMatch !== "function") {
        return res.status(503).json({
          error:
            "Job matching is not configured (no local model reply function available)",
        });
      }

      const prompt = buildJobMatchPrompt(postingText, store.listAnswers());
      const raw = await synthesizeJobMatch(prompt);
      const parsed = parseJobMatchResponse(raw);

      const application = store.createApplication({
        company: req.body?.company || parsed.company || "Unknown",
        role: req.body?.role || parsed.role || "Unknown",
        status: "ready_to_apply",
        url: req.body?.url,
        postingText,
        fitSummary: parsed.fit,
        tailoredResume: parsed.resume,
        tailoredCoverLetter: parsed.coverLetter,
      });
      return res.status(201).json(application);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: e.message || String(e) });
    }
  });
}

// Codex review on PR #115 (issue #114): unbounded application count/note
// length could push a llama-server prompt past its context window for a
// heavy user. Most recent N is what a "what have I applied to" question
// actually needs; older ones are summarized by count instead of dropped
// silently.
const PROMPT_CONTEXT_MAX_APPLICATIONS = 10;
const PROMPT_CONTEXT_NOTE_MAX_CHARS = 200;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Codex review on PR #115: a plain .includes() let a short key/label (e.g.
// "go") match inside an unrelated word ("going"), leaking answer content
// into replies it wasn't asked for. \b requires the match to sit on a word
// boundary, so "go" no longer matches inside "going" but a real mention (or
// a multi-word label like "AI experience") still does.
function textMentionsAnswer(text, value) {
  if (!value) return false;
  return new RegExp(`\\b${escapeRegExp(value)}\\b`, "i").test(text);
}

// Chat-reply prompt context (same shape as ffxiv-market/stock-market, see
// issue #108): self-guards on job-application-shaped text, then surfaces a
// compact summary of tracked applications plus any saved answer whose key
// or label the text actually mentions -- not every saved answer, so a
// generic "how's the job search going" doesn't dump the whole knowledge
// base into the reply.
async function contributePromptContext(text, context = {}) {
  if (!textLooksLikeJobApplicationQuestion(text)) {
    return "";
  }
  const store = context.jobApplicationsStore;
  if (!store) {
    return "";
  }

  const clean = String(text || "").toLowerCase();
  const lines = [];

  // listApplications() already sorts most-recent appliedAt first.
  const applications = store.listApplications();
  if (applications.length) {
    lines.push("Tracked job applications:");
    for (const application of applications.slice(0, PROMPT_CONTEXT_MAX_APPLICATIONS)) {
      const notes =
        application.notes.length > PROMPT_CONTEXT_NOTE_MAX_CHARS
          ? `${application.notes.slice(0, PROMPT_CONTEXT_NOTE_MAX_CHARS)}...`
          : application.notes;
      const suffix = notes ? ` -- ${notes}` : "";
      lines.push(
        `- ${application.company} (${application.role}): ${application.status}${suffix}`,
      );
    }
    const remaining = applications.length - PROMPT_CONTEXT_MAX_APPLICATIONS;
    if (remaining > 0) {
      lines.push(`...and ${remaining} more.`);
    }
  }

  const answers = store.listAnswers();
  for (const answer of answers) {
    if (textMentionsAnswer(clean, answer.key) || textMentionsAnswer(clean, answer.label.toLowerCase())) {
      lines.push(`\nSaved answer "${answer.label}":\n${answer.content}`);
    }
  }

  return lines.length ? lines.join("\n") : "";
}

module.exports = {
  key: "jobApplications",
  name: "Job Applications",
  category: "Job Search",
  description:
    "Local job-application tracker, reusable answer knowledge base, and posting-to-resume/cover-letter matcher (prep only, never auto-submits) -- no LinkedIn access, everything stored locally.",
  registerRoutes: registerJobApplicationsRoutes,
  contributePromptContext,
  getHealth: (context = {}) => {
    const store = context.jobApplicationsStore;
    const applicationCount = store ? store.listApplications().length : 0;
    const answerCount = store ? store.listAnswers().length : 0;
    const matchingConfigured = typeof context.synthesizeJobMatch === "function";
    return {
      status: "available",
      configured: true,
      message: `Job application tracker available (${applicationCount} tracked, ${answerCount} saved answers). Job matching (${matchingConfigured ? "" : "not "}configured).`,
      applicationCount,
      answerCount,
      matchingConfigured,
    };
  },
  createJobApplicationsStore,
  textLooksLikeJobApplicationQuestion,
  buildJobMatchPrompt,
  parseJobMatchResponse,
  JOB_MATCH_SYSTEM_PROMPT,
  JOB_MATCH_MAX_TOKENS,
};
