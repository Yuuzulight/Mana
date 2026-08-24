const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");

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
        await onSentence("How can I help?");
      }
      if (replyMeta) replyMeta.streamedMatchesFinal = true;
      return "Hello there. How can I help?";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, events } = await postNdjson(baseUrl, "/reply/stream", {
      text: "hi",
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /application\/x-ndjson/);
    assert.deepEqual(events[0], { type: "sentence", text: "Hello there." });
    assert.deepEqual(events[1], { type: "sentence", text: "How can I help?" });
    assert.equal(events.length, 3);
    assert.equal(events[2].type, "final");
    assert.equal(events[2].reply, "Hello there. How can I help?");
    assert.equal(events[2].changed, false);
    assert.equal(events[2].ttsConfigured, true);
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

test("POST /reply/stream: an attached image routes through vision and emits changed:true", async () => {
  const app = createApp({
    getVisionStatus: () => ({ available: true }),
    runVisionReply: async (prompt, images) => {
      assert.equal(prompt, "what am I looking at?");
      assert.equal(images.length, 1);
      return "A market board, obviously.";
    },
    buildAssistantReply: async () => {
      throw new Error("text reply path should not run for image replies");
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, events } = await postNdjson(baseUrl, "/reply/stream", {
      text: "what am I looking at?",
      image: "data:image/png;base64,iVBORw0KGgo=",
    });

    assert.equal(response.status, 200);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "final");
    assert.equal(events[0].reply, "A market board, obviously.");
    assert.equal(events[0].changed, true);
  });
});

test("POST /reply/stream: an attached images array (issue #450 clip hotkey) routes through vision with all frames", async () => {
  const app = createApp({
    getVisionStatus: () => ({ available: true }),
    runVisionReply: async (prompt, images) => {
      assert.equal(prompt, "Look back over the last 6 seconds and tell me what just happened. Answer briefly.");
      assert.deepEqual(images, ["data:image/jpeg;base64,frame1", "data:image/jpeg;base64,frame2"]);
      return "You just fell off a ledge.";
    },
    buildAssistantReply: async () => {
      throw new Error("text reply path should not run for image replies");
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, events } = await postNdjson(baseUrl, "/reply/stream", {
      text: "Look back over the last 6 seconds and tell me what just happened. Answer briefly.",
      images: ["data:image/jpeg;base64,frame1", "data:image/jpeg;base64,frame2"],
    });

    assert.equal(response.status, 200);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "final");
    assert.equal(events[0].reply, "You just fell off a ledge.");
    assert.equal(events[0].changed, true);
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
