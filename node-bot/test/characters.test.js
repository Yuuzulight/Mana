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
  });
});
