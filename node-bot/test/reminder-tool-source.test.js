// #905: reminders from chat -- set (relative, clock time, tomorrow,
// recurring), list and cancel, on top of cron-scheduler's job store.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCronScheduler } = require("../../plugins/cron-scheduler/cron-scheduler");
const { createReminderToolSource, toSchedule } = require("../ai/reminder-tool-source");

const now = new Date(2026, 8, 30, 20, 0).getTime();
const at = (d, h, m) => new Date(2026, 8, d, h, m).getTime();

test("#905 times resolve on the local clock", () => {
  assert.deepEqual(toSchedule({ in_minutes: 40 }, now), { type: "once", at: now + 40 * 60000 });
  assert.deepEqual(toSchedule({ at: "20:50" }, now), { type: "once", at: at(30, 20, 50) });
  assert.deepEqual(toSchedule({ at: "9:00" }, now), { type: "once", at: at(31, 9, 0) }); // passed today
  assert.deepEqual(toSchedule({ at: "21:00", tomorrow: true }, now), { type: "once", at: at(31, 21, 0) });
  assert.deepEqual(toSchedule({ at: "09:00", daily: true }, now), { type: "daily", hour: 9, minute: 0 });
  assert.deepEqual(toSchedule({ every_minutes: 120 }, now), { type: "interval", everyMs: 120 * 60000 });
  assert.throws(() => toSchedule({ at: "9pm" }, now), /HH:MM/);
  assert.throws(() => toSchedule({ in_minutes: 5, at: "21:00" }, now), /exactly one/);
  assert.throws(() => toSchedule({ in_minutes: 0 }, now), /more than 0/);
});

test("#905 set, list and cancel reminders; other cron jobs are off limits", async () => {
  const scheduler = createCronScheduler({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-reminders-")), now: () => now });
  const other = scheduler.addJob({ name: "summary", jobType: "agent", prompt: "x", schedule: { type: "daily", hour: 9, minute: 0 } });
  const tools = createReminderToolSource({ getScheduler: () => scheduler, sessionId: "s1", now: () => now });
  const call = async (name, args) => JSON.parse(await tools.executeTool(name, args));

  const { reminder } = await call("reminder__set", { text: "check my retainers", in_minutes: 40 });
  assert.deepEqual(reminder, { id: reminder.id, text: "check my retainers", next: "2026-09-30 20:40" });
  assert.equal(scheduler.listJobs().find((j) => j.id === reminder.id).sessionId, "s1");

  const { reminders } = await call("reminder__list", {});
  assert.deepEqual(reminders.map((r) => r.text), ["check my retainers"]);

  await assert.rejects(tools.executeTool("reminder__cancel", { id: other.id }), /no reminder/);
  assert.deepEqual(await call("reminder__cancel", { id: reminder.id }), { ok: true, cancelled: reminder.id });
  assert.deepEqual(scheduler.listJobs().map((j) => j.id), [other.id]);
});

test("#905 chat replies get the reminder tools, logged to their session; scheduled replies don't", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  const cronPlugin = require("../../plugins/cron-scheduler");
  cronPlugin._resetForTests();
  // The plugin's singleton, on a temp dir; createApp's route registration reuses it.
  const scheduler = cronPlugin._getSchedulerForTests({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-reminders-")) });
  try {
    const tools = [];
    const app = require("../server").createApp({
      llamaServerRuntime: { isEnabled: () => true },
      runToolAwareReply: async (prompt, toolPolicy) => {
        tools.push(toolPolicy.tools.map((t) => t.function.name));
        if (tools.length === 1) await toolPolicy.executeTool("reminder__set", { text: "raid", in_minutes: 10 });
        return { content: "ok", toolCalls: [], rounds: 1 };
      },
    });
    await app.locals.buildAssistantReply("remind me in 10 minutes, raid", "", "", "default", "s1", null, null, {});
    await app.locals.buildAssistantReply("daily summary", "", "", "default", "s1", null, null, { scheduled: true });
    assert.equal(tools[0].includes("reminder__set"), true);
    assert.equal(tools.at(-1).includes("reminder__set"), false);
    assert.deepEqual(scheduler.listJobs().map((j) => [j.name, j.jobType, j.sessionId]), [["raid", "reminder", "s1"]]);
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
    cronPlugin._resetForTests();
  }
});
