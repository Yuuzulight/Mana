const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer, useTestAdminToken } = require("./helpers");

// Every route but a few public ones needs an admin key (admin-key.js).
const fetch = useTestAdminToken();

async function postNdjson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const events = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { response, events };
}

test("POST /reply/stream emits sentence events then one final event", async () => {
  const app = createApp({
    buildAssistantReply: async (
      transcript,
      screenText,
      marketText,
      modelProfile,
      sessionId,
      assistantMode,
      presetId,
      replyMeta,
      onSentence,
    ) => {
      if (onSentence) {
        await onSentence("Hello there.");
        await onSentence("How can I help?", "questioning");
      }
      if (replyMeta) {
        replyMeta.streamedMatchesFinal = true;
        replyMeta.emotion = "questioning";
      }
      return "Hello there. How can I help?";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, events } = await postNdjson(baseUrl, "/reply/stream", {
      text: "hi",
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /application\/x-ndjson/);
    // #914: each says who's speaking.
    const mana = { character: "mana", characterName: "Mana" };
    assert.deepEqual(events[0], { type: "sentence", text: "Hello there.", ...mana });
    assert.deepEqual(events[1], { type: "sentence", text: "How can I help?", emotion: "questioning", ...mana });
    assert.equal(events.length, 3);
    assert.equal(events[2].type, "final");
    assert.equal(events[2].reply, "Hello there. How can I help?");
    assert.equal(events[2].changed, false);
    assert.equal(events[2].ttsConfigured, true);
    assert.equal(events[2].emotion, "questioning");
  });
});

test("POST /reply/stream: tool-aware path emits only a final event with changed:true", async () => {
  const app = createApp({
    buildAssistantReply: async (
      transcript,
      screenText,
      marketText,
      modelProfile,
      sessionId,
      assistantMode,
      presetId,
      replyMeta,
    ) => {
      // Simulates the tool-aware/best-of-N/regeneration path: onSentence is
      // never invoked, and streamedMatchesFinal is left unset (falsy).
      return "final answer from tool-aware path";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, events } = await postNdjson(baseUrl, "/reply/stream", {
      text: "hi",
    });

    assert.equal(response.status, 200);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "final");
    assert.equal(events[0].reply, "final answer from tool-aware path");
    assert.equal(events[0].changed, true);
  });
});

test("POST /reply/stream: restart command emits a single final event with changed:true", async () => {
  let scheduleCalls = 0;
  const acceptedPayload = {
    ok: true,
    action: "restart",
    scope: "backend",
    exitCode: 77,
    message: "restart accepted",
  };
  const app = createApp({
    buildAssistantReply: async () => {
      throw new Error("should not run for restart command");
    },
    restartController: {
      buildAcceptedPayload: () => acceptedPayload,
      scheduleRestart: () => {
        scheduleCalls += 1;
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, events } = await postNdjson(baseUrl, "/reply/stream", {
      text: "/restart",
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.status, 200);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "final");
    assert.equal(events[0].reply, acceptedPayload.message);
    assert.deepEqual(events[0].restart, acceptedPayload);
    assert.equal(events[0].changed, true);
    assert.equal(scheduleCalls, 1);
  });
});

test("POST /reply/stream: #679 a text-only chat model gets the image described first, then the chat path answers", async () => {
  let chatCall = null;
  const app = createApp({
    getVisionStatus: () => ({ available: true }),
    chatAcceptsImages: () => false,
    runVisionReply: async (prompt, images, maxTokens, systemPrompt) => {
      assert.match(prompt, /word for word/);
      assert.match(prompt, /Their message: what am I looking at\?$/);
      assert.equal(images.length, 1);
      assert.match(systemPrompt, /cannot see them/);
      return "A market board.";
    },
    buildAssistantReply: async (transcript, screenText, marketText, profile, sessionId, mode, preset, replyMeta) => {
      chatCall = { transcript, images: replyMeta.images };
      return "That's the market board, obviously.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, events } = await postNdjson(baseUrl, "/reply/stream", {
      text: "what am I looking at?",
      image: "data:image/png;base64,iVBORw0KGgo=",
    });

    assert.equal(response.status, 200);
    assert.equal(events.at(-1).type, "final");
    assert.equal(events.at(-1).reply, "That's the market board, obviously.");
  });
  assert.deepEqual(chatCall, { transcript: "[Image: A market board.]\n\nwhat am I looking at?", images: [] });
});

test("POST /reply/stream: #679 a chat model that can see gets every frame (issue #450 clip hotkey) in the chat turn", async () => {
  let chatCall = null;
  const app = createApp({
    getVisionStatus: () => ({ available: true }),
    chatAcceptsImages: (profile) => profile === "default",
    runVisionReply: async () => {
      throw new Error("no describe-first call when the chat model can see");
    },
    buildAssistantReply: async (transcript, screenText, marketText, profile, sessionId, mode, preset, replyMeta) => {
      chatCall = { transcript, profile, images: replyMeta.images };
      return "You just fell off a ledge.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, events } = await postNdjson(baseUrl, "/reply/stream", {
      text: "Look back over the last 6 seconds and tell me what just happened. Answer briefly.",
      images: ["data:image/jpeg;base64,frame1", "data:image/jpeg;base64,frame2"],
    });

    assert.equal(response.status, 200);
    assert.equal(events.at(-1).type, "final");
    assert.equal(events.at(-1).reply, "You just fell off a ledge.");
  });
  assert.deepEqual(chatCall, {
    transcript: "Look back over the last 6 seconds and tell me what just happened. Answer briefly.",
    profile: "default",
    images: ["data:image/jpeg;base64,frame1", "data:image/jpeg;base64,frame2"],
  });
});

test("POST /reply/stream: missing text emits a single final error event as ndjson", async () => {
  let replyCalls = 0;
  const app = createApp({
    buildAssistantReply: async () => {
      replyCalls += 1;
      return "should not run";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, events } = await postNdjson(baseUrl, "/reply/stream", {
      text: "   ",
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /application\/x-ndjson/);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "final");
    assert.equal(events[0].error, "text is required");
    assert.equal(replyCalls, 0);
  });
});

test("POST /reply/stream relays tool start/end events before the final (#661)", async () => {
  const app = createApp({
    buildAssistantReply: async (
      transcript,
      screenText,
      marketText,
      modelProfile,
      sessionId,
      assistantMode,
      presetId,
      replyMeta,
    ) => {
      replyMeta.onToolCall({ name: "web_search", phase: "start" });
      replyMeta.onToolCall({ name: "web_search", phase: "end" });
      return "done";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { events } = await postNdjson(baseUrl, "/reply/stream", { text: "look it up" });

    assert.deepEqual(events.slice(0, 2), [
      { type: "tool", name: "web_search", phase: "start" },
      { type: "tool", name: "web_search", phase: "end" },
    ]);
    assert.equal(events[2].type, "final");
    assert.equal(events.length, 3);
  });
});

// #675: the native launcher's deep-thinking toggle reaches buildAssistantReply
// through replyMeta.thinkHarder -- a literal true or false (Q12b: false ends
// Mana's own deep thinking), anything else is ignored -- and the final event
// says whether Mana's own deep thinking is on, so the Think button can light.
test("POST /reply/stream passes thinkHarder through replyMeta and reports deepThinking", async () => {
  const seen = [];
  const app = createApp({
    buildAssistantReply: async (transcript, screenText, marketText, modelProfile, sessionId, assistantMode, presetId, replyMeta) => {
      seen.push(replyMeta.thinkHarder);
      replyMeta.deepThinking = transcript === "on";
      return "ok";
    },
  });

  const finals = [];
  await withServer(app, async (baseUrl) => {
    for (const body of [
      { text: "hi", thinkHarder: true },
      { text: "hi", thinkHarder: false },
      { text: "hi", thinkHarder: "yes" },
      { text: "on" },
    ]) {
      finals.push((await postNdjson(baseUrl, "/reply/stream", body)).events.at(-1).deepThinking);
    }
  });
  assert.deepEqual(seen, [true, false, undefined, undefined]);
  assert.deepEqual(finals, [false, false, false, true]);
});

// #911: the launcher marks a spoken turn source "voice", which lets desktop
// actions run while a game is running.
test("POST /reply/stream marks a spoken turn in replyMeta.voice", async () => {
  const seen = [];
  const app = createApp({
    buildAssistantReply: async (transcript, screenText, marketText, modelProfile, sessionId, assistantMode, presetId, replyMeta) => {
      seen.push(replyMeta.voice);
      return "ok";
    },
  });
  await withServer(app, async (baseUrl) => {
    await postNdjson(baseUrl, "/reply/stream", { text: "pause the music", source: "voice" });
    await postNdjson(baseUrl, "/reply/stream", { text: "pause the music" });
  });
  assert.deepEqual(seen, [true, false]);
});

test("POST /reply/stream: #1325 attached documents are extracted locally and included in prompt context", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-stream-doc-test-"));
  const sampleDocPath = path.join(tempDir, "sample.txt");
  fs.writeFileSync(sampleDocPath, "This is extracted document content from sample.txt.");

  let receivedPrompt = "";
  const app = createApp({
    buildAssistantReply: async (transcript) => {
      receivedPrompt = transcript;
      return "I reviewed the document.";
    },
  });

  try {
    await withServer(app, async (baseUrl) => {
      const { events } = await postNdjson(baseUrl, "/reply/stream", {
        text: "summarize this file",
        documents: [sampleDocPath],
      });
      assert.equal(events.at(-1).type, "final");
      assert.equal(events.at(-1).reply, "I reviewed the document.");
    });
    assert.match(receivedPrompt, /Attached document: sample\.txt/);
    assert.match(receivedPrompt, /This is extracted document content from sample\.txt\./);
    assert.match(receivedPrompt, /summarize this file/);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("POST /reply/stream: #1325 an unreadable document gives a clear reason so Mana can explain it", async () => {
  let receivedPrompt = "";
  const app = createApp({
    buildAssistantReply: async (transcript) => {
      receivedPrompt = transcript;
      return "I couldn't read the file.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { events } = await postNdjson(baseUrl, "/reply/stream", {
      text: "what is this?",
      documents: ["C:\\nonexistent\\missing-file.docx"],
    });
    assert.equal(events.at(-1).type, "final");
  });
  assert.match(receivedPrompt, /Attached document "missing-file\.docx" could not be read/);
  assert.match(receivedPrompt, /File not found/);
});

test("POST /reply/stream: #1354 reasoning tokens stream as thought events and are included on final", async () => {
  const app = createApp({
    buildAssistantReply: async (transcript, screen, userPatch, profile, sessionId, assistantMode, presetId, replyMeta, onSentence) => {
      replyMeta.onThought?.("Thinking about the request...");
      replyMeta.onThought?.(" Conclusion reached.");
      await onSentence?.("Here is your answer.");
      return "Here is your answer.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { events } = await postNdjson(baseUrl, "/reply/stream", {
      text: "tell me something",
    });
    const thoughtEvents = events.filter((e) => e.type === "thought");
    assert.equal(thoughtEvents.length, 2);
    assert.equal(thoughtEvents[0].text, "Thinking about the request...");
    assert.equal(thoughtEvents[1].text, " Conclusion reached.");

    const sentenceEvents = events.filter((e) => e.type === "sentence");
    assert.equal(sentenceEvents.length, 1);
    assert.equal(sentenceEvents[0].text, "Here is your answer.");

    const finalEvent = events.at(-1);
    assert.equal(finalEvent.type, "final");
    assert.equal(finalEvent.reply, "Here is your answer.");
    assert.equal(finalEvent.thought, "Thinking about the request... Conclusion reached.");
  });
});


