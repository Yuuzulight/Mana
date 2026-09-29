// Issue #697: the proactive core -- threshold, daily budget, gaming-break
// gating, spacing and expiry.
const assert = require("node:assert/strict");
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
