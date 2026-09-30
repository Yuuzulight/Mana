// #1124: everything Mana is doing or has scheduled, in one list, for the
// launcher's Background tasks panel. Read-only except POST .../cancel,
// which only ever calls a source's own existing stop -- a source with no
// stop of its own has canCancel: false here.
//
// Each task: { id, kind, title, status, startedAt?, nextRunAt?, progress?,
// etaSeconds?, detail?, canCancel }. status is running, scheduled, waiting,
// paused, done or failed. progress is { done, total, unit } and only set
// where the source really counts it; a running task without it is
// indeterminate. etaSeconds is only set where the rate so far is a fair
// guide (elapsed / fraction done), never guessed.
//
// Sources come in as context.backgroundTaskSources (server.js); any of
// them may be missing, and one that throws is left out of the list rather
// than failing it.
const rateLimit = require("express-rate-limit");
const { cancelResearchJob } = require("./deep-research-capability");

// server.js's app-wide limiter already covers these; a route-local one is
// what CodeQL can see (same as memory-facts-capability.js). The panel polls
// every 3 s, well under it.
const backgroundTasksRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.MANA_RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
});

const KEY = "backgroundTasks";

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function msOf(value) {
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Seconds left at the rate so far, or undefined when there's nothing
// measured yet (or nothing left).
function etaSeconds(startedAtMs, done, total, nowMs) {
  const elapsed = nowMs - startedAtMs;
  if (!(done > 0 && total > done && elapsed > 0)) return undefined;
  return Math.round(((elapsed / done) * (total - done)) / 1000);
}

function progressOf(done, total, unit) {
  if (!(Number.isFinite(done) && Number.isFinite(total) && total > 0)) return undefined;
  return { done: Math.min(Math.max(done, 0), total), total, unit };
}

// A scheduled job's countdown, from its last run (or creation) to the next.
function countdown(fromMs, nextMs, nowMs) {
  if (!(Number.isFinite(fromMs) && nextMs > fromMs)) return undefined;
  return progressOf(nowMs - fromMs, nextMs - fromMs, "ms");
}

function nextDailyAt(time, nowMs, skipToday) {
  const [hour, minute] = String(time).split(":").map(Number);
  const next = new Date(nowMs);
  next.setHours(hour, minute, 0, 0);
  if (skipToday) next.setDate(next.getDate() + 1);
  return next.getTime();
}

const collectors = {
  cron({ cron }, t) {
    const scheduler = cron?.();
    if (!scheduler) return [];
    return scheduler.listJobs().map((job) => ({
      id: `${job.jobType === "reminder" ? "reminder" : "cron"}:${job.id}`,
      kind: job.jobType === "reminder" ? "reminder" : "cron",
      title: job.name,
      status: job.enabled === false ? "paused" : "scheduled",
      nextRunAt: iso(job.nextRunAt),
      progress: job.enabled === false ? undefined : countdown(job.lastRunAt ?? job.createdAt, job.nextRunAt, t),
      detail: job.lastError ? `Last run failed: ${job.lastError}` : undefined,
      canCancel: true,
    }));
  },

  heartbeat({ heartbeat, heartbeatEnabled, isGaming }) {
    const hb = heartbeat?.();
    if (!hb) return [];
    const paused = heartbeatEnabled?.() === false || isGaming?.();
    return hb.listChecks().map((check) => ({
      id: `heartbeat:${check.id}`,
      kind: "heartbeat",
      title: check.text,
      status: check.awaitingApproval ? "waiting" : paused ? "paused" : "scheduled",
      // 0: never run, so it's due at the next minute's check.
      nextRunAt: check.awaitingApproval || !check.nextRunAt ? undefined : iso(check.nextRunAt),
      detail: check.awaitingApproval
        ? "Waiting for your OK in the approval queue"
        : check.lastError
          ? `Last run failed: ${check.lastError}`
          : check.approved
            ? undefined
            : "Does a dry run first, then asks for your OK",
      canCancel: false,
    }));
  },

  proactive({ proactive }) {
    if (!proactive) return [];
    return proactive.listHeld().map((remark) => ({
      id: `proactive:${remark.reason}:${remark.expiresAt}`,
      kind: "proactive",
      title: remark.title || "Something to tell you",
      status: "waiting",
      detail: remark.text,
      canCancel: false,
    }));
  },

  briefing({ briefing }, t) {
    const st = briefing?.status();
    if (!st?.enabled) return [];
    if (st.running) return [{ id: "briefing", kind: "briefing", title: "Daily briefing", status: "running", canCancel: false }];
    const doneToday = st.lastDay === new Date(t).toDateString();
    const next = nextDailyAt(st.time, t, doneToday);
    return [
      {
        id: "briefing",
        kind: "briefing",
        title: "Daily briefing",
        // Past its time today: it goes out when I'm next seen at the PC.
        status: next <= t ? "waiting" : "scheduled",
        nextRunAt: next <= t ? undefined : iso(next),
        detail: next <= t ? "Waiting until you're back at the PC" : undefined,
        canCancel: false,
      },
    ];
  },

  dreamMode({ dreamMode, isGaming }, t) {
    const dm = dreamMode?.();
    if (!dm || !(dm.everyMs > 0) || !Number.isFinite(dm.scheduledAt)) return [];
    const base = { id: "dream-mode", kind: "memory", title: "Dream mode (memory upkeep)", canCancel: false };
    if (dm.runningSince) return [{ ...base, status: "running", startedAt: iso(dm.runningSince) }];
    // setInterval's next tick.
    const next = dm.scheduledAt + Math.max(1, Math.ceil((t - dm.scheduledAt) / dm.everyMs)) * dm.everyMs;
    return [
      {
        ...base,
        status: isGaming?.() ? "paused" : "scheduled",
        nextRunAt: iso(next),
        detail: isGaming?.() ? "Paused while a game is running" : undefined,
      },
    ];
  },

  embeddings({ embeddings }, t) {
    const st = embeddings?.status();
    if (!st?.running) return [];
    const done = st.processed - st.startProcessed;
    const total = st.total - st.startProcessed;
    return [
      {
        id: "retriever-embeddings",
        kind: "memory",
        title: "Indexing files for search",
        status: "running",
        startedAt: iso(st.startedAt),
        progress: progressOf(done, total, "files"),
        etaSeconds: etaSeconds(st.startedAt, done, total, t),
        detail: st.lastError ? `Last error: ${st.lastError}` : undefined,
        canCancel: false,
      },
    ];
  },

  memoryVault({ memoryVault }) {
    const st = memoryVault?.();
    if (!st?.vaultDir) return [];
    return [
      {
        id: "memory-vault",
        kind: "memory",
        title: "Obsidian vault sync",
        status: st.error ? "failed" : "waiting",
        detail: st.error ? st.error : `${st.notes} notes, synced when either side changes`,
        canCancel: false,
      },
    ];
  },

  research({ researchJobs }) {
    if (!researchJobs) return [];
    const status = { running: "running", done: "done", cancelled: "done", error: "failed" };
    return [...researchJobs.values()].map((job) => ({
      id: `research:${job.id}`,
      kind: "research",
      title: job.question ? `Research: ${job.question}` : "Research",
      status: status[job.status] || "running",
      startedAt: job.startedAt,
      // Sources read is the one step it counts; the rest is indeterminate.
      progress: job.status === "running" && job.progress?.step === "reading" ? progressOf(job.progress.index, job.progress.total, "sources") : undefined,
      detail: job.status === "cancelled" ? "Cancelled" : job.error || job.progress?.label,
      canCancel: job.status === "running" && !job.cancelRequested,
    }));
  },

  selfWork({ selfWork }) {
    const st = selfWork?.()?.status();
    if (!st || st.state === "idle") return [];
    const status = { running: "running", "pr-open": "done", "no-change": "done", stopped: "done", "needs-you": "waiting" };
    return [
      {
        id: "self-work",
        kind: "self-work",
        title: `#${st.issue}: ${st.title}`,
        status: status[st.state] || "failed",
        startedAt: st.startedAt,
        // Rounds out of goal mode's cap: she may finish before it, so no ETA.
        progress: st.state === "running" && st.round > 0 ? progressOf(st.round, st.maxRounds, "rounds") : undefined,
        detail: st.step || undefined,
        canCancel: st.state === "running",
      },
    ];
  },

  agent({ agentActivity }, t) {
    if (!agentActivity) return [];
    return agentActivity.list().map((run) => ({
      id: `agent:${run.id}`,
      kind: "agent",
      title: "Working on your message",
      status: "running",
      startedAt: iso(t - run.elapsedMs),
      detail: run.stopping ? "Stopping..." : run.tool ? `Using ${run.tool}` : `${run.toolCount} tool call(s) so far`,
      canCancel: !run.stopping,
    }));
  },

  models({ llama, llamaBuilds, fishWarmup }, t) {
    const items = [];
    const loading = llama?.getStatus().loading;
    if (loading) {
      items.push({
        id: "llama-load",
        kind: "model",
        title: `Loading ${String(loading.model).split(/[\\/]/).pop()}`,
        status: "running",
        startedAt: iso(loading.since),
        canCancel: false,
      });
    }
    const job = llamaBuilds?.getStatus().job;
    if (job) {
      const dl = job.download;
      const progress = dl && progressOf(dl.done, dl.total, "bytes");
      items.push({
        id: "llama-update",
        kind: "model",
        title: job.tag ? `Updating llama.cpp to ${job.tag}` : "Updating llama.cpp",
        status: job.state === "running" ? "running" : job.state === "failed" ? "failed" : "done",
        progress,
        etaSeconds: progress ? etaSeconds(dl.since, dl.done, dl.total, t) : undefined,
        detail: job.error || job.step || undefined,
        canCancel: false,
      });
    }
    const fish = fishWarmup?.();
    if (fish === "warming" || fish === "failed") {
      items.push({
        id: "fish-warmup",
        kind: "model",
        title: "Warming up Fish Speech",
        status: fish === "warming" ? "running" : "failed",
        canCancel: false,
      });
    }
    return items;
  },
};

function listBackgroundTasks(sources = {}) {
  const t = (sources.now || Date.now)();
  const tasks = [];
  for (const [name, collect] of Object.entries(collectors)) {
    try {
      tasks.push(...collect(sources, t));
    } catch (e) {
      console.warn(`background-tasks: ${name} failed:`, e?.message || e);
    }
  }
  // Drop undefined fields so the JSON only carries what's known.
  return tasks.map((task) => JSON.parse(JSON.stringify(task)));
}

// true, false (the task has ended or can't be stopped), or null (no such task).
function cancelBackgroundTask(sources = {}, id) {
  const [kind, ...rest] = String(id).split(":");
  const key = rest.join(":");
  switch (kind) {
    case "reminder":
    case "cron": {
      const scheduler = sources.cron?.();
      const job = scheduler?.listJobs().find((j) => j.id === key && (j.jobType === "reminder") === (kind === "reminder"));
      return job ? scheduler.removeJob(key) : null;
    }
    case "research": {
      const job = sources.researchJobs?.get(key);
      if (!job) return null;
      if (job.status !== "running" || job.cancelRequested) return false;
      cancelResearchJob(job);
      return true;
    }
    case "self-work": {
      const selfWork = sources.selfWork?.();
      if (!selfWork || selfWork.status().state === "idle") return null;
      return selfWork.stop();
    }
    case "agent":
      return sources.agentActivity ? sources.agentActivity.stop(key) || null : null;
    default:
      return listBackgroundTasks(sources).some((task) => task.id === id) ? false : null;
  }
}

function registerBackgroundTasksRoutes(app, context = {}) {
  const sources = context.backgroundTaskSources || {};
  const { checkAdminAuth } = context;
  if (typeof checkAdminAuth !== "function") throw new Error("background tasks need checkAdminAuth");

  app.get("/background-tasks", backgroundTasksRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return res.json({ tasks: listBackgroundTasks(sources) });
  });

  app.post("/background-tasks/:id/cancel", backgroundTasksRateLimiter, (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const cancelled = cancelBackgroundTask(sources, req.params.id);
    if (cancelled === null) return res.status(404).json({ error: "no such background task" });
    if (!cancelled) return res.status(409).json({ error: "that task can't be cancelled now" });
    return res.json({ ok: true });
  });
}

const backgroundTasksCapability = {
  key: KEY,
  registerRoutes: registerBackgroundTasksRoutes,
};

module.exports = {
  backgroundTasksCapability,
  cancelBackgroundTask,
  etaSeconds,
  listBackgroundTasks,
  registerBackgroundTasksRoutes,
};
