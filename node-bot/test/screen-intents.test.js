// #1283 (part of #698): standing intents fire on what's on screen, through
// the proactive engine, once per intent per 30 min; never mid-game or on a
// private window.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAcpMemoryStore } = require("../acp-memory-store");
const { createProactive } = require("../proactive");
const { createScreenIntents, isPrivateWindow } = require("../screen-intents");

const RAID = /static|raid group|party finder|raid night/i;
async function fakeEmbeddings(texts) {
  return texts.map((t) => (RAID.test(t) ? [1, 0] : [0, 1]));
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function setup({ gaming = false } = {}) {
  const clock = { ms: Date.parse("2026-10-02T12:00:00Z") };
  const store = createAcpMemoryStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-screen-intents-")),
    computeEmbeddingsFn: fakeEmbeddings,
    now: () => new Date(clock.ms).toISOString(),
  });
  store.rememberFact({
    key: "raid reminder",
    text: "raid is Thursday 9pm",
    trigger: "my FFXIV static",
    origin: { kind: "user_stated" },
  });
  await store.matchIntents("hello"); // first call only backfills the trigger's vector
  await tick();
  const delivered = [];
  const proactive = createProactive({ deliver: (payload) => delivered.push(payload), now: () => clock.ms });
  let matcherCalls = 0;
  const screen = createScreenIntents({
    matchIntents: (text) => {
      matcherCalls += 1;
      return store.matchIntents(text);
    },
    offer: proactive.offer,
    isGaming: () => gaming,
    now: () => clock.ms,
  });
  return { clock, screen, delivered, matcherCalls: () => matcherCalls };
}

const RAID_SCREEN = { app: "chrome.exe", title: "Party Finder - FFXIV", text: "Raid group recruiting for savage tonight" };

test("a screen matching an intent fires once through the proactive engine, then waits 30 min", async () => {
  const { clock, screen, delivered } = await setup();
  assert.deepEqual(await screen.check({ app: "code.exe", title: "server.js", text: "const app = express()" }), []);

  const fired = await screen.check(RAID_SCREEN);
  assert.deepEqual(fired.map((f) => f.key), ["raid reminder"]);
  await tick();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, "raid is Thursday 9pm");
  assert.equal(delivered[0].kind, "reminder");

  clock.ms += 29 * 60 * 1000;
  assert.deepEqual(await screen.check(RAID_SCREEN), []);
  clock.ms += 2 * 60 * 1000;
  assert.equal((await screen.check(RAID_SCREEN)).length, 1);
  await tick();
  assert.equal(delivered.length, 2);
});

test("gaming suppresses screen intents without even matching", async () => {
  const gamingNow = await setup({ gaming: true });
  assert.deepEqual(await gamingNow.screen.check(RAID_SCREEN), []);
  const glanceFlag = await setup();
  assert.deepEqual(await glanceFlag.screen.check({ ...RAID_SCREEN, gaming: true }), []);
  assert.equal(gamingNow.matcherCalls() + glanceFlag.matcherCalls(), 0);
  await tick();
  assert.equal(gamingNow.delivered.length + glanceFlag.delivered.length, 0);
});

test("a private window never matches", async () => {
  const { screen, delivered, matcherCalls } = await setup();
  assert.deepEqual(await screen.check({ ...RAID_SCREEN, app: "KeePassXC.exe" }), []);
  assert.deepEqual(await screen.check({ ...RAID_SCREEN, title: "Party Finder - FFXIV - InPrivate - Microsoft Edge" }), []);
  assert.deepEqual(await screen.check({ ...RAID_SCREEN, title: "Party Finder - Mozilla Firefox Private Browsing" }), []);
  assert.equal(matcherCalls(), 0);
  await tick();
  assert.equal(delivered.length, 0);
  assert.equal(isPrivateWindow({ app: "chrome.exe", title: "Party Finder" }), false);
});
