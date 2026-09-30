// Issue #677: plugin onUserInput hooks, end to end through the chat routes.
// Two fixture plugins stand in for real ones: one fixes a known
// mis-transcription ("manner" -> "Mana"), one answers a fixed command
// without the model.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer, useTestAdminToken } = require("./helpers");

// Every route but a few public ones needs an admin key (admin-key.js).
const fetch = useTestAdminToken();

const fixTranscriptPlugin = {
  key: "fix-transcript",
  inputHookPriority: 10,
  onUserInput: ({ text }) => ({
    text: text.replace(/\bmanner\b/gi, "Mana"),
    promptPatch: { system: "Plugin system note.", user: "Plugin user note." },
  }),
};

const clockPlugin = {
  key: "clock",
  onUserInput: ({ text }) =>
    /^what time is it\??$/i.test(text.trim()) ? { reply: "Time to play." } : undefined,
};

function createHookedApp(overrides = {}) {
  const calls = { replies: [], turns: [] };
  const app = createApp({
    capabilities: [clockPlugin, fixTranscriptPlugin],
    recordChatTurn: (...args) => calls.turns.push(args),
    buildAssistantReply: async (transcript, screenText, marketText, ...rest) => {
      const replyMeta = rest[4];
      calls.replies.push({ transcript, marketText, systemPatch: replyMeta?.systemPatch });
      return "model reply";
    },
    normalizeUploadedAudio: (file) => ({ tmpPath: file.path, audioPath: file.path }),
    cleanupUploadedAudio: () => {},
    ...overrides,
  });
  return { app, calls };
}

async function postStream(baseUrl, body) {
  const response = await fetch(`${baseUrl}/reply/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return events[events.length - 1];
}

async function postTranscribe(baseUrl) {
  const form = new FormData();
  form.append("file", new Blob(["fake audio"], { type: "audio/wav" }), "voice.wav");
  form.append("sessionId", "s1");
  const response = await fetch(`${baseUrl}/transcribe`, { method: "POST", body: form });
  return response.json();
}

test("typed turn: a plugin rewrite and its patches reach buildAssistantReply", async () => {
  const { app, calls } = createHookedApp();
  await withServer(app, async (baseUrl) => {
    const final = await postStream(baseUrl, { text: "hey manner", includeContext: false });
    assert.equal(final.reply, "model reply");
  });
  assert.deepEqual(calls.replies, [
    { transcript: "hey Mana", marketText: "Plugin user note.", systemPatch: "Plugin system note." },
  ]);
});

test("typed turn: a short-circuit reply skips the model and is recorded", async () => {
  const { app, calls } = createHookedApp();
  await withServer(app, async (baseUrl) => {
    const final = await postStream(baseUrl, { text: "what time is it", sessionId: "s1" });
    assert.equal(final.type, "final");
    assert.equal(final.reply, "Time to play.");
    assert.equal(final.changed, true);
  });
  assert.equal(calls.replies.length, 0);
  assert.deepEqual(calls.turns, [["s1", "what time is it", "Time to play."]]);
});

test("typed turn: /reply short-circuits too", async () => {
  const { app, calls } = createHookedApp();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "What time is it?" }),
    });
    assert.equal((await response.json()).reply, "Time to play.");
  });
  assert.equal(calls.replies.length, 0);
});

test("voice turn: /transcribe runs the same hooks", async () => {
  let heard = "what time is it";
  const { app, calls } = createHookedApp({ runWhisper: () => heard });
  await withServer(app, async (baseUrl) => {
    const shortCircuited = await postTranscribe(baseUrl);
    assert.equal(shortCircuited.transcript, "what time is it");
    assert.equal(shortCircuited.reply, "Time to play.");

    heard = "hey manner";
    const rewritten = await postTranscribe(baseUrl);
    assert.equal(rewritten.transcript, "hey manner");
    assert.equal(rewritten.reply, "model reply");
  });
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.replies[0].transcript, "hey Mana");
});

test("image turn: the rewritten text is described and reaches the chat path with the patches (#679)", async () => {
  let visionPrompt = null;
  const { app, calls } = createHookedApp({
    getVisionStatus: () => ({ available: true }),
    chatAcceptsImages: () => false,
    runVisionReply: async (prompt) => {
      visionPrompt = prompt;
      return "a cat";
    },
  });
  await withServer(app, async (baseUrl) => {
    const final = await postStream(baseUrl, { text: "manner, look", image: "data:image/png;base64,AAAA" });
    assert.equal(final.reply, "model reply");
  });
  assert.match(visionPrompt, /Their message: Mana, look$/);
  assert.equal(calls.replies[0].transcript, "[Image: a cat]\n\nMana, look");
  assert.match(calls.replies[0].marketText, /Plugin user note\.$/);
  assert.equal(calls.replies[0].systemPatch, "Plugin system note.");
});

test("a plugin system patch lands in the local model's system prompt", async () => {
  let systemPrompt = null;
  const app = createApp({
    capabilities: [fixTranscriptPlugin],
    runLocalAssistantReply: async (prompt, maxTokens, profile, overrideSystemPrompt) => {
      systemPrompt = overrideSystemPrompt;
      return "ok";
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(response.status, 200);
  });
  assert.match(systemPrompt, /Plugin system note\.$/);
});
