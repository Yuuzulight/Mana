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
      for (const field of ["company", "role", "status", "url", "notes", "appliedAt"]) {
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

  const applications = store.listApplications();
  if (applications.length) {
    lines.push("Tracked job applications:");
    for (const application of applications) {
      const suffix = application.notes ? ` -- ${application.notes}` : "";
      lines.push(
        `- ${application.company} (${application.role}): ${application.status}${suffix}`,
      );
    }
  }

  const answers = store.listAnswers();
  for (const answer of answers) {
    if (clean.includes(answer.key) || clean.includes(answer.label.toLowerCase())) {
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
    "Local job-application tracker and reusable answer knowledge base (resume bullets, project descriptions, canned Q&A) -- no LinkedIn access, everything stored locally.",
  registerRoutes: registerJobApplicationsRoutes,
  contributePromptContext,
  getHealth: (context = {}) => {
    const store = context.jobApplicationsStore;
    const applicationCount = store ? store.listApplications().length : 0;
    const answerCount = store ? store.listAnswers().length : 0;
    return {
      status: "available",
      configured: true,
      message: `Job application tracker available (${applicationCount} tracked, ${answerCount} saved answers).`,
      applicationCount,
      answerCount,
    };
  },
  createJobApplicationsStore,
  textLooksLikeJobApplicationQuestion,
};
