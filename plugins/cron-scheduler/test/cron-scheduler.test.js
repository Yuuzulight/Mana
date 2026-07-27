const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCronScheduler, computeNextRun, isValidSchedule } = require("../cron-scheduler");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-cron-"));
}

test("isValidSchedule accepts a positive interval and a valid hour/minute daily schedule", () => {
  assert.equal(isValidSchedule({ type: "interval", everyMs: 60000 }), true);
  assert.equal(isValidSchedule({ type: "daily", hour: 9, minute: 0 }), true);
});

test("isValidSchedule rejects a non-positive interval, an out-of-range hour, and an unknown type", () => {
  assert.equal(isValidSchedule({ type: "interval", everyMs: 0 }), false);
  assert.equal(isValidSchedule({ type: "daily", hour: 24, minute: 0 }), false);
  assert.equal(isValidSchedule({ type: "weekly" }), false);
  assert.equal(isValidSchedule(null), false);
});

test("computeNextRun for an interval schedule adds everyMs to now", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(computeNextRun({ type: "interval", everyMs: 3600000 }, now), now + 3600000);
});

test("computeNextRun for a daily schedule fires later today if the time hasn't passed yet", () => {
  const now = new Date(2026, 0, 1, 8, 0, 0).getTime();
  const next = computeNextRun({ type: "daily", hour: 9, minute: 30 }, now);
  const nextDate = new Date(next);
  assert.equal(nextDate.getDate(), 1);
  assert.equal(nextDate.getHours(), 9);
  assert.equal(nextDate.getMinutes(), 30);
});

test("computeNextRun for a daily schedule rolls to tomorrow if today's time already passed", () => {
  const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
  const next = computeNextRun({ type: "daily", hour: 9, minute: 30 }, now);
  const nextDate = new Date(next);
  assert.equal(nextDate.getDate(), 2);
  assert.equal(nextDate.getHours(), 9);
});

test("addJob rejects an invalid schedule, an unknown jobType, and missing actionName/prompt", () => {
  const scheduler = createCronScheduler({ dataDir: createTempDir() });
  assert.throws(() => scheduler.addJob({ jobType: "script", schedule: null }), /valid schedule/);
  assert.throws(
    () => scheduler.addJob({ jobType: "carrier-pigeon", schedule: { type: "interval", everyMs: 1000 } }),
    /jobType must be/,
  );
  assert.throws(
    () => scheduler.addJob({ jobType: "script", schedule: { type: "interval", everyMs: 1000 } }),
    /actionName is required/,
  );
  assert.throws(
    () => scheduler.addJob({ jobType: "agent", schedule: { type: "interval", everyMs: 1000 } }),
    /prompt is required/,
  );
});

test("addJob persists a valid job and listJobs reads it back across instances", () => {
  const dataDir = createTempDir();
  const first = createCronScheduler({ dataDir, now: () => 1000 });
  const job = first.addJob({
    name: "Morning market check",
    jobType: "script",
    actionName: "ffxivMarketSummary",
    schedule: { type: "interval", everyMs: 60000 },
  });
  assert.equal(job.nextRunAt, 61000);
  assert.equal(job.enabled, true);

  const second = createCronScheduler({ dataDir });
  const jobs = second.listJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, job.id);
  assert.equal(jobs[0].name, "Morning market check");
});

test("removeJob deletes a job and reports whether it existed", () => {
  const scheduler = createCronScheduler({ dataDir: createTempDir() });
  const job = scheduler.addJob({
    jobType: "script",
    actionName: "x",
    schedule: { type: "interval", everyMs: 1000 },
  });
  assert.equal(scheduler.removeJob(job.id), true);
  assert.equal(scheduler.listJobs().length, 0);
  assert.equal(scheduler.removeJob(job.id), false);
});

test("runDueJobs fires a script job once due, delivers the result, and reschedules it", async () => {
  let now = 1000;
  const results = [];
  const scheduler = createCronScheduler({
    dataDir: createTempDir(),
    now: () => now,
    scriptActions: { getGreeting: async () => "hello from the script" },
    onResult: (job, result, error) => results.push({ job, result, error }),
  });
  scheduler.addJob({
    name: "Greeting job",
    jobType: "script",
    actionName: "getGreeting",
    schedule: { type: "interval", everyMs: 500 },
  });

  // Not due yet.
  await scheduler.runDueJobs();
  assert.equal(results.length, 0);

  now = 1600; // past the job's nextRunAt (1500)
  await scheduler.runDueJobs();
  assert.equal(results.length, 1);
  assert.equal(results[0].result, "hello from the script");
  assert.equal(results[0].error, null);

  const [job] = scheduler.listJobs();
  assert.equal(job.lastRunAt, 1600);
  assert.equal(job.nextRunAt, 2100);
});

test("runDueJobs delivers an error via onResult and doesn't stop other jobs when one fails", async () => {
  let now = 1000;
  const results = [];
  const scheduler = createCronScheduler({
    dataDir: createTempDir(),
    now: () => now,
    scriptActions: {
      broken: async () => {
        throw new Error("action exploded");
      },
      fine: async () => "ok",
    },
    onResult: (job, result, error) => results.push({ name: job.name, result, error }),
  });
  scheduler.addJob({
    name: "Broken job",
    jobType: "script",
    actionName: "broken",
    schedule: { type: "interval", everyMs: 100 },
  });
  scheduler.addJob({
    name: "Fine job",
    jobType: "script",
    actionName: "fine",
    schedule: { type: "interval", everyMs: 100 },
  });

  now = 1200;
  await scheduler.runDueJobs();

  assert.equal(results.length, 2);
  const broken = results.find((r) => r.name === "Broken job");
  const fine = results.find((r) => r.name === "Fine job");
  assert.match(broken.error, /action exploded/);
  assert.equal(fine.result, "ok");
  assert.equal(fine.error, null);
});

test("runDueJobs never fires a disabled job", async () => {
  let now = 1000;
  let calls = 0;
  const scheduler = createCronScheduler({
    dataDir: createTempDir(),
    now: () => now,
    scriptActions: { noop: async () => (calls += 1) },
  });
  scheduler.addJob({
    jobType: "script",
    actionName: "noop",
    schedule: { type: "interval", everyMs: 100 },
    enabled: false,
  });

  now = 5000;
  await scheduler.runDueJobs();
  assert.equal(calls, 0);
});

test("runDueJobs routes an agent job through the injected runAgentJob executor", async () => {
  let now = 1000;
  const prompts = [];
  const scheduler = createCronScheduler({
    dataDir: createTempDir(),
    now: () => now,
    runAgentJob: async (job) => {
      prompts.push(job.prompt);
      return `replied to: ${job.prompt}`;
    },
  });
  scheduler.addJob({
    jobType: "agent",
    prompt: "Summarize today's market",
    schedule: { type: "interval", everyMs: 100 },
  });

  now = 1200;
  await scheduler.runDueJobs();
  assert.deepEqual(prompts, ["Summarize today's market"]);
});
