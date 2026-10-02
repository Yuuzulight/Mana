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
  assert.equal(say("b", { score: 0.9 }), "held");
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
