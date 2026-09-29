// #905: Mana sets, lists and cancels reminders when asked in chat ("remind
// me in 40 minutes to check my retainers", "ping me at 20:50"). They are
// cron-scheduler "reminder" jobs, so they survive a restart and fire on the
// scheduler's tick; delivery goes through the proactive engine as explicit
// (plugins/cron-scheduler/index.js), so they get through even mid-game. No
// model call when one fires -- the reminder text is the message.
//
// Times are the backend's local clock (the user's own PC), so the model
// never has to know today's date: "at 21:00" is the next 21:00, "tomorrow
// at 9" is at "09:00" with tomorrow: true.
const REMINDER_TOOL_PREFIX = "reminder__";
const MINUTE = 60 * 1000;

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "reminder__set",
      description:
        "Set a reminder or timer the user asked for. Give exactly one of in_minutes (\"in 40 minutes\"), at (\"at 21:00\", \"tomorrow at 9\") or every_minutes (\"every 2 hours\"). It shows up as a notification at that time, even mid-game.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to remind the user of, short, e.g. \"check your retainers\"." },
          in_minutes: { type: "number", description: "Fire once, this many minutes from now." },
          at: { type: "string", description: "Local time, 24-hour HH:MM. Fires at its next occurrence." },
          tomorrow: { type: "boolean", description: "With at: tomorrow at that time rather than its next occurrence." },
          daily: { type: "boolean", description: "With at: repeat every day at that time." },
          every_minutes: { type: "number", description: "Repeat every this many minutes (at least 5)." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reminder__list",
      description: "List the user's pending reminders with their ids and when each fires next.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "reminder__cancel",
      description: "Cancel a reminder by the id reminder__list or reminder__set gave.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The reminder's id." } },
        required: ["id"],
      },
    },
  },
];

function isReminderToolName(name) {
  return typeof name === "string" && name.startsWith(REMINDER_TOOL_PREFIX);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// args -> a cron-scheduler schedule, relative to nowMs.
function toSchedule(args, nowMs) {
  const given = ["in_minutes", "at", "every_minutes"].filter((k) => args[k] !== undefined && args[k] !== null);
  if (given.length !== 1) throw new Error("give exactly one of in_minutes, at or every_minutes");
  if (given[0] === "in_minutes") {
    const m = Number(args.in_minutes);
    if (!(m > 0)) throw new Error("in_minutes must be more than 0");
    return { type: "once", at: nowMs + Math.round(m * MINUTE) };
  }
  if (given[0] === "every_minutes") {
    const m = Number(args.every_minutes);
    // Same floor as heartbeat checks: an explicit reminder gets through
    // mid-game, so a one-minute repeat would be a toast every minute.
    if (!(m >= 5)) throw new Error("every_minutes must be at least 5");
    return { type: "interval", everyMs: Math.round(m * MINUTE) };
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(args.at).trim());
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!(hour <= 23 && minute <= 59)) throw new Error("at must be a 24-hour HH:MM time, e.g. 21:00");
  if (args.daily) return { type: "daily", hour, minute };
  const d = new Date(nowMs);
  if (args.tomorrow) d.setDate(d.getDate() + 1);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return { type: "once", at: d.getTime() };
}

function describe(job) {
  return {
    id: job.id,
    text: job.name,
    next: formatLocal(job.nextRunAt),
    ...(job.schedule.type === "once" ? {} : { repeats: true }),
  };
}

// getScheduler: plugins/cron-scheduler's, called only when a tool runs (so
// a reply that never uses one never creates the job store). sessionId: the
// reply's session, where the reminder is also logged when it fires.
function createReminderToolSource({ getScheduler, sessionId, now = Date.now }) {
  const reminders = () =>
    getScheduler()
      .listJobs()
      .filter((j) => j.jobType === "reminder");

  async function executeTool(name, args = {}) {
    if (name === "reminder__set") {
      const text = String(args.text || "").trim();
      if (!text) throw new Error("text is required");
      const job = getScheduler().addJob({
        name: text,
        jobType: "reminder",
        schedule: toSchedule(args, now()),
        sessionId: sessionId || undefined,
      });
      return JSON.stringify({ ok: true, reminder: describe(job) });
    }
    if (name === "reminder__list") {
      return JSON.stringify({ reminders: reminders().map(describe) });
    }
    if (name === "reminder__cancel") {
      const id = String(args.id || "");
      // Only reminders: the model can't cancel the user's own cron jobs.
      if (!reminders().some((j) => j.id === id)) throw new Error(`no reminder with id "${id}"`);
      getScheduler().removeJob(id);
      return JSON.stringify({ ok: true, cancelled: id });
    }
    throw new Error(`unknown reminder tool: ${name}`);
  }

  return { listToolSchemas: () => TOOL_SCHEMAS, executeTool, isKnownToolName: isReminderToolName };
}

module.exports = { createReminderToolSource, toSchedule };
