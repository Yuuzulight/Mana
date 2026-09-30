// Issue #914: characters are prompts -- profiles, switching from chat or
// the tray, per-character mood/personality, her voice on Qwen3-TTS, and
// remembering who was active across a restart.
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
  defaultPromptOf,
  handoffLine,
  perCharacter,
  personaOf,
} = require("../characters");
const { createCharactersCapability } = require("../capabilities/characters-capability");
const { DEFAULT_SYSTEM_PROMPT } = require("../persona");
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
  assert.equal(defaultPromptOf(store.get("mana")), DEFAULT_SYSTEM_PROMPT, "Mana's is unchanged");
  assert.match(defaultPromptOf(evil), /^You are Evil Mana[\s\S]*Speak naturally for spoken conversation/);
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

test("the active character survives a restart", () => {
  const filePath = tempFile();
  const activeFilePath = path.join(path.dirname(filePath), "active-character.json");
  createCharacterStore({ filePath, activeFilePath }).setActive("evil-mana");
  assert.equal(createCharacterStore({ filePath, activeFilePath }).active().id, "evil-mana");
  fs.writeFileSync(activeFilePath, JSON.stringify({ id: "gone" }));
  assert.equal(createCharacterStore({ filePath, activeFilePath }).active().id, "mana", "a removed one falls back to Mana");
  fs.writeFileSync(activeFilePath, "{ broken");
  assert.equal(createCharacterStore({ filePath, activeFilePath }).active().id, "mana");
});

test("a tray client that connects is told the active character", async () => {
  delete require.cache[require.resolve("../tray-server")];
  const trayServer = require("../tray-server");
  const WebSocket = require("ws");
  const server = require("node:http").createServer();
  trayServer.registerTrayServer(server, { greeting: () => ({ type: "character", id: "evil-mana" }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/tray`);
    const first = await new Promise((resolve, reject) => {
      socket.on("message", (data) => resolve(JSON.parse(data.toString())));
      socket.on("error", reject);
    });
    socket.close();
    assert.deepEqual(first, { type: "character", id: "evil-mana" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
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
