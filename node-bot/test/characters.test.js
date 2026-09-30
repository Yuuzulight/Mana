// Issue #914: characters are prompts -- profiles, switching from chat or
// the tray, per-character mood/personality, and her voice on Qwen3-TTS.
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.MANA_ACP_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mana-characters-"));

const {
  characterFilePath,
  createCharacterStore,
  handoffLine,
  perCharacter,
  personaOf,
} = require("../characters");
const { createCharactersCapability } = require("../capabilities/characters-capability");
const { createMoodStore } = require("../mood-store");
const { createTtsRuntime } = require("../tts-runtime");
const { withServer } = require("./helpers");

function tempFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-characters-file-"));
  const filePath = path.join(dir, "characters.json");
  if (content !== undefined) fs.writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content));
  return filePath;
}

test("Mana is the default; Evil Mana is built in and uses Mana's voice and model", () => {
  const store = createCharacterStore({ filePath: tempFile() });
  assert.equal(store.active().id, "mana");
  assert.deepEqual(store.list().map((c) => c.id), ["mana", "evil-mana"]);
  const evil = store.get("evil-mana");
  assert.equal(evil.voice, null);
  assert.equal(evil.live2dModel, null);
  assert.match(personaOf(evil), /^You are Evil Mana/);
  assert.match(personaOf(evil), /may call you Mana; they mean you, Evil Mana/);
  assert.equal(personaOf(store.get("mana")), store.get("mana").persona);
});

test("characters.json adds characters and overrides only the fields it sets", () => {
  const filePath = tempFile([
    { id: "evil-mana", voice: { refAudio: "voices/evil.wav", refText: "Hehe." }, live2dModel: "m/evil.model3.json" },
    { id: "aoi", name: "Aoi", persona: "You are Aoi.", handoff: "Aoi here, after {previous}." },
    { id: "../escape", name: "Bad", persona: "x" },
    { id: "nopersona", name: "Nope" },
    { id: "halfvoice", name: "Half", persona: "You are Half.", voice: { refAudio: "a.wav" } },
  ]);
  const store = createCharacterStore({ filePath });
  assert.deepEqual(store.list().map((c) => c.id), ["mana", "evil-mana", "aoi", "halfvoice"]);
  const evil = store.get("evil-mana");
  assert.match(evil.persona, /^You are Evil Mana/, "the built-in persona is kept");
  assert.deepEqual(evil.voice, { refAudio: path.join(path.dirname(filePath), "voices", "evil.wav"), refText: "Hehe." });
  assert.equal(evil.live2dModel, path.join(path.dirname(filePath), "m", "evil.model3.json"));
  assert.equal(store.get("halfvoice").voice, null, "a clip without its transcript is no voice");
  assert.equal(handoffLine(store.get("aoi"), store.get("evil-mana")), "Aoi here, after Evil Mana.");
});

test("a broken characters.json falls back to the built-ins, and edits are picked up", () => {
  const filePath = tempFile("{ not json");
  const store = createCharacterStore({ filePath });
  assert.deepEqual(store.list().map((c) => c.id), ["mana", "evil-mana"]);
  fs.writeFileSync(filePath, JSON.stringify([{ id: "aoi", name: "Aoi", persona: "You are Aoi." }]));
  const later = Date.now() / 1000 + 5;
  fs.utimesSync(filePath, later, later);
  assert.ok(store.get("aoi"));
});

test("chat switch requests name a character other than the active one", () => {
  const store = createCharacterStore({ filePath: tempFile() });
  const target = (line) => store.findSwitchRequest(line)?.id || null;
  assert.equal(target("let Evil Mana talk"), "evil-mana");
  assert.equal(target("Can I talk to evil mana?"), "evil-mana");
  assert.equal(target("switch to Evil Mana!"), "evil-mana");
  assert.equal(target("let Mana talk"), null, "already talking");
  assert.equal(target("evil mana is a fun idea"), null);
  assert.equal(target(`let Evil Mana talk ${"and more ".repeat(30)}`), null, "too long to be a request");

  const switches = [];
  const onSwitchStore = createCharacterStore({ filePath: tempFile(), onSwitch: (c, p) => switches.push(`${p.id}->${c.id}`) });
  onSwitchStore.setActive("evil-mana");
  assert.equal(onSwitchStore.findSwitchRequest("switch to Mana")?.id, "mana", "not the Mana inside Evil Mana");
  assert.equal(onSwitchStore.findSwitchRequest("bring back Mana")?.id, "mana");
  assert.equal(onSwitchStore.findSwitchRequest("switch to evil mana"), null);
  onSwitchStore.setActive("evil-mana");
  assert.equal(onSwitchStore.setActive("nobody"), null);
  assert.deepEqual(switches, ["mana->evil-mana"], "re-selecting the active one is no switch");
});

test("each character keeps her own mood; files sit beside Mana's", () => {
  const store = createCharacterStore({ filePath: tempFile() });
  const mood = perCharacter(store, () => createMoodStore(), ["get", "record"]);
  for (let i = 0; i < 5; i++) mood.record("task_failed");
  const manaStress = mood.get().stress;
  store.setActive("evil-mana");
  assert.ok(mood.get().stress < manaStress, "Evil Mana isn't stressed by Mana's day");
  store.setActive("mana");
  assert.equal(mood.get().stress, manaStress);

  assert.equal(characterFilePath("/d/mood-state.json", "mana"), "/d/mood-state.json");
  assert.equal(characterFilePath("/d/mood-state.json", "evil-mana"), "/d/mood-state.evil-mana.json");
  assert.equal(characterFilePath(null, "evil-mana"), null);
});

test("routes list and switch; a chat request answers with the handoff line", async () => {
  const store = createCharacterStore({ filePath: tempFile() });
  const capability = createCharactersCapability(store);
  const app = express();
  app.use(express.json());
  capability.registerRoutes(app);

  await withServer(app, async (baseUrl) => {
    const post = (body) =>
      fetch(`${baseUrl}/characters/active`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const listed = await (await fetch(`${baseUrl}/characters`)).json();
    assert.equal(listed.active, "mana");
    assert.deepEqual(listed.characters[1], { id: "evil-mana", name: "Evil Mana", live2dModel: null });

    assert.equal((await post({})).status, 400);
    assert.equal((await post({ id: "nobody" })).status, 404);
    const switched = await (await post({ id: "evil-mana" })).json();
    assert.equal(switched.handoff, "Evil Mana here. Mana is taking a break, so you're stuck with me~");
    assert.equal((await (await post({ id: "evil-mana" })).json()).handoff, null);
  });

  assert.equal(capability.onUserInput({ text: "what's the weather?" }), null);
  assert.deepEqual(capability.onUserInput({ text: "bring back Mana" }), { reply: "Mana's back~ Did you miss me?" });
  assert.equal(store.active().id, "mana");
});

test("group mode: off by default, paused by a game unless turned on during it", () => {
  let gaming = false;
  const reported = [];
  const store = createCharacterStore({
    filePath: tempFile(),
    isGaming: () => gaming,
    onGroupChange: (partner) => reported.push(partner?.id ?? null),
  });
  assert.equal(store.groupPartner(), null);
  assert.equal(store.setGroup(true, "mana"), null, "not the active one");
  assert.equal(store.setGroup(true, "nobody"), null);
  assert.deepEqual(store.setGroup(true), { on: true, partner: "evil-mana", paused: false });

  gaming = true;
  store.gameChanged();
  assert.equal(store.groupPartner(), null, "paused while gaming");
  assert.deepEqual(store.groupState(), { on: true, partner: "evil-mana", paused: true });
  store.setGroup(true);
  assert.equal(store.groupPartner()?.id, "evil-mana", "turned on during the game");
  gaming = false;
  store.gameChanged();
  gaming = true;
  store.gameChanged();
  assert.equal(store.groupPartner(), null, "the next game pauses it again");
  gaming = false;
  store.gameChanged();

  store.setActive("evil-mana");
  assert.equal(store.groupPartner()?.id, "mana", "switching to the partner keeps the duo");
  store.setGroup(false);
  assert.equal(store.groupPartner(), null);
  assert.deepEqual(reported, ["evil-mana", null, "evil-mana", null, "evil-mana", "mana", null]);
});

test("group mode from chat and the route; names are found longest first", async () => {
  const store = createCharacterStore({ filePath: tempFile() });
  assert.deepEqual(store.mentioned("Evil Mana, what do you think?").map((c) => c.id), ["evil-mana"]);
  assert.deepEqual(store.mentioned("Mana and Evil Mana").map((c) => c.id), ["evil-mana", "mana"]);
  assert.deepEqual(store.mentioned("manager's report"), []);
  assert.deepEqual(store.findGroupRequest("turn on group mode"), { on: true, partner: null });
  assert.deepEqual(store.findGroupRequest("start a group chat with Evil Mana"), { on: true, partner: "evil-mana" });
  assert.deepEqual(store.findGroupRequest("let Evil Mana join us"), { on: true, partner: "evil-mana" });
  assert.deepEqual(store.findGroupRequest("group mode off"), { on: false, partner: null });
  assert.equal(store.findGroupRequest("what's a group chat?"), null);
  assert.equal(store.findSwitchRequest("let Evil Mana join"), null, "joining isn't switching");

  const capability = createCharactersCapability(store);
  assert.deepEqual(capability.onUserInput({ text: "let Evil Mana join" }), { reply: "Okay, Evil Mana is joining us~" });
  assert.equal(store.groupPartner()?.id, "evil-mana");
  assert.equal(store.active().id, "mana");
  assert.deepEqual(capability.onUserInput({ text: "stop group mode" }), { reply: "Okay, just me again~" });

  const app = express();
  app.use(express.json());
  capability.registerRoutes(app);
  await withServer(app, async (baseUrl) => {
    const post = (body) =>
      fetch(`${baseUrl}/characters/group`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ on: true, partner: "nobody" })).status, 404);
    assert.deepEqual((await (await post({ on: true, partner: "evil-mana" })).json()).group, {
      on: true,
      partner: "evil-mana",
      paused: false,
    });
    assert.equal((await (await fetch(`${baseUrl}/characters`)).json()).group.on, true);
    assert.equal((await (await post({ on: false })).json()).group.on, false);
  });
});

test("Qwen3-TTS gets the active character's reference clip, or none for the service's own voice", async () => {
  const bodies = [];
  let voice = null;
  const runtime = createTtsRuntime({
    env: { TTS_PROVIDER: "qwen3tts", QWEN3_TTS_URL: "http://qwen.local" },
    getVoice: () => voice,
    postJsonBuffer: async (url, body) => {
      bodies.push(body);
      return Buffer.from("wav");
    },
    nowMs: () => 1,
    logPerf: () => {},
  });
  await runtime.synthesizeReply("Hello there.");
  voice = { refAudio: "C:\\voices\\evil.wav", refText: "Hehe." };
  await runtime.synthesizeReply("Hello there.");
  assert.equal(bodies[0].ref_audio, undefined);
  assert.equal(bodies[1].ref_audio, "C:\\voices\\evil.wav");
  assert.equal(bodies[1].ref_text, "Hehe.");
});

test("the reply's system prompt is the active character's persona", async () => {
  const { createApp } = require("../server");
  const prompts = [];
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true },
    runToolAwareReply: async (prompt, policy, opts) => {
      prompts.push(opts.overrideSystemPrompt);
      return { content: "reply", toolCalls: [], rounds: 1 };
    },
  });
  await withServer(app, async (baseUrl) => {
    const reply = await (
      await fetch(`${baseUrl}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "let Evil Mana talk" }),
      })
    ).json();
    assert.match(reply.reply, /^Evil Mana here\./);
    await app.locals.buildAssistantReply("hi", "", "", "default", "sess-characters", "casual", null, {});
    assert.match(prompts[0], /^You are Evil Mana/);
    assert.doesNotMatch(prompts[0], /You are Mana, an original/);
    // Group mode's speaker-labelled history: the turn says who answered.
    assert.equal(app.locals.acpMemoryStore.getSession("sess-characters").turns.at(-1).speaker, "Evil Mana");
  });
});

test("speakAs stands a character in for the active one, only inside it", async () => {
  const store = createCharacterStore({ filePath: tempFile() });
  const inside = await store.speakAs("evil-mana", async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return store.active().id;
  });
  assert.equal(inside, "evil-mana");
  assert.equal(store.active().id, "mana");
  assert.equal(store.speakAs("nobody", () => store.active().id), "mana");
});

test("group mode: two replies per message, taking turns, the second only for casual chat", async () => {
  const { createApp } = require("../server");
  let next = {};
  let reactionGate = null;
  const reactions = [];
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true },
    buildAssistantReply: async (text, screen, market, profile, sessionId, mode, preset, replyMeta, onSentence) => {
      replyMeta.mode = next.mode || "casual";
      replyMeta.streamedMatchesFinal = !next.rewritten;
      if (next.tool) replyMeta.onToolCall({ name: "web_search", phase: "start" });
      const reply = next.reply || `re: ${text}`;
      onSentence?.(reply);
      return reply;
    },
    buildGroupReaction: async ({ sister, reply }) => {
      reactions.push(`to ${sister.id}: ${reply}`);
      if (reactionGate) await reactionGate;
      return "Hmph, I'd have said it better.";
    },
  });
  await withServer(app, async (baseUrl) => {
    const post = (route, body) =>
      fetch(`${baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const say = async (text, options = {}) => {
      next = options;
      const body = await (await post("/reply/stream", { text, sessionId: "sess-group" })).text();
      return body
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .map((e) => `${e.type}:${e.character}`);
    };
    await post("/characters/active", { id: "mana" });
    assert.deepEqual(await say("hi"), ["sentence:mana", "final:mana"], "group mode is off");
    await post("/characters/group", { on: true, partner: "evil-mana" });
    try {
      assert.deepEqual(await say("hello both"), ["sentence:mana", "final:mana", "sentence:evil-mana", "final:evil-mana"]);
      assert.deepEqual(reactions, ["to mana: re: hello both"]);
      // Evil Mana spoke last, so Mana answers first again; a task turn gets no reaction.
      assert.deepEqual(await say("set a timer", { mode: "everyday" }), ["sentence:mana", "final:mana"]);
      assert.deepEqual(await say("how are you?"), ["sentence:evil-mana", "final:evil-mana", "sentence:mana", "final:mana"]);
      assert.deepEqual((await say("Evil Mana, your turn"))[0], "sentence:evil-mana", "the one I name answers first");
      assert.deepEqual(await say("look it up", { tool: true }), ["tool:undefined", "sentence:evil-mana", "final:evil-mana"], "no reaction after tool use");
      assert.deepEqual((await say("tell me a story", { reply: "x".repeat(400) })).length, 2, "nor after a long reply");
      assert.deepEqual((await say("again?", { rewritten: true })).length, 2, "nor after one the client must speak afresh");

      // I type again while the reaction is being made: it's dropped.
      let open;
      reactionGate = new Promise((resolve) => (open = resolve));
      const pending = say("first");
      while (!reactions.includes("to evil-mana: re: first") && !reactions.includes("to mana: re: first")) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      reactionGate = null;
      await say("second", { mode: "everyday" });
      open();
      assert.equal((await pending).length, 2);
    } finally {
      await post("/characters/group", { on: false });
    }
  });
});

test("/synthesize speaks in the voice of the event's character", async () => {
  const { registerCoreRoutes } = require("../server-routes");
  const store = createCharacterStore({ filePath: tempFile() });
  const app = express();
  app.use(express.json());
  registerCoreRoutes(app, { single: () => (req, res, next) => next() }, {
    TTS_PROVIDER: "qwen3tts",
    characters: store,
    synthesizeReply: async () => Buffer.from(store.active().id),
  });
  await withServer(app, async (baseUrl) => {
    const say = async (body) =>
      (await fetch(`${baseUrl}/synthesize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).text();
    assert.equal(await say({ text: "hi", character: "evil-mana" }), "evil-mana");
    assert.equal(await say({ text: "hi" }), "mana");
  });
});

test("a group reaction is short, in the partner's persona, and saved as her turn", async () => {
  const { createApp } = require("../server");
  const calls = [];
  const app = createApp({
    llamaServerRuntime: { isEnabled: () => true },
    buildAssistantReply: async (text, s, m, p, sessionId, mode, preset, replyMeta, onSentence) => {
      replyMeta.mode = "casual";
      replyMeta.streamedMatchesFinal = true;
      onSentence?.("I'm the smart one.");
      return "I'm the smart one.";
    },
    runLocalAssistantReply: async (prompt, maxTokens, profile, system) => {
      calls.push({ prompt, maxTokens, system });
      return "[happy] Sure you are, sis.";
    },
  });
  await withServer(app, async (baseUrl) => {
    const post = (route, body) =>
      fetch(`${baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await post("/characters/active", { id: "mana" });
    await post("/characters/group", { on: true, partner: "evil-mana" });
    try {
      const events = (await (await post("/reply/stream", { text: "which of you is smarter?", sessionId: "sess-reaction" })).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(events.at(-1), { type: "final", reply: "Sure you are, sis.", ttsConfigured: events.at(-1).ttsConfigured, changed: false, character: "evil-mana", characterName: "Evil Mana" });
      assert.equal(calls[0].maxTokens, 60);
      assert.match(calls[0].system, /^You are Evil Mana/);
      assert.match(calls[0].prompt, /Your sister Mana answered: "I'm the smart one\."/);
      const turn = app.locals.acpMemoryStore.getSession("sess-reaction").turns.at(-1);
      assert.deepEqual([turn.user, turn.assistant, turn.speaker], ["", "Sure you are, sis.", "Evil Mana"]);
    } finally {
      await post("/characters/group", { on: false });
    }
  });
});
