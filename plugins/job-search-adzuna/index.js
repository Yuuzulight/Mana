const {
  ValidationError,
  optionalInteger,
  optionalString,
  requireString,
  sendValidationError,
} = require("../../node-bot/request-validation");
const { createAdzunaClient } = require("./adzuna-client");

// Search-only: live postings from Adzuna, no auto-apply and no scraping
// (issue #117, follow-up to #116). Paste a returned listing's description
// into POST /jobs/match (job-applications plugin) by hand to get a tailored
// resume/cover letter -- these two plugins don't call each other directly,
// they just work well together.
function registerJobSearchAdzunaRoutes(app, context = {}) {
  const client = context.adzunaClient;

  app.get("/jobs/search", async (req, res) => {
    try {
      const what = requireString(req.query?.what, "what");
      if (!client || !client.isConfigured) {
        return res.status(503).json({
          error:
            "Adzuna job search is not configured (set ADZUNA_APP_ID and ADZUNA_APP_KEY)",
        });
      }
      const where = optionalString(req.query?.where, "where", "");
      const page = optionalInteger(req.query?.page, "page", { min: 1, max: 100 });
      const resultsPerPage = optionalInteger(
        req.query?.resultsPerPage,
        "resultsPerPage",
        { min: 1, max: 20 },
      );

      const result = await client.searchJobs({ what, where, page, resultsPerPage });
      return res.json({ source: "Adzuna", ...result });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: e.message || String(e) });
    }
  });
}

module.exports = {
  key: "jobSearchAdzuna",
  name: "Job Search (Adzuna)",
  category: "Job Search",
  description:
    "Live job postings from Adzuna's job search API (GET /jobs/search) -- no auto-apply, no scraping. Paste a listing into the job-applications plugin's POST /jobs/match for a tailored resume/cover letter.",
  registerRoutes: registerJobSearchAdzunaRoutes,
  getHealth: (context = {}) => {
    const client = context.adzunaClient;
    const configured = Boolean(client && client.isConfigured);
    return {
      status: configured ? "configured" : "unconfigured",
      configured,
      message: configured
        ? `Adzuna job search is configured (country: ${client.country}).`
        : "Set ADZUNA_APP_ID and ADZUNA_APP_KEY to enable live job search (see plugins/job-search-adzuna/README.md).",
    };
  },
  createAdzunaClient,
};
