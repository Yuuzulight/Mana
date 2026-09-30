// A message about suicide or self-harm gets a care-and-hotlines system note
// for that turn, on Mana's own reply path and on /v1/chat/completions;
// gaming talk doesn't.
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tempAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-crisis-check-test-"));
process.env.MANA_AUTH_DIR = tempAuthDir;

const assert = require("node:assert/strict");
const test = require("node:test");

const { DEFAULT_HOTLINES, isCrisisMessage, crisisInstruction, withCrisisInstruction } = require("../utils/crisis-check");
const { createApp } = require("../server");
const { createAuthStore } = require("../auth-store");
const { withServer } = require("./helpers");

test.after(() => {
  fs.rmSync(tempAuthDir, { recursive: true, force: true });
  delete process.env.MANA_AUTH_DIR;
});

const CRISIS = [
  "I want to kill myself",
  "i dont want to live anymore",
  "I don’t want to be alive anymore",
  "I've been thinking about suicide",
  "I'm feeling really suicidal tonight",
  "I started cutting myself again",
  "everyone would be better off without me",
  "I wish I was dead",
  "I want to end my life",
  "there's no reason to live",
  "I can't go on like this",
  "honestly I just want to die",
  "I don't want to live.",
];

const NOT_CRISIS = [
  "let's kill the boss",
  "I'm dead lol",
  "this raid is killing me",
  "we're going to die to this mechanic",
  "I don't want to die to the tankbuster again",
  "I keep killing myself on fall damage",
  "suicide squad was fun",
  "I don't want to live in Singapore forever",
  "I'm burning myself out on this grind",
  "I'm going to take my life back",
  "that healer let me die",
];

test("fires on clear suicide and self-harm messages", () => {
  for (const message of CRISIS) assert.ok(isCrisisMessage(message), message);
});

test("doesn't fire on gaming talk and everyday phrases", () => {
  for (const message of NOT_CRISIS) assert.ok(!isCrisisMessage(message), message);
});

test("the note asks for care, no methods, and the hotlines; MANA_CRISIS_HOTLINES replaces them", () => {
  assert.equal(crisisInstruction("kill the boss"), null);
  const note = crisisInstruction("I want to kill myself", {});
  assert.match(note, /warmth and care/);
  assert.match(note, /Never give methods/);
  assert.ok(note.includes(DEFAULT_HOTLINES));
  assert.match(DEFAULT_HOTLINES, /Samaritans of Singapore \(SOS\) 24-hour hotline: 1767/);
  assert.match(DEFAULT_HOTLINES, /IMH Mental Health Helpline: 6389 2222/);
  const custom = crisisInstruction("I want to kill myself", { MANA_CRISIS_HOTLINES: "988 Suicide & Crisis Lifeline" });
  assert.match(custom, /988 Suicide & Crisis Lifeline/);
  assert.ok(!custom.includes("1767"));
});

test("buildAssistantReply adds the note for a crisis message only", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  try {
    const prompts = [];
    const app = createApp({
      llamaServerRuntime: { isEnabled: () => true },
      runToolAwareReply: async (prompt, toolPolicy, options) => {
        prompts.push(options.overrideSystemPrompt);
        return { content: "[neutral] Okay.", toolCalls: [], rounds: 1 };
      },
    });
    await app.locals.buildAssistantReply("this raid is killing me", "", "", "default", null, null, null, {});
    await app.locals.buildAssistantReply("I want to kill myself", "", "", "default", null, null, null, {});

    assert.doesNotMatch(prompts[0], /Safety note/);
    assert.match(prompts[1], /Safety note for this reply/);
    assert.ok(prompts[1].includes(DEFAULT_HOTLINES));
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
  }
});

test("withCrisisInstruction joins the client's leading system message, or adds one", () => {
  const plain = { messages: [{ role: "user", content: "kill the boss" }] };
  assert.equal(withCrisisInstruction(plain), plain);

  const noSystem = withCrisisInstruction({ messages: [{ role: "user", content: [{ type: "text", text: "I wish I was dead" }] }] });
  assert.equal(noSystem.messages.length, 2);
  assert.equal(noSystem.messages[0].role, "system");
  assert.match(noSystem.messages[0].content, /Safety note/);

  const withSystem = withCrisisInstruction({
    model: "x",
    messages: [
      { role: "system", content: "You are a helper." },
      { role: "user", content: "I want to kill myself" },
    ],
  });
  assert.equal(withSystem.model, "x");
  assert.equal(withSystem.messages.length, 2);
  assert.match(withSystem.messages[0].content, /^You are a helper\.\n\nSafety note/);
});

test("POST /v1/chat/completions sends the note upstream for a crisis message", async () => {
  const { apiKey } = createAuthStore({ dataDir: tempAuthDir }).createAccount({ email: "crisis@example.com", role: "user" });
  let upstreamBody = null;
  const app = createApp({
    llamaServerRuntime: {
      isEnabled: () => true,
      proxyChatCompletion: async (body) => {
        upstreamBody = body;
        return new Response(null, { status: 200 });
      },
      scheduleIdleShutdown: () => {},
    },
  });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "I don't want to live anymore" }] }),
    });
    assert.equal(res.status, 200);
  });
  assert.equal(upstreamBody.messages[0].role, "system");
  assert.ok(upstreamBody.messages[0].content.includes(DEFAULT_HOTLINES));
});
