const { createCronScheduler } = require("./cron-scheduler");
const { createHeartbeat } = require("./heartbeat");
const { notifyTray } = require("../../node-bot/tray-notifier");
const proactive = require("../../node-bot/proactive");
const { isUsableFact, userNameFromFacts } = require("../../node-bot/whisper-prompt");
const { isPluginEnabled } = require("../../node-bot/capabilities/registry");

// Module-level singleton (mirrors other plugins, e.g. document-reader) so
// GET/POST/DELETE routes and the health check all see the same job list
// and running timer regardless of which request hits them.
let scheduler = null;
let heartbeat = null;

const LATE_REMINDER_MS = 5 * 60 * 1000;
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REPLAYED = 3;
// The missed reminders of one catch-up (one runDueJobs pass), while it runs.
let replay = null;
// Reminders that came up in quiet time: shown silently then, said after it.
let saidLater = [];

// #1284: quiet-hours window from proactive settings.
function inQuietTime(ms = Date.now()) {
  const qh = proactive.getSettings ? proactive.getSettings().quietHours : null;
  if (!qh?.enabled) return false;
  return typeof proactive.inQuietHours === "function" ? proactive.inQuietHours(qh, ms) : false;
}

// In quiet time a reminder is a silent toast, and she says it once quiet
// time is over (sayHeldReminders), once however often a repeating one fired.
// ponytail: held in memory, so a backend restart in quiet time loses the
// spoken line (the toast was already shown).
function offerReminder(payload, nowMs) {
  if (inQuietTime(nowMs) && payload.speak) {
    const { speak, ...silent } = payload;
    if (!saidLater.some((p) => p.text === silent.text)) saidLater.push({ ...silent, speak, kind: "reminder-late" });
    payload = silent;
  }
  proactive.offer({ reason: "reminder", explicit: true, payload });
}

// #699: an urgent heartbeat report is toasted right away, even while
// remarks are held (gaming, budget, quiet hours), but never said aloud in
// quiet time. Everything else is a proactive candidate.
function notifyHeartbeat(payload, nowMs = Date.now()) {
  if (!payload.urgent) return proactive.offer({ reason: "heartbeat", payload });
  const { speak, ...silent } = payload;
  return notifyTray(inQuietTime(nowMs) ? silent : payload).catch(() => {});
}

function sayHeldReminders(nowMs) {
  if (!saidLater.length || inQuietTime(nowMs)) return;
  const held = saidLater;
  saidLater = [];
  for (const payload of held) proactive.offer({ reason: "reminder", explicit: true, payload });
}

// True for the first MAX_REPLAYED missed reminders of a catch-up; the rest
// are gathered into one "and N more" once the pass is over (its reminders
// all run before the next macrotask).
function replayOne(text, nowMs) {
  if (!replay) {
    const batch = (replay = { count: 0, rest: [] });
    setImmediate(() => {
      const { rest } = batch;
      if (replay === batch) replay = null;
      if (!rest.length) return;
      const list = rest.join("; ");
      offerReminder(
        {
          type: "cron",
          title: "Reminders",
          text: `And ${rest.length} more: ${list.length > 200 ? `${list.slice(0, 200)}...` : list}`,
          speak: `And ${rest.length} more reminder${rest.length === 1 ? "" : "s"} I missed; they're in the notification.`,
          kind: "reminder-late",
          at: new Date(nowMs).toISOString(),
        },
        nowMs,
      );
    });
  }
  replay.count += 1;
  if (replay.count <= MAX_REPLAYED) return true;
  replay.rest.push(text);
  return false;
}

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
        // #1265: a script action with nothing to say (null) stays quiet;
        // it sends its own notices.
        if (!error && job.jobType === "script" && result == null) return;
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
        // engine as explicit, so it gets through even mid-game, and the
        // launcher says it out loud too ("Yuuzu, raid in 10 minutes!").
        if (job.jobType === "reminder") {
          const nowMs = (deps.now || Date.now)();
          const lateMs = nowMs - job.nextRunAt;
          payload.speak = `${reminderName(deps.acpMemoryStore)}${assistantText.replace(/[\s.!?]+$/, "")}!`;
          // #1024: picks how the launcher says it. Late: it fired well after
          // its time (the PC was asleep or Mana was off).
          payload.kind = error ? "failed" : lateMs > LATE_REMINDER_MS ? "reminder-late" : "reminder";
          // Held before it's said (no launcher listening): late once this grace is up.
          if (payload.kind === "reminder") payload.lateIn = LATE_REMINDER_MS - lateMs;
          // Tier 3 #2: after downtime only the last day's missed reminders
          // come back, MAX_REPLAYED of them one by one and the rest as one
          // "and N more". Older ones stay in the chat log below.
          if (payload.kind !== "reminder-late" || (lateMs <= REPLAY_WINDOW_MS && replayOne(assistantText, nowMs))) {
            offerReminder(payload, nowMs);
          }
        }
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
    // #699: heartbeat.md's checks, next to jobs.json. Their reports are
    // proactive candidates like any other remark, so the daily budget,
    // gaming mode and quiet hours apply; an urgent one is toasted at once.
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
      notify: (payload) => notifyHeartbeat(payload),
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
        sayHeldReminders(Date.now());
      }, 60 * 1000).unref();
    }
  }
  return scheduler;
}

// "Yuuzu, " from memory, the name whisper's prompt uses; "" if none.
function reminderName(acpMemoryStore) {
  try {
    const name = userNameFromFacts((acpMemoryStore?.listFacts?.() || []).filter(isUsableFact));
    return name ? `${name}, ` : "";
  } catch {
    return "";
  }
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

  // #699: Settings > Heartbeat edits heartbeat.md's checks as a list.
  app.get("/heartbeat/items", (req, res) => res.json({ items: heartbeat.getItems() }));

  app.put("/heartbeat/items", (req, res) => {
    try {
      return res.json({ items: heartbeat.setItems(req.body?.items) });
    } catch (e) {
      // A file system error (it has a code) isn't the request's fault.
      return res.status(e.code ? 500 : 400).json({ error: e.message });
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
  // #1426: on by default -- Settings > Check-ins > Heartbeat lives in it.
  defaultEnabled: true,
  description:
    "Run a script action or a full agent prompt on a fixed schedule (interval or daily-at-time), independent of chat or idle activity. Results are delivered as a chat turn in the job's session.",
  registerRoutes: registerCronSchedulerRoutes,
  _notifyHeartbeatForTests: notifyHeartbeat,
  // #905: server.js's reminder tools share the routes' job list.
  getScheduler,
  // #1124: null until the scheduler is built (at route registration).
  getHeartbeat: () => heartbeat,
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
    replay = null;
    saidLater = [];
  },
  _sayHeldRemindersForTests: sayHeldReminders,
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
