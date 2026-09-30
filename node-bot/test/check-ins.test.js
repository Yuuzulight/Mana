// Part of #700: gentle check-ins and healthy boundaries.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAcpMemoryStore } = require("../acp-memory-store");
const { createCheckIns, gentleHint, GENTLE_HINT } = require("../check-ins");
const { moodPromptBlock } = require("../mood-store");
const { MANA_PERSONA } = require("../persona");
const { checkEmotionalReflexes } = require("../server");

const HOUR = 3600000;
// Local time, so the 1am-9am quiet window means the same thing everywhere.
const at = (hour, minute = 0, day = 5) => new Date(2026, 0, day, hour, minute).getTime();
const iso = (ms) => new Date(ms).toISOString();

function realStore() {
  let clock = at(20);
  const store = createAcpMemoryStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-check-ins-")),
    now: () => iso(clock),
  });
  const say = async (user, minutes = 2) => {
    clock += minutes * 60000;
    await store.appendTurn({ sessionId: "s1", user, assistant: "mm" });
  };
  return { store, say, clock: () => clock };
}

test("a couple of gamer grumbles never count as low; three negative turns in a row do", async () => {
  const { store, say, clock } = realStore();
  await say("ugh, this boss again");
  await say("seriously, it one-shot me");
  assert.equal(store.getUserAffectState(iso(clock())).lowTurns, 0);
  assert.equal(gentleHint(store.getUserAffectState(iso(clock())), "casual"), null);

  await say("ugh, I'm so annoyed today");
  assert.equal(store.getUserAffectState(iso(clock())).lowTurns, 1);
  await say("what time is it");
  await say("whatever");
  assert.equal(store.getUserAffectState(iso(clock())).lowTurns, 3, "neutral turns keep the run going");
  assert.equal(gentleHint(store.getUserAffectState(iso(clock())), "casual"), GENTLE_HINT);
  assert.equal(gentleHint(store.getUserAffectState(iso(clock())), "coding"), null);
  assert.equal(gentleHint(store.getUserAffectState(iso(clock())), "developer"), null);

  await say("haha nice, that's great");
  assert.equal(store.getUserAffectState(iso(clock())).lowTurns, 0, "an upbeat turn ends the run");
});

test("the low read decays away, and recordCheckIn survives later turns", async () => {
  const { store, say, clock } = realStore();
  for (const line of ["ugh", "so annoyed", "ugh seriously", "hm", "ok then"]) await say(line);
  assert.ok(store.getUserAffectState(iso(clock())).lowTurns >= 3);
  assert.equal(store.getUserAffectState(iso(clock() + 12 * HOUR)).lowTurns, 0);

  store.recordCheckIn(iso(clock()));
  await say("ok");
  assert.equal(store.getUserAffectState(iso(clock())).lastCheckInAt, iso(clock() - 2 * 60000));
});

function fakeStore(state) {
  const store = {
    state: { lowTurns: 3, lastCheckInAt: null, ...state },
    getUserAffectState: () => store.state,
    recordCheckIn: (when) => {
      store.state = { ...store.state, lastCheckInAt: when };
    },
  };
  return store;
}

function checkIns({ state, gaming = false, env = {}, time }) {
  const offers = [];
  const store = fakeStore(state);
  let t = time;
  const engine = createCheckIns({
    store,
    offer: (candidate) => {
      offers.push(candidate);
      return "delivered";
    },
    isGaming: () => gaming,
    env,
    now: () => t,
  });
  return { engine, offers, store, setTime: (ms) => (t = ms) };
}

test("she checks in once, after the chat has gone quiet, through the proactive engine", () => {
  const { engine, offers, setTime } = checkIns({ state: { lastTurnAt: iso(at(20)) }, time: at(20, 10) });
  assert.equal(engine.maybeCheckIn(), null, "not mid-conversation");
  setTime(at(20, 40));
  assert.equal(engine.maybeCheckIn(), "delivered");
  assert.equal(offers.length, 1);
  assert.equal(offers[0].reason, "check-in");
  assert.ok(!offers[0].urgent, "goes through the daily budget and the gaming hold");
  assert.doesNotMatch(offers[0].payload.text, /why|miss/i, "never asks why or guilt-trips");
  assert.equal(offers[0].payload.speak, offers[0].payload.text, "a toast she also says");
  assert.equal(offers[0].payload.kind, "check-in", "the launcher's calm announcement kind");
  setTime(at(22));
  assert.equal(engine.maybeCheckIn(), null, "once a day");
});

test("at most once per low stretch, even across midnight", () => {
  const { engine, offers, setTime } = checkIns({ state: { lastTurnAt: iso(at(23)) }, time: at(23, 45) });
  assert.equal(engine.maybeCheckIn(), "delivered");
  setTime(at(0, 30, 6));
  assert.equal(engine.maybeCheckIn(), null);
  assert.equal(offers.length, 1);
});

test("a new low stretch on a later day can get its own check-in", () => {
  const { engine, store, setTime } = checkIns({ state: { lastTurnAt: iso(at(20)) }, time: at(21) });
  assert.equal(engine.maybeCheckIn(), "delivered");
  store.state = { ...store.state, lastTurnAt: iso(at(20, 0, 6)) };
  setTime(at(21, 0, 6));
  assert.equal(engine.maybeCheckIn(), "delivered");
});

test("no check-in while I'm not low, gaming, in quiet time, or opted out", () => {
  const quiet = { lastTurnAt: iso(at(20)) };
  assert.equal(checkIns({ state: { ...quiet, lowTurns: 2 }, time: at(21) }).engine.maybeCheckIn(), null);
  assert.equal(checkIns({ state: quiet, gaming: true, time: at(21) }).engine.maybeCheckIn(), null);
  assert.equal(checkIns({ state: { lastTurnAt: iso(at(0)) }, time: at(3) }).engine.maybeCheckIn(), null);
  assert.equal(checkIns({ state: quiet, env: { MANA_CHECK_INS: "0" }, time: at(21) }).engine.maybeCheckIn(), null);
  assert.equal(checkIns({ state: quiet, env: { MANA_LAUNCHER_CHECK_INS: "0" }, time: at(21) }).engine.maybeCheckIn(), null);
  assert.equal(checkIns({ state: { lowTurns: 0, lastTurnAt: null }, time: at(21) }).engine.maybeCheckIn(), null);
});

test("missing me is mentioned lightly and once, never as guilt or prying", async () => {
  const block = moodPromptBlock({ energy: 0.5, sociability: 0.9, stress: 0.3, frozen: false }, "casual");
  for (const text of [block, MANA_PERSONA]) {
    assert.match(text, /once/);
    assert.match(text, /never guilt-trip/);
    assert.match(text, /never ask why/);
    assert.match(text, /other plans/);
  }
  const calls = [];
  await checkEmotionalReflexes({
    listSessions: () => [{ updatedAt: new Date(Date.now() - 50 * HOUR).toISOString() }],
    rememberFact: async (fact) => calls.push(fact),
  });
  assert.match(calls[0].text, /only once: no guilt-tripping, no asking why/);
});
