const { randomUUID } = require("node:crypto");
const {
  ValidationError,
  optionalInteger,
  requireString,
  sendValidationError,
} = require("../request-validation");
const {
  MAX_SOURCES_CAP,
  MAX_SUB_QUERIES_CAP,
  MAX_TOTAL_MS_CAP,
  runDeepResearch: defaultRunDeepResearch,
} = require("../tools/deep-research");

const KEY = "deepResearch";
const DEFAULT_JOB_TTL_MS = 10 * 60 * 1000;

// In-memory job store: research runs are bounded (a few minutes at most,
// see tools/deep-research.js's clamps) and local-first, so there's no need
// to persist jobs across a backend restart -- the UI just polls for
// progress while a job is in flight. Finished jobs are pruned after a TTL
// so the map doesn't grow for the lifetime of the process.
function createResearchJobStore() {
  return new Map();
}

function envInteger(env, name) {
  const raw = env[name];
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function registerDeepResearchRoutes(app, context = {}) {
  const env = context.env || process.env;
  const searchWeb = context.searchWeb;
  const fetchPage = context.fetchPage;
  const synthesize = context.synthesize;
  const decompose = context.decompose;
  const jobs = context.jobs || createResearchJobStore();
  const runDeepResearch = context.runDeepResearch || defaultRunDeepResearch;
  const makeJobId = context.makeJobId || (() => randomUUID());
  const now = context.now || (() => new Date().toISOString());
  const jobTtlMs =
    Number(context.jobTtlMs) ||
    envInteger(env, "MANA_RESEARCH_JOB_TTL_MS") ||
    DEFAULT_JOB_TTL_MS;
  // Persistent per-machine defaults; per-request body values still win, and
  // tools/deep-research.js clamps everything to its hard caps regardless.
  const envMaxSources = envInteger(env, "MANA_RESEARCH_MAX_SOURCES");
  const envMaxTotalMs = envInteger(env, "MANA_RESEARCH_MAX_TOTAL_MS");
  const envMaxSubQueries = envInteger(env, "MANA_RESEARCH_MAX_SUB_QUERIES");

  function scheduleJobCleanup(jobId) {
    const timer = setTimeout(() => {
      jobs.delete(jobId);
    }, jobTtlMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  app.post("/research/start", (req, res) => {
    try {
      const question = requireString(req.body?.question, "question");
      const maxSources = optionalInteger(req.body?.maxSources, "maxSources", {
        min: 1,
        max: MAX_SOURCES_CAP,
        defaultValue: envMaxSources,
      });
      const maxTotalMs = optionalInteger(req.body?.maxTotalMs, "maxTotalMs", {
        min: 5000,
        max: MAX_TOTAL_MS_CAP,
        defaultValue: envMaxTotalMs,
      });
      const maxSubQueries = optionalInteger(
        req.body?.maxSubQueries,
        "maxSubQueries",
        {
          min: 1,
          max: MAX_SUB_QUERIES_CAP,
          defaultValue: envMaxSubQueries,
        },
      );

      if (typeof synthesize !== "function") {
        return res
          .status(503)
          .json({ error: "Deep research is not configured (no local model reply function available)" });
      }

      const jobId = makeJobId();
      const job = {
        id: jobId,
        status: "running",
        cancelRequested: false,
        progress: { step: "starting", label: "Starting research..." },
        result: null,
        error: null,
        startedAt: now(),
      };
      jobs.set(jobId, job);

      runDeepResearch(question, {
        maxSources,
        maxTotalMs,
        maxSubQueries,
        searchWeb,
        fetchPage,
        synthesize,
        decompose,
        isCancelled: () => job.cancelRequested,
        onProgress: (progress) => {
          job.progress = progress;
        },
      })
        .then((result) => {
          // A cancel that lands during the final (unabortable) synthesis
          // call still wins: the user asked to stop, so the result is
          // discarded for predictability.
          if (job.cancelRequested) {
            job.status = "cancelled";
          } else {
            job.status = "done";
            job.result = result;
          }
          scheduleJobCleanup(jobId);
        })
        .catch((error) => {
          if (error && error.name === "ResearchCancelledError") {
            job.status = "cancelled";
          } else {
            job.status = "error";
            job.error = error.message || String(error);
          }
          scheduleJobCleanup(jobId);
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
      cancelRequested: job.cancelRequested,
      progress: job.progress,
      result: job.result,
      error: job.error,
      startedAt: job.startedAt,
    });
  });

  // Cancellation is checked between research steps (see
  // tools/deep-research.js) -- an in-flight page fetch or the synthesis LLM
  // call finishes first, then the job stops. Idempotent: cancelling a
  // finished job just reports its current state.
  app.post("/research/:jobId/cancel", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "research job not found" });
    }
    if (job.status === "running" && !job.cancelRequested) {
      job.cancelRequested = true;
      job.progress = { step: "cancelling", label: "Cancelling..." };
    }
    return res.json({
      id: job.id,
      status: job.status,
      cancelRequested: job.cancelRequested,
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
        ? "Deep research is available (POST /research/start, GET /research/:jobId, POST /research/:jobId/cancel)."
        : "Deep research is unavailable: no local model reply function configured.",
    };
  },
};

module.exports = {
  DEFAULT_JOB_TTL_MS,
  createResearchJobStore,
  deepResearchCapability,
  registerDeepResearchRoutes,
};
