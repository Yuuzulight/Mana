const { createCronScheduler } = require("./cron-scheduler");
const { createHeartbeat } = require("./heartbeat");
const { notifyTray } = require("../../node-bot/tray-notifier");
const proactive = require("../../node-bot/proactive");
const { isPluginEnabled } = require("../../node-bot/capabilities/registry");

// Module-level singleton (mirrors other plugins, e.g. document-reader) so
// GET/POST/DELETE routes and the health check all see the same job list
// and running timer regardless of which request hits them.
let scheduler = null;
let heartbeat = null;

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
          // Issue #643: the normal reply pipeline, so the job's prompt gets
          // the same memory a chat turn does (background memory, this
          // session's memory, pinned/related facts) before it runs --
          // confirmed facts only (Q27: scheduled: true).
          return deps.buildAssistantReply(job.prompt, "", "", "default", job.sessionId, null, null, { scheduled: true });
        }),
      onResult: (job, result, error) => {
        const assistantText = error
          ? `[cron job "${job.name}" failed: ${error}]`
          : typeof result === "string"
            ? result
            : JSON.stringify(result);
        const payload = {
          type: "cron",
          title: job.jobType === "reminder" ? "Reminder" : `Cron: ${job.name}`,
          text: assistantText.length > 200 ? `${assistantText.slice(0, 200)}...` : assistantText,
          at: new Date().toISOString(),
        };
        // #905: a reminder the user asked for goes through the proactive
        // engine as explicit, so it gets through even mid-game.
        if (job.jobType === "reminder") proactive.offer({ reason: "reminder", explicit: true, payload });
        // Issue #423: a scheduled job's result should reach the user even
        // if they never reopen that job's chat session -- fire-and-forget,
        // same as the memory-turn write below.
        else notifyTray(payload).catch(() => {});
        if (typeof deps.acpMemoryStore?.appendTurn !== "function") return;
        deps.acpMemoryStore
          .appendTurn({
            sessionId: job.sessionId,
            user: `[scheduled: ${job.name}]`,
            assistant: assistantText,
          })
          .catch(() => {});
      },
    });
    // #699: heartbeat.md's checks, next to jobs.json. Their reports go out
    // as "cron" tray notifications (the launcher's proactive toast types).
    heartbeat = createHeartbeat({
      dataDir: scheduler.dataDir,
      runCheck: (prompt, wrapToolPolicy, sessionId) => {
        if (typeof deps.buildAssistantReply !== "function") {
          throw new Error("no buildAssistantReply function available for heartbeat checks");
        }
        // Q27: scheduled, so it sees confirmed facts only (#780's flag).
        return deps.buildAssistantReply(prompt, "", "", "default", sessionId, null, null, {
          wrapToolPolicy,
          scheduled: true,
        });
      },
      notify: (payload) => notifyTray(payload).catch(() => {}),
      isGaming: deps.isGaming,
      isEnabled: () => isPluginEnabled(module.exports, deps.pluginSettingsStore),
      approvalGate: deps.approvalGate,
      snapshotStore: deps.snapshotStore,
    });
    deps.approvalGate?.registerExecutor("heartbeat-check", ({ id }) => heartbeat.approve(id));
    if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
      scheduler.start(Number(process.env.MANA_CRON_CHECK_INTERVAL_MS) || 30000);
      setInterval(() => {
        heartbeat.runDue().catch((e) => console.warn("heartbeat: runDue failed:", e?.message || e));
      }, 60 * 1000).unref();
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
  // #905: server.js's reminder tools share the routes' job list.
  getScheduler,
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
    heartbeat = null;
  },
  // Test-only escape hatch: registerRoutes doesn't expose runDueJobs (the
  // route surface is deliberately just CRUD), but the onResult -> notifyTray
  // wiring above only runs through that method, so tests need direct access
  // to the singleton to exercise it.
  _getSchedulerForTests: (deps = {}) => getScheduler(deps),
  // Same, for the heartbeat built alongside the scheduler.
  _getHeartbeatForTests: (deps = {}) => {
    getScheduler(deps);
    return heartbeat;
  },
};
