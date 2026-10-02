// #623: per-sentence emotion tags -- asked for in the reply prompt, stripped
// from everything spoken/shown/stored, and passed on as each sentence's face.
const assert = require("node:assert/strict");
const test = require("node:test");

const { EMOTION_TAGS, EMOTION_TAG_PROMPT, stripEmotionTags, replyEmotion } = require("../utils/emotion-tags");
const { createApp } = require("../server");

test("stripEmotionTags removes known tags and aliases, keeping spacing and other brackets", () => {
  assert.deepEqual(stripEmotionTags("[happy] Welcome back! [Questioning] Did the raid go well?"), {
    text: "Welcome back! Did the raid go well?",
    emotions: ["happy", "questioning"],
  });
  assert.deepEqual(stripEmotionTags("That's great [joy]."), { text: "That's great.", emotions: ["happy"] });
  assert.deepEqual(stripEmotionTags("1. Open it [wink]\n2. Save [TODO] arr[index]"), {
    text: "1. Open it\n2. Save [TODO] arr[index]",
    emotions: ["wink"],
  });
  assert.deepEqual(stripEmotionTags("[sad]"), { text: "", emotions: ["sad"] });
  assert.deepEqual(stripEmotionTags("No tags here."), { text: "No tags here.", emotions: [] });
});

test("replyEmotion prefers the first non-neutral tag", () => {
  assert.equal(replyEmotion(["neutral", "embarrassed", "happy"]), "embarrassed");
  assert.equal(replyEmotion(["neutral"]), "neutral");
  assert.equal(replyEmotion([]), null);
});

// Live, "Before each sentence" + a two-sentence example got only the first
// sentence tagged, and [thinking] for sad news.
test("the tag prompt asks for a tag on every sentence and shows it with differing faces", () => {
  assert.match(EMOTION_TAG_PROMPT, /EVERY sentence/);
  assert.match(EMOTION_TAG_PROMPT, /\[sad\]/);
  const example = EMOTION_TAG_PROMPT.slice(EMOTION_TAG_PROMPT.indexOf("Example:") + "Example:".length).trim();
  const sentences = example.split(/(?<=[.!?])\s+/);
  assert.ok(sentences.length >= 3);
  const tags = sentences.map((sentence) => (sentence.match(/^\[(\w+)\] /) || [])[1]);
  for (const tag of tags) assert.ok(EMOTION_TAGS.includes(tag), `every example sentence starts with a known tag: ${sentences}`);
  assert.equal(new Set(tags).size, tags.length, "each example sentence shows a different face");
});

test("buildAssistantReply asks for tags and returns the reply without them", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  try {
    let systemPrompt = "";
    const app = createApp({
      llamaServerRuntime: { isEnabled: () => true },
      runToolAwareReply: async (prompt, toolPolicy, options) => {
        systemPrompt = options.overrideSystemPrompt;
        return { content: "[neutral] Sure. [happy] That's great news!", toolCalls: [], rounds: 1 };
      },
    });
    const replyMeta = {};

    const reply = await app.locals.buildAssistantReply("hi", "", "", "default", null, null, null, replyMeta);

    assert.match(systemPrompt, /\[happy\]/);
    assert.equal(reply, "Sure. That's great news!");
    assert.equal(replyMeta.emotion, "happy");
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
  }
});

test("streamed sentences go out untagged, each with its face; an untagged one keeps the last", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "0";
  try {
    const app = createApp({
      llamaServerRuntime: {
        isEnabled: () => true,
        streamLocalAssistantReply: async (prompt, { onSentence }) => {
          await onSentence("Hi!");
          await onSentence("[happy] You're back!");
          await onSentence("I missed you.");
          await onSentence("[sad]");
          return "Hi! [happy] You're back! I missed you. [sad]";
        },
      },
    });
    const sentences = [];
    const replyMeta = {};

    const reply = await app.locals.buildAssistantReply(
      "hi", "", "", "default", null, null, null, replyMeta,
      (text, emotion) => sentences.push([text, emotion]),
    );

    assert.deepEqual(sentences, [
      ["Hi!", null],
      ["You're back!", "happy"],
      ["I missed you.", "happy"],
    ]);
    assert.equal(reply, "Hi! You're back! I missed you.");
    assert.equal(replyMeta.streamedMatchesFinal, true);
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
  }
});

// The tool path isn't streamed: before this, its reply went out as one clip
// with one face.
test("a tool-path reply goes out sentence by sentence, each with its face", async () => {
  process.env.MANA_TOOL_CALLING_ENABLED = "1";
  try {
    const app = createApp({
      llamaServerRuntime: { isEnabled: () => true },
      runToolAwareReply: async () => ({
        content: "[sad] Oh no, it's raining. [questioning] Did you bring an umbrella? [happy] Stay dry!",
        toolCalls: [],
        rounds: 1,
      }),
    });
    const sentences = [];
    const replyMeta = {};

    const reply = await app.locals.buildAssistantReply(
      "hi", "", "", "default", null, null, null, replyMeta,
      (text, emotion) => sentences.push([text, emotion]),
    );

    assert.deepEqual(sentences, [
      ["Oh no, it's raining.", "sad"],
      ["Did you bring an umbrella?", "questioning"],
      ["Stay dry!", "happy"],
    ]);
    assert.equal(reply, "Oh no, it's raining. Did you bring an umbrella? Stay dry!");
    assert.equal(replyMeta.streamedMatchesFinal, true);
  } finally {
    delete process.env.MANA_TOOL_CALLING_ENABLED;
  }
});
