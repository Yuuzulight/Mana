// Issue #700: Mana's mood -- drift, recovery (incl. time the PC was off),
// event effects, daily caps, freeze/reset/history, persistence, and the
// tone-only prompt guidance.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { DEFAULTS, EVENTS, createMoodStore, moodEmotion, moodPromptBlock } = require("../mood-store");

const HOUR = 3600000;
// Local-time constructor, so time-of-day nudges don't depend on the CI's TZ.
// 14:00 has no nudge.
const AFTERNOON = new Date(2026, 8, 29, 14).getTime();

function clockedStore(options = {}) {
  let ms = options.start || AFTERNOON;
  const store = createMoodStore({ ...options, now: () => ms });
  return { store, advance: (hours) => (ms += hours * HOUR), set: (value) => (ms = value) };
}

test("starts at the defaults with an empty history", () => {
  const { store } = clockedStore();
  const mood = store.get();
  assert.equal(mood.energy, DEFAULTS.energy);
  assert.equal(mood.sociability, DEFAULTS.sociability);
  assert.equal(mood.stress, DEFAULTS.stress);
  assert.equal(mood.frozen, false);
  assert.deepEqual(mood.history, []);
});

test("a long chat drains energy and sates sociability", () => {
  const { store } = clockedStore();
  for (let i = 0; i < 20; i++) store.record("turn");
  const mood = store.get();
  assert.ok(mood.energy < DEFAULTS.energy - 0.3, `energy ${mood.energy}`);
  assert.ok(mood.sociability < DEFAULTS.sociability - 0.3, `sociability ${mood.sociability}`);
});

test("quiet time -- including the PC being off -- recovers energy, eases stress, builds sociability", () => {
  const { store, advance } = clockedStore();
  for (let i = 0; i < 20; i++) store.record("turn");
  for (let i = 0; i < 4; i++) store.record("task_failed");
  const tired = store.get();
  // Nothing runs while the PC is off; the next read just sees 24h passed.
  advance(24);
  const rested = store.get();
  assert.ok(rested.energy > 0.95, `energy ${rested.energy}`);
  assert.ok(rested.stress < tired.stress / 4, `stress ${rested.stress}`);
  assert.ok(rested.sociability > tired.sociability + 0.4, `sociability ${rested.sociability}`);
});

test("errors and rejections raise stress, praise lowers it", () => {
  const { store } = clockedStore();
  store.record("task_failed");
  store.record("approval_rejected");
  const stressed = store.get().stress;
  assert.ok(Math.abs(stressed - (DEFAULTS.stress + 0.18)) < 1e-9);
  store.recordTurn("thank you, that was great");
  const soothed = store.get();
  assert.ok(soothed.stress < stressed);
  // A plain message is a turn, not praise.
  const before = soothed.stress;
  store.recordTurn("what's the weather tomorrow?");
  assert.equal(store.get().stress, before);
});

test("each event has a daily cap, so it can't be farmed -- and it resets the next day", () => {
  const { store, set } = clockedStore();
  for (let i = 0; i < 50; i++) store.record("praise");
  const capped = store.get();
  const expected = Math.max(0, DEFAULTS.stress - 0.1 * EVENTS.praise.dailyCap);
  assert.ok(Math.abs(capped.stress - expected) < 1e-9);
  assert.equal(capped.history.filter((h) => h.event === "praise").length, EVENTS.praise.dailyCap);

  for (let i = 0; i < 20; i++) store.record("approval_rejected");
  const rejectedStress = store.get().stress;
  assert.ok(Math.abs(rejectedStress - (expected + 0.1 * EVENTS.approval_rejected.dailyCap)) < 0.01);

  set(new Date(2026, 8, 30, 14).getTime());
  const beforeNextDay = store.get().stress;
  store.record("approval_rejected");
  assert.ok(store.get().stress > beforeNextDay, "a new day allows the event again");
});

test("no late-night dip (Q32); the morning lifts energy a little, without the stored value changing", () => {
  const day = clockedStore().store.get().energy;
  for (const hour of [23, 2, 5]) {
    assert.equal(clockedStore({ start: new Date(2026, 8, 29, hour, 30).getTime() }).store.get().energy, day, `${hour}:30`);
  }
  const morningStore = clockedStore({ start: new Date(2026, 8, 29, 8, 30).getTime() }).store;
  assert.ok(morningStore.get().energy > day);
  // Only the view is nudged: freezing shows the stored value.
  assert.equal(morningStore.setFrozen(true).energy, DEFAULTS.energy);
});

test("freeze holds values steady through events and time; unfreeze resumes from them", () => {
  const { store, advance } = clockedStore();
  for (let i = 0; i < 10; i++) store.record("turn");
  const held = store.setFrozen(true);
  store.record("task_failed");
  store.recordTurn("thanks!");
  advance(30);
  const during = store.get();
  assert.equal(during.frozen, true);
  assert.equal(during.energy, held.energy);
  assert.equal(during.stress, held.stress);
  assert.equal(during.sociability, held.sociability);

  const resumed = store.setFrozen(false);
  assert.equal(resumed.energy, held.energy, "the frozen stretch doesn't count as rest");
  assert.deepEqual(
    resumed.history.slice(-2).map((h) => h.event),
    ["freeze", "unfreeze"],
  );
});

test("reset returns to the defaults; history explains what changed and why", () => {
  const { store, advance } = clockedStore();
  store.record("task_failed");
  advance(8);
  store.record("approval_rejected");
  const history = store.get().history;
  assert.deepEqual(history.map((h) => h.event), ["task_failed", "rest", "approval_rejected"]);
  assert.equal(history[0].change.stress, 0.08);
  assert.equal(history[1].hours, 8);
  assert.ok(history[1].change.stress < 0);

  const reset = store.reset();
  assert.equal(reset.energy, DEFAULTS.energy);
  assert.equal(reset.stress, DEFAULTS.stress);
  assert.deepEqual(reset.history.map((h) => h.event), ["reset"]);
});

test("persists across restarts, and a corrupt file falls back to the defaults", () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mana-mood-")), "mood-state.json");
  const first = clockedStore({ filePath });
  first.store.record("approval_rejected");
  const saved = first.store.get();
  const second = clockedStore({ filePath });
  assert.equal(second.store.get().stress, saved.stress);

  fs.writeFileSync(filePath, "not json{{", "utf8");
  assert.equal(clockedStore({ filePath }).store.get().stress, DEFAULTS.stress);
});

test("rejects an unknown event", () => {
  assert.throws(() => clockedStore().store.record("tickle"), /unknown mood event/);
});

test("the prompt block reports the real values and shapes tone -- never whether she helps", () => {
  const tired = { energy: 0.2, sociability: 0.9, stress: 0.7, frozen: false };
  const block = moodPromptBlock(tired, "casual");
  assert.match(block, /energy low \(20%\)/);
  assert.match(block, /answer honestly/);
  assert.match(block, /Never say these numbers/);
  assert.match(block, /shorter and a little sleepy/);
  assert.match(block, /chattier and tease/);
  assert.match(block, /never whether you help/);
  assert.equal(moodPromptBlock({ ...tired, frozen: true }, "casual"), null, "frozen is steady neutral Mana");
  assert.equal(moodPromptBlock(tired, "coding"), null);
  assert.equal(moodPromptBlock(tired, "developer"), null);
});

// Part of #700: the emotion tag her mood leans toward (idle face, voice pace).
test("mood leans toward one emotion tag, or none", () => {
  const base = { energy: 0.6, sociability: 0.5, stress: 0.3, frozen: false };
  assert.equal(moodEmotion(base), null);
  assert.equal(moodEmotion({ ...base, energy: 0.2 }), "thinking");
  assert.equal(moodEmotion({ ...base, stress: 0.7, energy: 0.9 }), "thinking", "stress wins over energy");
  assert.equal(moodEmotion({ ...base, energy: 0.9 }), "happy");
  assert.equal(moodEmotion({ ...base, sociability: 0.8 }), "happy");
  assert.equal(moodEmotion({ ...base, energy: 0.2, frozen: true }), null);
  assert.equal(createMoodStore().get().emotion, null, "the defaults don't lean");
});
