// #1124: GET /background-tasks and its cancel, with a fake per source.
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const test = require("node:test");

const {
  backgroundTasksCapability,
  cancelBackgroundTask,
  etaSeconds,
  listBackgroundTasks,
} = require("../capabilities/background-tasks-capability");

const MIN = 60 * 1000;
const NOW = new Date(2026, 9, 1, 12, 0).getTime();

function fakeSources(overrides = {}) {
  const calls = [];
  const jobs = [
    { id: "r1", jobType: "reminder", name: "Raid", enabled: true, createdAt: NOW - 30 * MIN, lastRunAt: null, nextRunAt: NOW + 10 * MIN },
    { id: "c1", jobType: "agent", name: "Daily summary", enabled: false, createdAt: NOW - MIN, lastRunAt: null, nextRunAt: NOW + MIN, lastError: "boom" },
  ];
  const researchJobs = new Map([
    ["j1", { id: "j1", question: "GPUs", status: "running", cancelRequested: false, startedAt: new Date(NOW - MIN).toISOString(), progress: { step: "reading", label: "Reading source 2 of 8...", index: 2, total: 8 } }],
    ["j2", { id: "j2", question: "Tea", status: "running", cancelRequested: false, startedAt: new Date(NOW).toISOString(), progress: { step: "planning", label: "Planning..." } }],
  ]);
  const sources = {
    now: () => NOW,
    isGaming: () => false,
    cron: () => ({
      listJobs: () => jobs,
      removeJob: (id) => {
        calls.push(["removeJob", id]);
        return true;
      },
    }),
    heartbeat: () => ({
      listChecks: () => [
        { id: "h1", text: "check disk space", approved: true, nextRunAt: NOW + 5 * MIN, lastError: null, awaitingApproval: false },
        { id: "h2", text: "check mail", approved: false, nextRunAt: 0, lastError: null, awaitingApproval: true },
      ],
    }),
    heartbeatEnabled: () => true,
    proactive: { listHeld: () => [{ reason: "dream-insight", title: "Dream Mode", text: "A thought", urgent: false, expiresAt: NOW + MIN }] },
    briefing: { status: () => ({ enabled: true, time: "18:30", lastDay: "", running: false }) },
    dreamMode: () => ({ everyMs: 60 * MIN, scheduledAt: NOW - 90 * MIN, runningSince: null }),
    embeddings: { status: () => ({ running: true, total: 110, processed: 35, startProcessed: 10, startedAt: NOW - MIN, remaining: 75, lastError: null }) },
    memoryVault: () => ({ vaultDir: "D:\\Vault", notes: 12, error: null }),
    researchJobs,
    selfWork: () => ({
      status: () => ({ state: "running", issue: 7, title: "Fix add", startedAt: new Date(NOW - 2 * MIN).toISOString(), step: "Working on it", round: 5, maxRounds: 20 }),
      stop: () => {
        calls.push(["selfWork.stop"]);
        return true;
      },
    }),
    agentActivity: {
      list: () => [{ id: "3", elapsedMs: 4000, tool: "web__search", toolCount: 1, stopping: false }],
      stop: (id) => {
        calls.push(["agent.stop", id]);
        return id === "3";
      },
    },
    llama: { getStatus: () => ({ loading: { model: "D:\\models\\qwen.gguf", since: NOW - 3000 } }) },
    llamaBuilds: { getStatus: () => ({ job: { state: "running", tag: "b9000", step: "Downloading x.zip", error: null, download: { done: 100, total: 400, since: NOW - 10000 } } }) },
    fishWarmup: () => "warming",
    ...overrides,
  };
  return { sources, calls, researchJobs };
}

const byId = (tasks) => Object.fromEntries(tasks.map((t) => [t.id, t]));

test("every source's state becomes a task", () => {
  const tasks = byId(listBackgroundTasks(fakeSources().sources));

  assert.deepEqual(tasks["reminder:r1"], {
    id: "reminder:r1",
    kind: "reminder",
    title: "Raid",
    status: "scheduled",
    nextRunAt: new Date(NOW + 10 * MIN).toISOString(),
    // Its countdown: 30 of 40 minutes gone.
    progress: { done: 30 * MIN, total: 40 * MIN, unit: "ms" },
    canCancel: true,
  });
  assert.equal(tasks["cron:c1"].status, "paused");
  assert.equal(tasks["cron:c1"].progress, undefined);
  assert.match(tasks["cron:c1"].detail, /boom/);

  assert.equal(tasks["heartbeat:h1"].status, "scheduled");
  assert.equal(tasks["heartbeat:h2"].status, "waiting");
  assert.equal(tasks["heartbeat:h2"].nextRunAt, undefined);
  assert.equal(tasks["proactive:dream-insight:" + (NOW + MIN)].status, "waiting");

  assert.equal(tasks.briefing.status, "scheduled");
  assert.equal(tasks.briefing.nextRunAt, new Date(2026, 9, 1, 18, 30).toISOString());
  // Started 90 min ago, every 60: the next tick is 30 min away.
  assert.equal(tasks["dream-mode"].nextRunAt, new Date(NOW + 30 * MIN).toISOString());

  // This run: 25 of 100 files in a minute, so about 3 minutes left.
  assert.deepEqual(tasks["retriever-embeddings"].progress, { done: 25, total: 100, unit: "files" });
  assert.equal(tasks["retriever-embeddings"].etaSeconds, 180);
  assert.equal(tasks["memory-vault"].status, "waiting");

  assert.deepEqual(tasks["research:j1"].progress, { done: 2, total: 8, unit: "sources" });
  assert.equal(tasks["research:j1"].title, "Research: GPUs");
  assert.equal(tasks["research:j1"].canCancel, true);

  assert.deepEqual(tasks["self-work"].progress, { done: 5, total: 20, unit: "rounds" });
  assert.equal(tasks["self-work"].title, "#7: Fix add");
  assert.equal(tasks["agent:3"].detail, "Using web__search");
  assert.equal(tasks["agent:3"].startedAt, new Date(NOW - 4000).toISOString());

  assert.equal(tasks["llama-load"].title, "Loading qwen.gguf");
  // 100 of 400 bytes in 10 s: 30 s left.
  assert.deepEqual(tasks["llama-update"].progress, { done: 100, total: 400, unit: "bytes" });
  assert.equal(tasks["llama-update"].etaSeconds, 30);
  assert.equal(tasks["fish-warmup"].status, "running");
});

test("no made-up percentages: unmeasured work has no progress and no ETA", () => {
  const { sources } = fakeSources({
    llamaBuilds: { getStatus: () => ({ job: { state: "running", step: "Downloading x.zip", download: { done: 100, total: null, since: NOW - 1000 } } }) },
  });
  const tasks = byId(listBackgroundTasks(sources));
  for (const id of ["research:j2", "llama-load", "llama-update", "fish-warmup", "agent:3"]) {
    assert.equal(tasks[id].status, "running", id);
    assert.equal(tasks[id].progress, undefined, id);
    assert.equal(tasks[id].etaSeconds, undefined, id);
  }
  // Rounds are out of a cap she may finish under, so no ETA from them.
  assert.equal(tasks["self-work"].etaSeconds, undefined);
});

test("ETA is elapsed / fraction done, and only once something is measured", () => {
  assert.equal(etaSeconds(0, 25, 100, 60000), 180);
  assert.equal(etaSeconds(0, 0, 100, 60000), undefined);
  assert.equal(etaSeconds(0, 100, 100, 60000), undefined);
  assert.equal(etaSeconds(60000, 10, 100, 60000), undefined);
});

test("briefing: done today means tomorrow; past its time means waiting for me", () => {
  const today = new Date(NOW).toDateString();
  const at = (st) => byId(listBackgroundTasks({ now: () => NOW, briefing: { status: () => st } })).briefing;
  assert.equal(at({ enabled: true, time: "08:00", lastDay: today }).nextRunAt, new Date(2026, 9, 2, 8, 0).toISOString());
  assert.equal(at({ enabled: true, time: "08:00", lastDay: "" }).status, "waiting");
  assert.equal(at({ enabled: false, time: "08:00", lastDay: "" }), undefined);
});

test("gaming pauses heartbeat checks and dream mode", () => {
  const tasks = byId(listBackgroundTasks(fakeSources({ isGaming: () => true }).sources));
  assert.equal(tasks["heartbeat:h1"].status, "paused");
  assert.equal(tasks["dream-mode"].status, "paused");
});

test("a source that throws is left out, not the whole list", () => {
  const { sources } = fakeSources({
    proactive: {
      listHeld: () => {
        throw new Error("broken");
      },
    },
  });
  const tasks = listBackgroundTasks(sources);
  assert.ok(tasks.some((t) => t.id === "reminder:r1"));
  assert.ok(!tasks.some((t) => t.kind === "proactive"));
});

test("cancel goes to each source's own stop, and nowhere else", () => {
  const { sources, calls, researchJobs } = fakeSources();
  assert.equal(cancelBackgroundTask(sources, "reminder:r1"), true);
  assert.equal(cancelBackgroundTask(sources, "cron:r1"), null, "a reminder isn't a cron job");
  assert.equal(cancelBackgroundTask(sources, "research:j1"), true);
  assert.equal(researchJobs.get("j1").cancelRequested, true);
  assert.equal(cancelBackgroundTask(sources, "research:j1"), false, "already cancelling");
  assert.equal(cancelBackgroundTask(sources, "self-work"), true);
  assert.equal(cancelBackgroundTask(sources, "agent:3"), true);
  assert.equal(cancelBackgroundTask(sources, "agent:9"), null);
  // Listed, but with no stop of their own.
  assert.equal(cancelBackgroundTask(sources, "heartbeat:h1"), false);
  assert.equal(cancelBackgroundTask(sources, "llama-load"), false);
  assert.equal(cancelBackgroundTask(sources, "nope"), null);
  assert.deepEqual(calls, [["removeJob", "r1"], ["selfWork.stop"], ["agent.stop", "3"], ["agent.stop", "9"]]);
});

async function withApp(sources, fn) {
  const app = express();
  app.use(express.json());
  backgroundTasksCapability.registerRoutes(app, {
    backgroundTaskSources: sources,
    checkAdminAuth: (req, res) => {
      if (req.headers["x-admin-key"] === "k") return true;
      res.status(401).json({ error: "unauthorized" });
      return false;
    },
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("routes need the admin key; cancel answers 404 / 409 / 200", async () => {
  const { sources } = fakeSources();
  await withApp(sources, async (base) => {
    const key = { "x-admin-key": "k" };
    assert.equal((await fetch(`${base}/background-tasks`)).status, 401);
    assert.equal((await fetch(`${base}/background-tasks/reminder:r1/cancel`, { method: "POST" })).status, 401);
    const list = await (await fetch(`${base}/background-tasks`, { headers: key })).json();
    assert.ok(list.tasks.some((t) => t.id === "self-work"));
    const cancel = (id) => fetch(`${base}/background-tasks/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: key });
    assert.equal((await cancel("reminder:r1")).status, 200);
    assert.equal((await cancel("heartbeat:h1")).status, 409);
    assert.equal((await cancel("nope")).status, 404);
  });
});
