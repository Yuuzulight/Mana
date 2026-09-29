// Issue #698: standing intents ("when X comes up, mention Y") -- facts with
// a trigger, saved only on the user's yes, fired by meaning once per
// cooldown, never when paused or expired.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAcpMemoryStore, factRecallCandidates } = require("../acp-memory-store");
const { createMemoryToolSource } = require("../ai/memory-tool-source");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-standing-intents-"));
}

// Fake embedder: anything about the user's raid group points one way,
// everything else the other.
const RAID = /static|raid group|party finder|raid night/i;
async function fakeEmbeddings(texts) {
  return texts.map((t) => (RAID.test(t) && !/electricity/i.test(t) ? [1, 0] : [0, 1]));
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function reminderLines(entries) {
  const entry = entries.find((e) => e.content.startsWith("Standing reminders"));
  return entry ? entry.content.split("\n").filter((l) => l.startsWith("- ")) : [];
}

function storeAt(clock) {
  return createAcpMemoryStore({
    dataDir: createTempDir(),
    computeEmbeddingsFn: fakeEmbeddings,
    now: () => new Date(clock.ms).toISOString(),
  });
}

function saveRaidIntent(store, extra = {}) {
  return store.rememberFact({
    key: "raid reminder",
    text: "raid is Thursday 9pm",
    trigger: "my FFXIV static",
    origin: { kind: "user_stated" },
    ...extra,
  });
}

test("an intent never surfaces as a plain fact, and matches only on its trigger", () => {
  const facts = [
    { id: "i", key: "raid reminder", text: "raid is Thursday 9pm", trigger: "my FFXIV static", status: "active" },
  ];
  // Mentioning the reminder's own text is not its trigger.
  const onText = factRecallCandidates(facts, "raid reminder: is raid Thursday?");
  assert.deepEqual(onText.candidates, []);
  assert.deepEqual(onText.intents, []);
  // Paraphrase by meaning (similarity), then the trigger's own words.
  assert.equal(factRecallCandidates(facts, "party finder tonight?", new Map([["i", 0.9]])).intents.length, 1);
  assert.equal(factRecallCandidates(facts, "my ffxiv static wiped again").intents.length, 1);
  // A short trigger matches as a whole word only.
  const gpu = [{ key: "budget", text: "budget is $800", trigger: "GPU", status: "active" }];
  assert.equal(factRecallCandidates(gpu, "should I buy a new GPU?").intents.length, 1);
  assert.equal(factRecallCandidates(gpu, "gpus are pricey").intents.length, 0);
  // A pending (unconfirmed) intent never fires.
  assert.deepEqual(factRecallCandidates([{ ...facts[0], status: "pending" }], "my ffxiv static").intents, []);
});

test("a matching message fires the reminder by meaning, once per cooldown; negatives don't", async () => {
  const clock = { ms: Date.parse("2026-09-29T12:00:00Z") };
  const store = storeAt(clock);
  saveRaidIntent(store);

  // First turn only backfills the trigger's vector.
  await store.getRelatedFactsEntries("hello");
  await tick();

  // Negatives: unrelated, and "static" in another sense.
  for (const text of ["what should I cook tonight?", "static electricity keeps shocking me"]) {
    assert.deepEqual(reminderLines((await store.getRelatedFactsEntries(text)).entries), [], text);
  }

  const fired = await store.getRelatedFactsEntries("is my raid group doing party finder tonight?");
  assert.deepEqual(reminderLines(fired.entries), ["- when my FFXIV static comes up: raid is Thursday 9pm"]);
  assert.equal(fired.recall.intents, 1);

  // Within the 12 h cooldown: silent. After it: fires again.
  clock.ms += 11 * 60 * 60 * 1000;
  assert.deepEqual(reminderLines((await store.getRelatedFactsEntries("raid night with the static")).entries), []);
  clock.ms += 2 * 60 * 60 * 1000;
  assert.equal(reminderLines((await store.getRelatedFactsEntries("raid night with the static")).entries).length, 1);
});

test("paused and expired intents never fire", async () => {
  const clock = { ms: Date.parse("2026-09-29T12:00:00Z") };
  const store = storeAt(clock);
  saveRaidIntent(store, { expiresAt: "2026-09-30T23:59:59.000Z" });
  const message = "my FFXIV static is recruiting";

  assert.equal(store.setFactPaused("raid reminder", true).found, true);
  assert.deepEqual(reminderLines((await store.getRelatedFactsEntries(message)).entries), []);
  store.setFactPaused("raid reminder", false);
  assert.equal(reminderLines((await store.getRelatedFactsEntries(message)).entries).length, 1);

  clock.ms = Date.parse("2026-10-01T06:00:00Z");
  assert.deepEqual(reminderLines((await store.getRelatedFactsEntries(message)).entries), []);
});

test("the memory tool saves a standing reminder only on the user's yes, never from a tool-derived turn", async () => {
  const store = createAcpMemoryStore({ dataDir: createTempDir() });
  const args = { key: "raid reminder", text: "raid is Thursday 9pm", trigger: "my FFXIV static", expires: "2026-10-31" };
  const call = async (userMessage, turnTools = []) =>
    JSON.parse(
      await createMemoryToolSource({ acpMemoryStore: store, userMessage, turnTools }).executeTool(
        "memory__remember",
        args,
      ),
    );

  const asked = await call("when I talk about my static remind me raid is Thursday 9pm");
  assert.equal(asked.ok, false);
  assert.match(asked.error, /Keep it\?/);
  assert.equal(store.listFacts().length, 0);

  const fromPage = await call("yes", ["browser__open"]);
  assert.equal(fromPage.ok, false);
  assert.equal(store.listFacts().length, 0);

  const saved = await call("yes, keep it");
  assert.equal(saved.ok, true);
  const [fact] = store.listFacts();
  assert.equal(fact.status, "active");
  assert.equal(fact.trigger, "my FFXIV static");
  assert.equal(fact.unverifiedSource, undefined);
  assert.equal(new Date(fact.expiresAt).getDate(), 31);

  const badDate = await createMemoryToolSource({ acpMemoryStore: store, userMessage: "yes" }).executeTool(
    "memory__remember",
    { ...args, expires: "end of the month" },
  );
  assert.match(JSON.parse(badDate).error, /expires must be a date/);
});
