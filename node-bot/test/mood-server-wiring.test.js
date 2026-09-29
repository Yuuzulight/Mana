// Issue #700: mood reaches replies as tone guidance only. The hard limit --
// mood never changes whether or how well she helps -- is asserted here:
// the token budget, tool list and system prompt are identical whatever her
// mood, and coding replies get no mood at all.
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-mood-wiring-"));

const { createApp } = require("../server");
const { createMoodStore } = require("../mood-store");
const { moodCapability } = require("../capabilities/mood-capability");
const { withServer } = require("./helpers");

const AFTERNOON = new Date(2026, 8, 29, 14).getTime();

function frazzledStore() {
  const store = createMoodStore({ now: () => AFTERNOON });
  for (let i = 0; i < 30; i++) store.record("turn");
  for (let i = 0; i < 6; i++) store.record("task_failed");
  return store;
}

function frozenStore() {
  const store = createMoodStore({ now: () => AFTERNOON });
  store.setFrozen(true);
  return store;
}

async function firstModelCall(moodStore, mode) {
  const calls = [];
  const app = createApp({
    moodStore,
    llamaServerRuntime: { isEnabled: () => true },
    runToolAwareReply: async (prompt, policy, opts) => {
      calls.push({ tools: JSON.stringify(policy.tools), opts });
      return { content: "reply", toolCalls: [], rounds: 1 };
    },
  });
  await app.locals.buildAssistantReply("hey, how are you?", "", "", "default", `sess-mood-${mode}`, mode, null, {});
  const [call] = calls;
  const late = call.opts.extraMessages.late.map((m) => m.content).join("\n");
  return { ...call, late };
}

test("a tired, stressed Mana gets tone guidance -- and the same budget, tools and system prompt", async () => {
  const moody = await firstModelCall(frazzledStore(), "casual");
  const neutral = await firstModelCall(frozenStore(), "casual");

  assert.match(moody.late, /Your mood right now/);
  assert.match(moody.late, /shorter and a little sleepy/);
  assert.match(moody.late, /frazzled/);
  assert.doesNotMatch(neutral.late, /Your mood right now/, "frozen mood is steady neutral Mana");

  assert.equal(moody.opts.maxTokens, neutral.opts.maxTokens);
  assert.equal(moody.tools, neutral.tools);
  assert.equal(moody.opts.overrideSystemPrompt, neutral.opts.overrideSystemPrompt);
});

test("coding replies ignore mood entirely", async () => {
  const coding = await firstModelCall(frazzledStore(), "coding");
  assert.doesNotMatch(coding.late, /Your mood right now/);
});

test("each reply counts as a chat turn", async () => {
  const store = createMoodStore({ now: () => AFTERNOON });
  await firstModelCall(store, "casual");
  assert.deepEqual(store.get().history.map((h) => h.event), ["turn"]);
});

test("GET /mood, reset and freeze (a boolean, no value sliders)", async () => {
  const app = express();
  app.use(express.json());
  const moodStore = frazzledStore();
  moodCapability.registerRoutes(app, { moodStore });

  await withServer(app, async (baseUrl) => {
    const post = (route, body) =>
      fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
    const mood = await (await fetch(`${baseUrl}/mood`)).json();
    assert.match(mood.summary, /tired/);

    assert.equal((await post("/mood/freeze", { frozen: "yes" })).status, 400);
    assert.equal((await (await post("/mood/freeze", { frozen: true })).json()).frozen, true);

    const reset = await (await post("/mood/reset")).json();
    assert.equal(reset.frozen, false);
    assert.deepEqual(reset.history.map((h) => h.event), ["reset"]);
  });
});
