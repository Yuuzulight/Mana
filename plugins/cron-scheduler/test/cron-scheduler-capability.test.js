const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("../../../node-bot/node_modules/express");
const test = require("node:test");

const cronPlugin = require("../index");
const trayNotifier = require("../../../node-bot/tray-notifier");
const { withServer } = require("./helpers");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-cron-routes-"));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

function buildApp(deps) {
  cronPlugin._resetForTests();
  const app = express();
  app.use(express.json());
  cronPlugin.registerRoutes(app, { dataDir: createTempDir(), ...deps });
  return app;
}

test("POST /cron/jobs creates a job, GET /cron/jobs lists it, DELETE removes it", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const create = await postJson(`${baseUrl}/cron/jobs`, {
      name: "Daily check",
      jobType: "script",
      actionName: "noop",
      schedule: { type: "daily", hour: 9, minute: 0 },
    });
    assert.equal(create.response.status, 201);
    const id = create.payload.id;

    const list = await fetch(`${baseUrl}/cron/jobs`);
    const listPayload = await list.json();
    assert.ok(listPayload.jobs.some((j) => j.id === id));

    const del = await fetch(`${baseUrl}/cron/jobs/${id}`, { method: "DELETE" });
    assert.equal(del.status, 200);

    const listAfter = await fetch(`${baseUrl}/cron/jobs`);
    const listAfterPayload = await listAfter.json();
    assert.ok(!listAfterPayload.jobs.some((j) => j.id === id));
  });
});

test("POST /cron/jobs surfaces validation errors as 400s", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/cron/jobs`, {
      jobType: "script",
      schedule: { type: "interval", everyMs: 1000 },
    });
    assert.equal(response.status, 400);
    assert.match(payload.error, /actionName is required/);
  });
});

test("DELETE /cron/jobs/:id reports 404 for an unknown job", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/cron/jobs/does-not-exist`, { method: "DELETE" });
    assert.equal(response.status, 404);
  });
});

test("POST /cron/jobs accepts an agent job (prompt required instead of actionName)", async () => {
  const app = buildApp({});
  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/cron/jobs`, {
      name: "Daily summary",
      jobType: "agent",
      prompt: "Summarize today's FFXIV market",
      sessionId: "test-session",
      schedule: { type: "daily", hour: 9, minute: 0 },
    });
    assert.equal(response.status, 201);
    assert.equal(payload.jobType, "agent");
    assert.equal(payload.prompt, "Summarize today's FFXIV market");
  });
});

test("a completed cron job notifies the tray in addition to recording a chat turn (issue #423)", async () => {
  cronPlugin._resetForTests();
  const trayEvents = [];
  trayNotifier.setBroadcaster((payload) => trayEvents.push(payload));
  const turns = [];

  let now = 1000;
  const scheduler = cronPlugin._getSchedulerForTests({
    dataDir: createTempDir(),
    now: () => now,
    scriptActions: { getGreeting: async () => "hello from the script" },
    acpMemoryStore: {
      appendTurn: async (turn) => {
        turns.push(turn);
      },
    },
  });
  scheduler.addJob({
    name: "Greeting job",
    jobType: "script",
    actionName: "getGreeting",
    schedule: { type: "interval", everyMs: 500 },
  });

  now = 1600; // past the job's nextRunAt
  await scheduler.runDueJobs();

  assert.equal(trayEvents.length, 1);
  assert.equal(trayEvents[0].type, "cron");
  assert.match(trayEvents[0].title, /Greeting job/);
  assert.equal(trayEvents[0].text, "hello from the script");

  assert.equal(turns.length, 1);
  assert.equal(turns[0].assistant, "hello from the script");
});

// #1265: a script action that sends its own notices returns null.
test("a script job with nothing to say (null) stays quiet", async () => {
  cronPlugin._resetForTests();
  const trayEvents = [];
  trayNotifier.setBroadcaster((payload) => trayEvents.push(payload));
  const turns = [];
  let now = 1000;
  const scheduler = cronPlugin._getSchedulerForTests({
    dataDir: createTempDir(),
    now: () => now,
    scriptActions: { quiet: async () => null },
    acpMemoryStore: { appendTurn: async (turn) => turns.push(turn) },
  });
  scheduler.addJob({ name: "Quiet job", jobType: "script", actionName: "quiet", schedule: { type: "interval", everyMs: 500 } });
  now = 1600;
  await scheduler.runDueJobs();
  assert.deepEqual(trayEvents, []);
  assert.deepEqual(turns, []);
  assert.equal(scheduler.listJobs()[0].lastError, null);
});

test("a failed cron job still notifies the tray, even with no acpMemoryStore configured (issue #423)", async () => {
  cronPlugin._resetForTests();
  const trayEvents = [];
  trayNotifier.setBroadcaster((payload) => trayEvents.push(payload));

  let now = 1000;
  const scheduler = cronPlugin._getSchedulerForTests({
    dataDir: createTempDir(),
    now: () => now,
    scriptActions: {
      breaks: async () => {
        throw new Error("boom");
      },
    },
    // No acpMemoryStore -- must not prevent the tray notification.
  });
  scheduler.addJob({
    name: "Flaky job",
    jobType: "script",
    actionName: "breaks",
    schedule: { type: "interval", everyMs: 500 },
  });

  now = 1600;
  await scheduler.runDueJobs();

  assert.equal(trayEvents.length, 1);
  assert.equal(trayEvents[0].type, "cron");
  assert.match(trayEvents[0].text, /failed/);
});

test("#905 a reminder is a Reminder toast and a spoken line through the proactive engine, even mid-game", async () => {
  cronPlugin._resetForTests();
  const trayEvents = [];
  trayNotifier.setBroadcaster((payload) => trayEvents.push(payload));
  const proactive = require("../../../node-bot/proactive");
  proactive.watchGaming(() => true);
  try {
    const noon = new Date(2026, 9, 2, 12, 0).getTime(); // outside quiet time
    let now = noon;
    const scheduler = cronPlugin._getSchedulerForTests({
      dataDir: createTempDir(),
      now: () => now,
      acpMemoryStore: { listFacts: () => [{ key: "name", text: "Yuuzu", status: "active" }] },
    });
    scheduler.addJob({ name: "raid in 10 minutes.", jobType: "reminder", schedule: { type: "once", at: noon + 500 } });
    now = noon + 600;
    await scheduler.runDueJobs();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      trayEvents.map((e) => [e.type, e.title, e.text, e.speak, e.kind]),
      [["cron", "Reminder", "raid in 10 minutes.", "Yuuzu, raid in 10 minutes!", "reminder"]],
    );
    assert.deepEqual(scheduler.listJobs(), []);
  } finally {
    proactive.watchGaming(() => false);
  }
});

test("#1024 a reminder that fires well after its time is marked late", async () => {
  cronPlugin._resetForTests();
  const proactive = require("../../../node-bot/proactive");
  const realOffer = proactive.offer;
  const offered = [];
  proactive.offer = (candidate) => (offered.push(candidate), "held");
  try {
    let now = 1000;
    const scheduler = cronPlugin._getSchedulerForTests({ dataDir: createTempDir(), now: () => now });
    scheduler.addJob({ name: "stretch.", jobType: "reminder", schedule: { type: "once", at: 1500 } });
    now = 1500 + 6 * 60 * 1000;
    await scheduler.runDueJobs();
    assert.deepEqual(offered.map((c) => c.payload.kind), ["reminder-late"]);
  } finally {
    proactive.offer = realOffer;
  }
});

test("plugin metadata matches the shape other Mana plugins use", () => {
  assert.equal(cronPlugin.key, "cronScheduler");
  assert.equal(cronPlugin.category, "Automation");
  assert.equal(cronPlugin.defaultEnabled, false);
  assert.equal(typeof cronPlugin.registerRoutes, "function");
  const health = cronPlugin.getHealth({ dataDir: createTempDir() });
  assert.equal(health.status, "available");
});

// Tier 3 #2: catching up after Mana was off.
async function catchUp(names, { dueAt, now }) {
  cronPlugin._resetForTests();
  const proactive = require("../../../node-bot/proactive");
  const realOffer = proactive.offer;
  const offered = [];
  proactive.offer = (candidate) => (offered.push(candidate.payload), "held");
  try {
    let clock = dueAt - 1000;
    const scheduler = cronPlugin._getSchedulerForTests({ dataDir: createTempDir(), now: () => clock });
    for (const name of names) scheduler.addJob({ name, jobType: "reminder", schedule: { type: "once", at: dueAt } });
    clock = now;
    await scheduler.runDueJobs();
    await new Promise((resolve) => setImmediate(resolve));
    return { offered, scheduler };
  } finally {
    proactive.offer = realOffer;
  }
}

test("missed reminders: the first 3 come back one by one, the rest as one 'and N more'", async () => {
  const noon = new Date(2026, 9, 2, 12, 0).getTime();
  const { offered, scheduler } = await catchUp(["a", "b", "c", "d", "e"], { dueAt: noon - 3 * 60 * 60 * 1000, now: noon });
  assert.deepEqual(
    offered.map((p) => [p.title, p.text, p.kind]),
    [
      ["Reminder", "a", "reminder-late"],
      ["Reminder", "b", "reminder-late"],
      ["Reminder", "c", "reminder-late"],
      ["Reminders", "And 2 more: d; e", "reminder-late"],
    ],
  );
  assert.match(offered[3].speak, /^And 2 more reminders I missed/);
  assert.deepEqual(scheduler.listJobs(), []);
});

test("missed reminders older than a day aren't brought up", async () => {
  const noon = new Date(2026, 9, 2, 12, 0).getTime();
  const { offered, scheduler } = await catchUp(["old"], { dueAt: noon - 25 * 60 * 60 * 1000, now: noon });
  assert.deepEqual(offered, []);
  assert.deepEqual(scheduler.listJobs(), []);
});

test("in quiet time (1am-9am) a reminder is a silent toast, said once quiet time is over", async () => {
  const threeAm = new Date(2026, 9, 2, 3, 0).getTime();
  const { offered } = await catchUp(["water the plants."], { dueAt: threeAm, now: threeAm });
  assert.equal(offered.length, 1);
  assert.equal(offered[0].text, "water the plants.");
  assert.equal(offered[0].speak, undefined);

  const proactive = require("../../../node-bot/proactive");
  const realOffer = proactive.offer;
  const later = [];
  proactive.offer = (candidate) => (later.push(candidate.payload), "held");
  try {
    cronPlugin._sayHeldRemindersForTests(new Date(2026, 9, 2, 8, 59).getTime());
    assert.deepEqual(later, []);
    cronPlugin._sayHeldRemindersForTests(new Date(2026, 9, 2, 9, 0).getTime());
    assert.deepEqual(later.map((p) => [p.text, p.speak, p.kind]), [["water the plants.", "water the plants!", "reminder-late"]]);
  } finally {
    proactive.offer = realOffer;
  }
});

test("#699: an urgent heartbeat report is toasted at once, silently in quiet time", async () => {
  const proactive = require("../../../node-bot/proactive");
  const realOffer = proactive.offer;
  const offered = [];
  const trayEvents = [];
  proactive.offer = (c) => offered.push(c);
  trayNotifier.setBroadcaster((payload) => trayEvents.push(payload));
  try {
    const quiet = new Date(2026, 9, 2, 3).getTime();
    const day = new Date(2026, 9, 2, 14).getTime();
    await cronPlugin._notifyHeartbeatForTests({ type: "cron", text: "disk full", urgent: true, speak: "disk full!" }, quiet);
    await cronPlugin._notifyHeartbeatForTests({ type: "cron", text: "disk full", urgent: true, speak: "disk full!" }, day);
    cronPlugin._notifyHeartbeatForTests({ type: "cron", text: "all fine" }, day);
    assert.deepEqual(trayEvents.map((p) => [p.text, p.speak]), [["disk full", undefined], ["disk full", "disk full!"]]);
    assert.deepEqual(offered.map((c) => [c.reason, c.payload.text]), [["heartbeat", "all fine"]]);
  } finally {
    proactive.offer = realOffer;
  }
});
