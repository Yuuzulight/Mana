// Time-based automation, independent of chat activity or idle detection --
// "run this every morning at 9am" rather than only reacting to a message or
// idle period. Two job types: script (calls a named function from an
// injected registry, no model call) and agent (asks Mana's normal reply
// pipeline a prompt, same as if the user had typed it). Deliberately just
// fixed interval/daily-at-time scheduling, not a full cron-expression
// parser -- covers every example in the issue (a daily summary, a periodic
// check) without a new dependency; expand to real cron syntax only if a
// concrete need for it (a comma-list, a step value, etc.) shows up.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJobs(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeJobs(filePath, jobs) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function isValidSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") return false;
  if (schedule.type === "interval") {
    return Number.isFinite(schedule.everyMs) && schedule.everyMs > 0;
  }
  if (schedule.type === "daily") {
    return (
      Number.isInteger(schedule.hour) &&
      schedule.hour >= 0 &&
      schedule.hour <= 23 &&
      Number.isInteger(schedule.minute) &&
      schedule.minute >= 0 &&
      schedule.minute <= 59
    );
  }
  return false;
}

// Given a schedule and "now", returns the timestamp (ms) of the next fire.
function computeNextRun(schedule, nowMs) {
  if (schedule.type === "interval") {
    return nowMs + schedule.everyMs;
  }
  if (schedule.type === "daily") {
    const next = new Date(nowMs);
    next.setHours(schedule.hour, schedule.minute, 0, 0);
    if (next.getTime() <= nowMs) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }
  throw new Error(`unknown schedule type: ${schedule && schedule.type}`);
}

function createCronScheduler(options = {}) {
  const dataDir =
    options.dataDir || path.join(__dirname, "..", "..", "node-bot", "data", "cron-scheduler");
  const jobsPath = path.join(dataDir, "jobs.json");
  const now = options.now || (() => Date.now());
  const makeId = options.makeId || (() => crypto.randomUUID());
  // Injected executors -- kept out of this module so it has no direct
  // coupling to server.js's reply pipeline or any specific plugin's
  // actions; the caller (plugins/cron-scheduler/index.js) wires the real
  // ones in.
  const scriptActions = options.scriptActions || {};
  const runAgentJob = typeof options.runAgentJob === "function" ? options.runAgentJob : null;
  const onResult = typeof options.onResult === "function" ? options.onResult : () => {};

  ensureDir(dataDir);

  function listJobs() {
    return readJobs(jobsPath);
  }

  function saveJobs(jobs) {
    writeJobs(jobsPath, jobs);
    return jobs;
  }

  function addJob(input = {}) {
    if (!isValidSchedule(input.schedule)) {
      throw new Error("a valid schedule ({type: 'interval', everyMs} or {type: 'daily', hour, minute}) is required");
    }
    if (input.jobType !== "script" && input.jobType !== "agent") {
      throw new Error("jobType must be 'script' or 'agent'");
    }
    if (input.jobType === "script" && !String(input.actionName || "").trim()) {
      throw new Error("actionName is required for a script job");
    }
    if (input.jobType === "agent" && !String(input.prompt || "").trim()) {
      throw new Error("prompt is required for an agent job");
    }

    const nowValue = now();
    const job = {
      id: makeId(),
      name: String(input.name || "Untitled job").slice(0, 120),
      jobType: input.jobType,
      schedule: input.schedule,
      actionName: input.actionName || null,
      prompt: input.prompt || null,
      sessionId: input.sessionId || "cron-scheduler",
      enabled: input.enabled !== false,
      createdAt: nowValue,
      lastRunAt: null,
      lastError: null,
      nextRunAt: computeNextRun(input.schedule, nowValue),
    };

    const jobs = listJobs();
    jobs.push(job);
    saveJobs(jobs);
    return job;
  }

  function removeJob(id) {
    const jobs = listJobs();
    const next = jobs.filter((j) => j.id !== id);
    if (next.length === jobs.length) return false;
    saveJobs(next);
    return true;
  }

  async function runJob(job) {
    if (job.jobType === "script") {
      const action = scriptActions[job.actionName];
      if (typeof action !== "function") {
        throw new Error(`no script action registered for "${job.actionName}"`);
      }
      return action();
    }
    if (!runAgentJob) {
      throw new Error("no agent-job executor configured");
    }
    return runAgentJob(job);
  }

  // Runs every enabled job whose nextRunAt has passed, delivering each
  // result (or error) via onResult, and reschedules it for its next fire.
  // A failing job doesn't stop the rest of the batch.
  async function runDueJobs() {
    const nowValue = now();
    const jobs = listJobs();
    let changed = false;

    for (const job of jobs) {
      if (!job.enabled || job.nextRunAt > nowValue) continue;
      changed = true;
      try {
        const result = await runJob(job);
        job.lastError = null;
        onResult(job, result, null);
      } catch (e) {
        job.lastError = (e && e.message) || String(e);
        onResult(job, null, job.lastError);
      }
      job.lastRunAt = nowValue;
      job.nextRunAt = computeNextRun(job.schedule, nowValue);
    }

    if (changed) saveJobs(jobs);
    return jobs;
  }

  let timer = null;
  function start(intervalMs = 30000) {
    if (timer) return;
    timer = setInterval(() => {
      runDueJobs().catch((e) =>
        console.warn("cron-scheduler: runDueJobs failed:", e && e.message ? e.message : e),
      );
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    dataDir,
    listJobs,
    addJob,
    removeJob,
    runDueJobs,
    start,
    stop,
  };
}

module.exports = {
  createCronScheduler,
  computeNextRun,
  isValidSchedule,
};
