// Issue #697: the proactive core -- threshold, daily budget, gaming-break
// gating, spacing and expiry.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProactive, DAILY_BUDGET } = require("../proactive");

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function setup() {
  const state = { t: new Date(2026, 8, 29, 12, 0).getTime(), gaming: false, inBreak: false, sent: [] };
  const p = createProactive({
    deliver: (payload) => state.sent.push(payload.text),
    isGaming: () => state.gaming,
    inBreak: () => state.inBreak,
    isAway: () => state.away,
    canDeliver: () => !state.noLauncher,
    now: () => state.t,
  });
  const say = (text, extra = {}) => p.offer({ reason: "test", payload: { text }, ...extra });
  // A flush a minute later, like server.js's 30 s timer eventually does.
  const later = () => {
    state.t += MINUTE;
    return p.flush()?.payload.text ?? null;
  };
  return { state, p, say, later };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("#697 scores below the threshold are dropped, urgent ones are not", async () => {
  const { state, say } = setup();
  assert.equal(say("meh", { score: 0.2 }), "dropped");
  assert.equal(say("important", { score: 0.2, urgent: true }), "delivered");
  await tick();
  assert.deepEqual(state.sent, ["important"]);
});

test("#697 remarks are a minute apart; waiting ones go best score first", async () => {
  const { state, p, say, later } = setup();
  assert.equal(say("a", { score: 0.6 }), "delivered");
  assert.equal(say("b", { score: 0.6 }), "held");
  assert.equal(say("c", { score: 0.9 }), "held");
  assert.equal(say("c", { score: 0.9 }), "held"); // same remark isn't queued twice
  assert.equal(p.flush(), null); // too soon
  assert.equal(later(), "c");
  assert.equal(later(), "b");
  assert.equal(later(), null);
  await tick();
  assert.deepEqual(state.sent, ["a", "c", "b"]);
});

test("#697 the daily budget holds the rest until tomorrow; urgent skips it", async () => {
  const { state, say, later } = setup();
  for (let i = 0; i < DAILY_BUDGET; i++) {
    say(`r${i}`, { ttlMs: DAY });
    state.t += MINUTE;
  }
  assert.equal(say("over", { ttlMs: DAY }), "held");
  assert.equal(later(), null);
  assert.equal(say("urgent", { urgent: true }), "delivered");
  state.t = new Date(2026, 8, 30, 8, 0).getTime();
  assert.equal(later(), "over");
  await tick();
  assert.equal(state.sent.length, DAILY_BUDGET + 2);
});

test("#697 nothing during play, at most one remark per break", async () => {
  const { state, say, later } = setup();
  state.gaming = true;
  assert.equal(say("x", { urgent: true }), "held");
  say("y");
  say("z");
  state.inBreak = true;
  assert.equal(later(), "x");
  assert.equal(later(), null); // same break
  state.inBreak = false;
  assert.equal(later(), null); // back in play
  state.inBreak = true;
  assert.equal(later(), "y"); // next break
  state.gaming = false;
  state.inBreak = false;
  assert.equal(later(), "z"); // game closed
  await tick();
  assert.deepEqual(state.sent, ["x", "y", "z"]);
});

test("#697 held remarks expire when stale", async () => {
  const { state, say, later } = setup();
  state.gaming = true;
  say("build finished"); // default 1 h
  say("insight", { ttlMs: 12 * 60 * MINUTE });
  state.t += 2 * 60 * MINUTE;
  state.gaming = false;
  assert.equal(later(), "insight");
  assert.equal(later(), null);
  await tick();
  assert.deepEqual(state.sent, ["insight"]);
});

test("#905 an explicit reminder gets through mid-game", async () => {
  const { state, say, later } = setup();
  state.gaming = true;
  say("remark", { urgent: true });
  assert.equal(say("check retainers", { explicit: true }), "delivered");
  assert.equal(later(), null); // the remark still waits for a break
  state.inBreak = true;
  assert.equal(later(), "remark");
  await tick();
  assert.deepEqual(state.sent, ["check retainers", "remark"]);
});

test("#986 held remarks and today's spend survive a restart", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proactive-")), "proactive-held.json");
  try {
    const before = setup();
    before.p.persistTo(file);
    for (let i = 0; i < DAILY_BUDGET; i++) {
      before.say(`r${i}`);
      before.state.t += MINUTE;
    }
    assert.equal(before.say("tomorrow", { ttlMs: DAY }), "held");

    const after = setup(); // a new backend process
    after.state.t = before.state.t;
    after.p.persistTo(file);
    assert.equal(after.later(), null); // today's budget is still spent
    after.state.t = new Date(2026, 8, 30, 8, 0).getTime();
    assert.equal(after.later(), "tomorrow");
    await tick();
    assert.deepEqual(after.state.sent, ["tomorrow"]);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("#914 a toast names the active character when she isn't Mana", async () => {
  const proactive = require("../proactive");
  const trayNotifier = require("../tray-notifier");
  const sent = [];
  trayNotifier.setBroadcaster((payload) => sent.push(payload.title));
  proactive.watchSpeaker(() => "Evil Mana");
  try {
    proactive.offer({ reason: "reminder", explicit: true, payload: { title: "Reminder", text: "raid" } });
    await tick();
    assert.deepEqual(sent, ["Evil Mana: Reminder"]);
  } finally {
    proactive.watchSpeaker(() => null);
  }
});

test("#1124 held remarks are listed for the Background tasks panel", () => {
  const { state, p, say } = setup();
  state.gaming = true;
  say("build finished", { score: 0.9 });
  assert.deepEqual(p.listHeld(), [
    { reason: "test", title: undefined, text: "build finished", urgent: false, expiresAt: state.t + 60 * MINUTE },
  ]);
});

test("a reminder waits while no launcher is listening, then goes out", async () => {
  const { state, say, later } = setup();
  state.noLauncher = true; // backend just started, launcher not reconnected yet
  assert.equal(say("raid in 10 minutes", { explicit: true }), "held");
  assert.equal(later(), null);
  state.noLauncher = false;
  assert.equal(later(), "raid in 10 minutes");
  await tick();
  assert.deepEqual(state.sent, ["raid in 10 minutes"]);
});

test("tray-notifier has listeners only while its broadcaster says someone is connected", () => {
  const trayNotifier = require("../tray-notifier");
  let connected = false;
  trayNotifier.setBroadcaster(() => {}, () => connected);
  assert.equal(trayNotifier.hasListeners(), false);
  connected = true;
  assert.equal(trayNotifier.hasListeners(), true);
  trayNotifier.setBroadcaster(() => {}); // no check given: assume someone is
  assert.equal(trayNotifier.hasListeners(), true);
});

// #1282: quiet hours, "not now", muted kinds, away.
const at = (h, m = 0) => new Date(2026, 8, 29, h, m).getTime();

test("#1282 quiet hours are off by default and hold, not drop, inside the window", async () => {
  const { state, p, say, later } = setup();
  assert.equal(p.getSettings().quietHours.enabled, false);
  state.t = at(2);
  assert.equal(say("night thought", { score: 0.9 }), "delivered"); // off: goes out at 2am
  p.updateSettings({ quietHours: { enabled: true } }); // default 01:00-09:00
  assert.equal(p.getSettings().inQuietHours, true);
  assert.equal(say("morning thought", { score: 0.9, ttlMs: DAY }), "held");
  assert.equal(say("raid now", { explicit: true }), "held"); // only spacing holds it
  assert.equal(later(), "raid now"); // reminders I set still arrive
  assert.equal(later(), null);
  state.t = at(9);
  assert.equal(later(), "morning thought");
  await tick();
  assert.deepEqual(state.sent, ["night thought", "raid now", "morning thought"]);
});

test("#1282 a quiet-hours window can cross midnight; held remarks still expire", () => {
  const { state, p, say, later } = setup();
  p.updateSettings({ quietHours: { enabled: true, start: "23:00", end: "7:30" } });
  assert.equal(p.getSettings().quietHours.end, "07:30");
  state.t = at(23, 30);
  assert.equal(p.getSettings().inQuietHours, true);
  assert.equal(say("stale soon", { score: 0.9 }), "held"); // 1 h TTL
  state.t = at(12);
  assert.equal(p.getSettings().inQuietHours, false);
  state.t = new Date(2026, 8, 30, 7, 30).getTime();
  assert.equal(later(), null); // expired overnight, not delivered late
});

test("#1282 \"not now\" snoozes for 60 minutes by default; 0 resumes", async () => {
  const { state, p, say, later } = setup();
  const s = p.updateSettings({ snoozeMinutes: null });
  assert.equal(s.snoozedUntil, state.t + 60 * MINUTE);
  assert.equal(say("a", { score: 0.9, ttlMs: DAY }), "held");
  assert.equal(later(), null);
  state.t += 60 * MINUTE;
  assert.equal(later(), "a");
  p.updateSettings({ snoozeMinutes: 10 });
  // #697: another kind -- "test" was just told "not now" and now waits longer.
  assert.equal(say("b", { score: 0.9, reason: "other" }), "held");
  p.updateSettings({ snoozeMinutes: 0 });
  assert.equal(p.getSettings().snoozedUntil, null);
  assert.equal(later(), "b");
  await tick();
  assert.deepEqual(state.sent, ["a", "b"]);
});

test("#1282 a muted kind is dropped, waiting ones too, until unmuted; explicit ones aren't muted", async () => {
  const { state, p, later } = setup();
  const offer = (reason, text, extra = {}) => p.offer({ reason, payload: { text }, score: 0.9, ...extra });
  assert.equal(offer("briefing", "first"), "delivered");
  assert.equal(p.getSettings().lastRemark.reason, "briefing");
  assert.equal(offer("briefing", "waiting"), "held");
  assert.equal(offer("check-in", "how are you"), "held");
  assert.deepEqual(p.updateSettings({ mute: "briefing" }).muted, ["briefing"]);
  assert.deepEqual(p.listHeld().map((c) => c.text), ["how are you"]);
  assert.equal(offer("briefing", "again"), "dropped");
  assert.equal(offer("briefing", "you asked", { explicit: true }), "held");
  assert.equal(later(), "you asked");
  assert.equal(later(), "how are you");
  assert.deepEqual(p.updateSettings({ unmute: "briefing" }).muted, []);
  state.t += MINUTE;
  assert.equal(offer("briefing", "back"), "delivered");
  await tick();
  assert.deepEqual(state.sent, ["first", "you asked", "how are you", "back"]);
});

test("#1282 remarks wait while I'm away and go out when I'm back", () => {
  const { state, p, say, later } = setup();
  state.away = true;
  assert.equal(p.getSettings().away, true);
  assert.equal(say("build finished", { score: 0.9 }), "held");
  assert.equal(say("raid", { explicit: true }), "delivered"); // reminders I set still arrive
  assert.equal(later(), null);
  state.away = false;
  assert.equal(later(), "build finished");
});

test("#1282 bad settings are refused without changing anything; settings survive a restart", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proactive-")), "proactive-held.json");
  try {
    const before = setup();
    before.p.persistTo(file);
    assert.throws(() => before.p.updateSettings({ mute: "x", quietHours: { start: "25:00" } }), /HH:MM/);
    assert.throws(() => before.p.updateSettings({ snoozeMinutes: -5 }), /snoozeMinutes/);
    assert.throws(() => before.p.updateSettings({ mute: "" }), /kind/);
    assert.deepEqual(before.p.getSettings().muted, []);
    before.p.updateSettings({ mute: "dream-insight", snoozeMinutes: 30, quietHours: { enabled: true, start: "22:00" } });

    const after = setup();
    after.state.t = before.state.t;
    after.p.persistTo(file);
    const s = after.p.getSettings();
    assert.deepEqual(s.muted, ["dream-insight"]);
    assert.deepEqual(s.quietHours, { enabled: true, start: "22:00", end: "09:00" });
    assert.equal(s.snoozedUntil, before.state.t + 30 * MINUTE);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("#1282 GET/POST /proactive/settings for Settings and the launcher", async () => {
  const express = require("express");
  const { registerRoutes } = require("../proactive");
  const { p } = setup();
  const app = express();
  app.use(express.json());
  registerRoutes(app, p);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/proactive/settings`;
    const post = (body) => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await (await fetch(base)).json()).quietHours.enabled, false);
    const ok = await (await post({ mute: "check-in", quietHours: { enabled: true } })).json();
    assert.deepEqual([ok.ok, ok.muted, ok.quietHours.enabled], [true, ["check-in"], true]);
    const bad = await post({ snoozeMinutes: "soon" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /snoozeMinutes/);
  } finally {
    server.close();
  }
});

test("#1282 the chat tool snoozes, mutes and sets quiet hours", async () => {
  const { createProactiveToolSource } = require("../ai/proactive-tool-source");
  const { state, p } = setup();
  const tools = createProactiveToolSource({ proactive: p });
  assert.equal(tools.isKnownToolName("proactive__settings"), true);
  assert.equal(tools.listToolSchemas()[0].function.name, "proactive__settings");
  const run = async (args) => JSON.parse(await tools.executeTool("proactive__settings", args));
  assert.equal((await run({})).snoozedUntil, null); // just reports
  assert.equal((await run({ snooze_minutes: 60 })).snoozedUntil, state.t + 60 * MINUTE);
  assert.deepEqual((await run({ mute: "briefing" })).muted, ["briefing"]);
  const s = await run({ quiet_hours_enabled: true, quiet_start: "00:30", unmute: "briefing" });
  assert.deepEqual([s.quietHours, s.muted], [{ enabled: true, start: "00:30", end: "09:00" }, []]);
  await assert.rejects(tools.executeTool("proactive__settings", { quiet_end: "nope" }), /HH:MM/);
});

// Learning from reactions: deliver a remark of `reason`, react (or not),
// then let the reply window pass so it settles.
let n = 0;
// A long gap keeps many cycles under the daily budget and past any cooldown.
const LONG = 6 * 60 * MINUTE;
function cycle({ state, p }, reason, reaction, gap = 10 * MINUTE) {
  state.t += gap;
  assert.equal(p.offer({ reason, payload: { text: `remark ${n++}` }, score: 1 }), "delivered");
  if (reaction) p.react(reaction);
  state.t += 6 * MINUTE;
  p.flush();
}
const scoreOf = (p, reason) => p.getSettings().learned[reason]?.score;

test("#697 replying soon after a remark makes that kind welcome: a lower bar, down to 0.5x", () => {
  const s = setup();
  for (let i = 0; i < 5; i++) cycle(s, "news", "engaged");
  const { score, multiplier } = s.p.getSettings().learned.news;
  assert.ok(score > 0.7 && multiplier < 0.65, `score ${score}, multiplier ${multiplier}`);
  s.state.t += 10 * MINUTE;
  assert.equal(s.p.offer({ reason: "news", payload: { text: "small" }, score: 0.3 }), "delivered");
  assert.equal(s.p.offer({ reason: "other", payload: { text: "small" }, score: 0.3 }), "dropped");
  for (let i = 0; i < 20; i++) cycle(s, "news", "engaged", LONG);
  assert.ok(s.p.getSettings().learned.news.multiplier >= 0.5);
});

test("#697 silence counts half as much as a dismissal; a reply after the window doesn't count", () => {
  const s = setup();
  cycle(s, "ignored", null);
  assert.equal(scoreOf(s.p, "ignored"), -0.125);
  cycle(s, "dismissed", "dismissed");
  assert.equal(scoreOf(s.p, "dismissed"), -0.25);
  assert.equal(s.p.react("engaged"), false); // window already passed: nothing to react to
  assert.equal(scoreOf(s.p, "dismissed"), -0.25);
});

test("#697 'not now' beats a reply in the same window and counts against the last remark's kind", () => {
  const s = setup();
  s.state.t += MINUTE;
  s.p.offer({ reason: "check-in", payload: { text: "how's it going" }, score: 0.9 });
  s.p.react("engaged"); // the "not now" message itself is a reply
  s.p.updateSettings({ snoozeMinutes: null }); // the default hour
  assert.equal(scoreOf(s.p, "check-in"), -0.25);
  s.state.t += 6 * MINUTE;
  s.p.flush();
  assert.equal(scoreOf(s.p, "check-in"), -0.25); // not counted twice
});

test("#697 a disliked kind needs a higher bar and waits longer; bounded at 2x and an hour", async () => {
  const s = setup();
  for (let i = 0; i < 4; i++) cycle(s, "trivia", "dismissed", LONG);
  const { multiplier } = s.p.getSettings().learned.trivia;
  assert.ok(multiplier > 1.5 && multiplier <= 2, `multiplier ${multiplier}`);
  s.state.t += MINUTE;
  assert.equal(s.p.offer({ reason: "trivia", payload: { text: "meh" }, score: 0.7 }), "dropped"); // 0.7 < 0.5 * 1.6
  assert.equal(s.p.offer({ reason: "trivia", payload: { text: "fact" }, score: 0.9 }), "held"); // cooling down
  assert.equal(s.p.offer({ reason: "weather", payload: { text: "rain" }, score: 0.9 }), "delivered"); // others aren't
  s.state.t += 20 * MINUTE;
  assert.equal(s.p.flush(), null); // 27 of ~35 minutes
  s.state.t += 15 * MINUTE;
  assert.equal(s.p.flush()?.payload.text, "fact");
  for (let i = 0; i < 20; i++) cycle(s, "trivia", "dismissed", LONG);
  assert.equal(s.p.getSettings().learned.trivia.multiplier <= 2, true);
  s.state.t += 61 * MINUTE;
  assert.equal(s.p.offer({ reason: "trivia", payload: { text: "still allowed" }, score: 1 }), "delivered");
});

test("#697 reminders and urgent remarks are never throttled or learned from", () => {
  const s = setup();
  for (let i = 0; i < 6; i++) cycle(s, "reminder", "dismissed", LONG);
  const before = scoreOf(s.p, "reminder");
  s.state.t += MINUTE;
  assert.equal(s.p.offer({ reason: "reminder", payload: { text: "raid" }, score: 0.1, explicit: true }), "delivered");
  assert.equal(s.p.react("dismissed"), false);
  assert.equal(scoreOf(s.p, "reminder"), before);
});

test("#697 muting is a 'never' for that kind, and a well-liked kind still stays muted", () => {
  const s = setup();
  for (let i = 0; i < 5; i++) cycle(s, "briefing", "engaged");
  const liked = scoreOf(s.p, "briefing");
  s.state.t += 10 * MINUTE;
  s.p.offer({ reason: "briefing", payload: { text: "morning" }, score: 0.9 });
  s.p.updateSettings({ mute: "briefing" });
  assert.ok(scoreOf(s.p, "briefing") < liked);
  s.state.t += 10 * MINUTE;
  assert.equal(s.p.offer({ reason: "briefing", payload: { text: "again" }, score: 1 }), "dropped");
});

test("#697 learned scores fade toward neutral with a two-week half-life", () => {
  const s = setup();
  cycle(s, "news", "dismissed");
  assert.equal(scoreOf(s.p, "news"), -0.25);
  s.state.t += 14 * DAY;
  assert.equal(scoreOf(s.p, "news"), -0.125);
});

test("#697 learned scores survive a restart and show read-only in GET; POST takes a toast reaction", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proactive-")), "proactive-held.json");
  const express = require("express");
  const { registerRoutes } = require("../proactive");
  let server;
  try {
    const before = setup();
    before.p.persistTo(file);
    cycle(before, "news", "engaged");
    const after = setup();
    after.state.t = before.state.t;
    after.p.persistTo(file);
    assert.equal(scoreOf(after.p, "news"), 0.25);

    after.state.t += 10 * MINUTE;
    after.p.offer({ reason: "news", payload: { text: "fresh" }, score: 0.9 });
    const app = express();
    app.use(express.json());
    registerRoutes(app, after.p);
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/proactive/settings`;
    const post = (body) => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ reaction: "never" })).status, 400);
    assert.equal((await post({ learned: { news: { score: 1 } } })).status, 200); // read-only: ignored
    const got = await (await post({ reaction: "dismissed" })).json();
    assert.ok(got.learned.news.score < 0 && got.learned.news.multiplier > 1, JSON.stringify(got.learned));
    assert.deepEqual((await (await fetch(base)).json()).learned.news, got.learned.news);
  } finally {
    server?.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("#697 resetReason and resetAllLearned clear learned scores", () => {
  const s = setup();
  s.p.updateSettings({ mute: "news" });
  cycle(s, "trivia", "dismissed");
  cycle(s, "weather", "engaged");
  assert.ok(s.p.getSettings().learned.trivia);
  assert.ok(s.p.getSettings().learned.weather);

  s.p.updateSettings({ resetReason: "trivia" });
  assert.equal(s.p.getSettings().learned.trivia, undefined);
  assert.ok(s.p.getSettings().learned.weather);

  s.p.updateSettings({ resetAllLearned: true });
  assert.deepEqual(s.p.getSettings().learned, {});
});


// A reminder held while no launcher listens is said as late once it's past
// its grace (lateIn); on time, it stays a plain reminder. The grace never reaches
// the launcher.
test("a held reminder is judged late when it's said, not when it fired", async () => {
  const sent = [];
  let t = new Date(2026, 8, 29, 12, 0).getTime();
  let listening = false;
  const p = createProactive({ deliver: (payload) => sent.push(payload), canDeliver: () => listening, now: () => t });
  const remind = (text) => p.offer({ reason: "reminder", explicit: true, payload: { text, kind: "reminder", lateIn: 5 * MINUTE } });
  assert.equal(remind("stretch"), "held");
  t += 20 * MINUTE;
  listening = true;
  p.flush();
  await tick();
  assert.deepEqual(sent, [{ text: "stretch", kind: "reminder-late" }]);
  t += 10 * MINUTE;
  assert.equal(remind("drink water"), "delivered");
  await tick();
  assert.deepEqual(sent[1], { text: "drink water", kind: "reminder" });
});
