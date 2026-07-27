const { createCronScheduler } = require("./cron-scheduler");

// Module-level singleton (mirrors other plugins, e.g. document-reader) so
// GET/POST/DELETE routes and the health check all see the same job list
// and running timer regardless of which request hits them.
let scheduler = null;

function getScheduler(deps = {}) {
  if (!scheduler) {
    scheduler = createCronScheduler({
      dataDir: deps.dataDir,
      now: deps.now,
      makeId: deps.makeId,
      scriptActions: deps.scriptActions,
      runAgentJob:
        deps.runAgentJob ||
        (async (job) => {
          if (typeof deps.buildAssistantReply !== "function") {
            throw new Error("no buildAssistantReply function available for agent jobs");
          }
          return deps.buildAssistantReply(job.prompt, "", "", "default", job.sessionId);
        }),
      onResult: (job, result, error) => {
        if (typeof deps.acpMemoryStore?.appendTurn !== "function") return;
        const assistantText = error
          ? `[cron job "${job.name}" failed: ${error}]`
          : typeof result === "string"
            ? result
            : JSON.stringify(result);
        deps.acpMemoryStore
          .appendTurn({
            sessionId: job.sessionId,
            user: `[scheduled: ${job.name}]`,
            assistant: assistantText,
          })
          .catch(() => {});
      },
    });
    if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
      scheduler.start(Number(process.env.MANA_CRON_CHECK_INTERVAL_MS) || 30000);
    }
  }
  return scheduler;
}

function registerCronSchedulerRoutes(app, deps = {}) {
  const cron = getScheduler(deps);

  app.get("/cron/jobs", (req, res) => {
    return res.json({ jobs: cron.listJobs() });
  });

  app.post("/cron/jobs", (req, res) => {
    try {
      const job = cron.addJob(req.body || {});
      return res.status(201).json(job);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.delete("/cron/jobs/:id", (req, res) => {
    const removed = cron.removeJob(req.params.id);
    if (!removed) {
      return res.status(404).json({ error: "job not found" });
    }
    return res.json({ ok: true });
  });
}

module.exports = {
  key: "cronScheduler",
  name: "Cron Scheduler",
  category: "Automation",
  defaultEnabled: false,
  description:
    "Run a script action or a full agent prompt on a fixed schedule (interval or daily-at-time), independent of chat or idle activity. Results are delivered as a chat turn in the job's session.",
  registerRoutes: registerCronSchedulerRoutes,
  getHealth: (deps = {}) => {
    const cron = getScheduler(deps);
    const jobs = cron.listJobs();
    return {
      status: "available",
      configured: true,
      message: `${jobs.length} scheduled job(s), ${jobs.filter((j) => j.enabled).length} enabled`,
    };
  },
  // Test-only escape hatch to reset the module-level singleton between
  // test files/runs -- production code never calls this.
  _resetForTests: () => {
    if (scheduler) scheduler.stop();
    scheduler = null;
  },
};
