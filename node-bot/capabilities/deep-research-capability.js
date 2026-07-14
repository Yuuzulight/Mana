const { randomUUID } = require("node:crypto");
const {
  ValidationError,
  optionalInteger,
  requireString,
  sendValidationError,
} = require("../request-validation");
const {
  MAX_SOURCES_CAP,
  MAX_TOTAL_MS_CAP,
  runDeepResearch: defaultRunDeepResearch,
} = require("../tools/deep-research");

const KEY = "deepResearch";

// In-memory job store: research runs are bounded (a few minutes at most,
// see tools/deep-research.js's clamps) and local-first, so there's no need
// to persist jobs across a backend restart -- the UI just polls for
// progress while a job is in flight.
function createResearchJobStore() {
  return new Map();
}

function registerDeepResearchRoutes(app, context = {}) {
  const searchWeb = context.searchWeb;
  const fetchPage = context.fetchPage;
  const synthesize = context.synthesize;
  const jobs = context.jobs || createResearchJobStore();
  const runDeepResearch = context.runDeepResearch || defaultRunDeepResearch;
  const makeJobId = context.makeJobId || (() => randomUUID());
  const now = context.now || (() => new Date().toISOString());

  app.post("/research/start", (req, res) => {
    try {
      const question = requireString(req.body?.question, "question");
      const maxSources = optionalInteger(req.body?.maxSources, "maxSources", {
        min: 1,
        max: MAX_SOURCES_CAP,
      });
      const maxTotalMs = optionalInteger(req.body?.maxTotalMs, "maxTotalMs", {
        min: 5000,
        max: MAX_TOTAL_MS_CAP,
      });

      if (typeof synthesize !== "function") {
        return res
          .status(503)
          .json({ error: "Deep research is not configured (no local model reply function available)" });
      }

      const jobId = makeJobId();
      const job = {
        id: jobId,
        status: "running",
        progress: { step: "starting", label: "Starting research..." },
        result: null,
        error: null,
        startedAt: now(),
      };
      jobs.set(jobId, job);

      runDeepResearch(question, {
        maxSources,
        maxTotalMs,
        searchWeb,
        fetchPage,
        synthesize,
        onProgress: (progress) => {
          job.progress = progress;
        },
      })
        .then((result) => {
          job.status = "done";
          job.result = result;
        })
        .catch((error) => {
          job.status = "error";
          job.error = error.message || String(error);
        });

      return res.status(202).json({ jobId, status: job.status, progress: job.progress });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/research/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "research job not found" });
    }
    return res.json({
      id: job.id,
      status: job.status,
      progress: job.progress,
      result: job.result,
      error: job.error,
      startedAt: job.startedAt,
    });
  });
}

const deepResearchCapability = {
  key: KEY,
  registerRoutes: registerDeepResearchRoutes,
  getHealth: (context = {}) => {
    const configured = typeof context.synthesize === "function";
    return {
      status: configured ? "configured" : "unavailable",
      configured,
      message: configured
        ? "Deep research is available (POST /research/start, GET /research/:jobId)."
        : "Deep research is unavailable: no local model reply function configured.",
    };
  },
};

module.exports = {
  createResearchJobStore,
  deepResearchCapability,
  registerDeepResearchRoutes,
};
