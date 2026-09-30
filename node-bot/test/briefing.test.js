// #907: the daily briefing -- settings, once a day at or after its time,
// what each section gathers, and the model-or-plain-notes text.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBriefing } = require("../briefing");

const at = (d, h, m) => new Date(2026, 8, d, h, m).getTime();
const iso = (d) => new Date(2026, 8, d, 12, 0).toISOString();

function setup({ clock = at(30, 9, 0), reply = null, calendar, searchFails = false, facts } = {}) {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-briefing-")), "briefing.json");
  const offers = [];
  const searches = [];
  const prompts = [];
  const state = { clock };
  const deps = {
    filePath,
    now: () => state.clock,
    listFacts: () =>
      facts || [
        { key: "user name", text: "Yuuzu", status: "active", updatedAt: iso(1) },
        { key: "dentist", text: "Dentist on Friday at 3", status: "active", updatedAt: iso(29) },
        { key: "old exam", text: "Exam on Monday", status: "active", updatedAt: iso(1) }, // too old
        { key: "cat", text: "Has a cat", status: "active", updatedAt: iso(29) }, // not time-bound
        { key: "pending", text: "Interview tomorrow", status: "pending", updatedAt: iso(29) },
        { key: "gpu", text: "mention the 5090 price", trigger: "GPUs", status: "active", updatedAt: iso(20) },
        { key: "paused", text: "x", trigger: "y", paused: true, status: "active", updatedAt: iso(20) },
      ],
    listJobs: () => [
      { jobType: "reminder", name: "raid", schedule: { type: "once" }, nextRunAt: at(30, 20, 50) },
      { jobType: "reminder", name: "retainers", schedule: { type: "once" }, nextRunAt: at(30, 14, 0) },
      { jobType: "reminder", name: "tomorrow thing", schedule: { type: "once" }, nextRunAt: at(31, 9, 0) },
      { jobType: "reminder", name: "stretch", schedule: { type: "interval" }, nextRunAt: at(30, 10, 0) },
      { jobType: "agent", name: "summary", schedule: { type: "daily" }, nextRunAt: at(30, 11, 0) },
    ],
    searchWeb: async (query, options) => {
      searches.push([query, options.timeRange]);
      if (searchFails) throw new Error("web access is off");
      return [{ title: `${query} headline` }];
    },
    runLocalReply: async (prompt) => {
      prompts.push(prompt);
      return reply;
    },
    calendar,
    offer: (candidate) => offers.push(candidate),
  };
  return { briefing: createBriefing(deps), deps, offers, searches, prompts, state, filePath };
}

test("#907 settings: defaults, validation, saved to disk", () => {
  const { briefing, deps } = setup();
  assert.deepEqual(briefing.settings(), {
    enabled: true,
    time: "08:00",
    sections: ["memory", "reminders", "news", "games", "calendar"],
    topics: "",
    games: "FFXIV",
  });
  assert.throws(() => briefing.update({ time: "8am" }), /HH:MM/);
  const saved = briefing.update({ time: "7:30", sections: ["news", "bogus", "reminders"], topics: "GPUs, Formula 1" });
  assert.equal(saved.time, "07:30");
  assert.deepEqual(saved.sections, ["reminders", "news"]);
  assert.deepEqual(createBriefing(deps).settings(), saved);
});

test("#907 runs once a day at or after its time, through the proactive engine", async () => {
  const { briefing, offers, searches, prompts, state } = setup({ clock: at(30, 7, 59) });
  briefing.update({ topics: "GPUs" });
  assert.equal(briefing.maybeRun(), null); // before 08:00
  state.clock = at(30, 9, 0);
  const run = briefing.maybeRun();
  // #1124: what the Background tasks panel reads.
  assert.deepEqual(briefing.status(), { enabled: true, time: "08:00", lastDay: new Date(at(30, 9, 0)).toDateString(), running: true });
  await run;
  assert.equal(briefing.status().running, false);
  assert.equal(briefing.maybeRun(), null); // once a day
  assert.deepEqual(searches, [
    ["GPUs news", "day"],
    ["FFXIV patch notes maintenance", "week"],
  ]);
  assert.equal(offers.length, 1);
  const { reason, explicit, payload } = offers[0];
  assert.equal(reason, "briefing");
  assert.ok(!explicit); // held mid-game until a break, like any remark
  assert.equal(payload.speak, payload.text);
  assert.equal(payload.kind, "briefing"); // #1024: said cheerfully
  // No model loaded: the plain notes, in order.
  assert.equal(
    payload.text,
    "Yuuzu, here's your day. Reminders today: 14:00 retainers; 20:50 raid. " +
      "Coming up: Dentist on Friday at 3 (noted 2026-09-29). Keeping in mind: when GPUs comes up: mention the 5090 price. " +
      "News: GPUs: GPUs news headline. Game news: FFXIV: FFXIV patch notes maintenance headline.",
  );
  assert.match(prompts[0], /^Today is Wednesday 30 September\. Give Yuuzu a short spoken briefing/);

  state.clock = at(31, 8, 0);
  await briefing.maybeRun();
  assert.equal(offers.length, 2); // the next day
});

test("#907 the loaded model writes it; off sections, failed searches and no calendar are skipped", async () => {
  const { briefing, offers, prompts, searches } = setup({ reply: "  Raid at 20:50, Yuuzu!  ", searchFails: true });
  briefing.update({ sections: ["reminders", "news", "calendar"], topics: "GPUs" });
  await briefing.maybeRun();
  assert.equal(offers[0].payload.text, "Raid at 20:50, Yuuzu!");
  assert.deepEqual(searches, [["GPUs news", "day"]]);
  assert.doesNotMatch(prompts[0], /Coming up|News|Calendar/);
});

test("#907 calendar hook (#906), nothing to say, disabled, and brief me on demand", async () => {
  const withCalendar = setup({ calendar: async () => ["10:00 dentist", "2 unread emails"] });
  withCalendar.briefing.update({ sections: ["calendar"] });
  assert.match(await withCalendar.briefing.toolSource.executeTool("briefing__now", {}), /Calendar and mail:\n- 10:00 dentist\n- 2 unread emails/);
  assert.equal(withCalendar.briefing.maybeRun(), null); // brief me counted as today's

  const empty = setup({ facts: [] });
  empty.briefing.update({ sections: ["memory"] });
  await empty.briefing.maybeRun();
  assert.equal(empty.offers.length, 0);
  assert.equal(await empty.briefing.toolSource.executeTool("briefing__now", {}), "Nothing on the briefing today.");

  const off = setup();
  off.briefing.update({ enabled: false });
  assert.equal(off.briefing.maybeRun(), null);
});

test("#907 a broken briefing.json is never overwritten", () => {
  const { filePath, deps } = setup();
  fs.writeFileSync(filePath, "{ nope");
  const briefing = createBriefing(deps);
  assert.equal(briefing.maybeRun(), null);
  assert.throws(() => briefing.update({ enabled: false }), /couldn't be read/);
  assert.equal(fs.readFileSync(filePath, "utf8"), "{ nope");
});
