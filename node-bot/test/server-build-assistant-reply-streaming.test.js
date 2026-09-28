// Issue #331: buildAssistantReply's onSentence callback should stream
// through the first plain local-completion attempt (via
// llamaServerRuntime.streamLocalAssistantReply), and replyMeta.streamedMatchesFinal
// should report whether everything streamed still matches the final reply
// after buildAssistantReply's own post-processing (rut detection, phrasing
// variation) has had a chance to run.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");

test("onSentence fires per streamed sentence and replyMeta.streamedMatchesFinal is true when nothing rewrites the reply", async () => {
  const seen = [];
  const fakeLlamaServerRuntime = {
    isEnabled: () => true,
    streamLocalAssistantReply: async (prompt, opts) => {
      await opts.onSentence("Hello there.");
      await opts.onSentence("How can I help?");
      return "Hello there. How can I help?";
    },
    runToolAwareReply: async () => ({ content: "", toolCalls: [], rounds: 0 }),
    runBestOfNReply: async () => ({ content: "" }),
  };

  const app = createApp({ llamaServerRuntime: fakeLlamaServerRuntime });

  const replyMeta = {};
  const reply = await app.locals.buildAssistantReply(
    "hi",
    "",
    "",
    "default",
    null,
    null,
    null,
    replyMeta,
    (sentence) => seen.push(sentence),
  );

  assert.equal(reply, "Hello there. How can I help?");
  assert.deepEqual(seen, ["Hello there.", "How can I help?"]);
  assert.equal(replyMeta.streamedMatchesFinal, true);
});

test("streaming is skipped when no onSentence callback is provided (existing callers are unaffected)", async () => {
  let plainCalls = 0;
  const fakeLlamaServerRuntime = {
    isEnabled: () => true,
    streamLocalAssistantReply: async () => {
      throw new Error("should not be called without onSentence");
    },
  };

  const app = createApp({
    llamaServerRuntime: fakeLlamaServerRuntime,
    runLocalAssistantReply: async () => {
      plainCalls += 1;
      return "plain reply";
    },
  });

  const replyMeta = {};
  const reply = await app.locals.buildAssistantReply(
    "hi",
    "",
    "",
    "default",
    null,
    null,
    null,
    replyMeta,
  );

  assert.equal(reply, "plain reply");
  assert.equal(plainCalls, 1);
  assert.equal(replyMeta.streamedMatchesFinal, false);
});

test("a failed streaming attempt falls back to the non-streaming reply and reports the mismatch", async () => {
  const seen = [];
  let streamAttempts = 0;
  const fakeLlamaServerRuntime = {
    isEnabled: () => true,
    streamLocalAssistantReply: async (prompt, opts) => {
      streamAttempts += 1;
      // One sentence already streamed (and, in production, possibly
      // already spoken client-side) before the connection drops.
      await opts.onSentence("Partial before failure.");
      throw new Error("stream disconnected");
    },
  };

  const app = createApp({
    llamaServerRuntime: fakeLlamaServerRuntime,
    runLocalAssistantReply: async () => "Full non-streamed fallback reply.",
  });

  const replyMeta = {};
  const reply = await app.locals.buildAssistantReply(
    "hi",
    "",
    "",
    "default",
    null,
    null,
    null,
    replyMeta,
    (sentence) => seen.push(sentence),
  );

  assert.equal(streamAttempts, 1);
  assert.deepEqual(seen, ["Partial before failure."]);
  assert.equal(reply, "Full non-streamed fallback reply.");
  assert.equal(replyMeta.streamedMatchesFinal, false);
});

// #666: the turn waits for llama-server before replying, says so once as a
// streamed sentence, and switches to the fallback profile when that's what
// came up. Neither notice counts against streamedMatchesFinal.
test("#666: a turn that waited says so, and answers on the fallback profile waitForServer returned", async () => {
  const seen = [];
  let streamedProfile = null;
  const fakeLlamaServerRuntime = {
    isEnabled: () => true,
    waitForServer: async (profile, onWait) => {
      assert.equal(profile, "default");
      onWait();
      return "fast";
    },
    streamLocalAssistantReply: async (prompt, opts) => {
      streamedProfile = opts.profile;
      await opts.onSentence("Hello there.");
      return "Hello there.";
    },
    runToolAwareReply: async () => ({ content: "", toolCalls: [], rounds: 0 }),
    runBestOfNReply: async () => ({ content: "" }),
  };

  const app = createApp({ llamaServerRuntime: fakeLlamaServerRuntime });
  const replyMeta = {};
  const reply = await app.locals.buildAssistantReply(
    "hi", "", "", "default", null, null, null, replyMeta,
    (sentence) => seen.push(sentence),
  );

  assert.equal(reply, "Hello there.");
  assert.equal(streamedProfile, "fast");
  assert.deepEqual(seen, [
    "Give me a second, I'm waking up.",
    "My main model isn't answering, so I'm using my backup.",
    "Hello there.",
  ]);
  assert.equal(replyMeta.streamedMatchesFinal, true);
});

test("#666: when waitForServer gives up, the turn still falls through to the existing reply paths", async () => {
  const fakeLlamaServerRuntime = {
    isEnabled: () => true,
    waitForServer: async () => {
      throw new Error("llama-server recently failed to start; retry cooldown active");
    },
    streamLocalAssistantReply: async () => {
      throw new Error("still down");
    },
  };

  const app = createApp({
    llamaServerRuntime: fakeLlamaServerRuntime,
    runLocalAssistantReply: async () => "llama-cli reply",
  });
  const reply = await app.locals.buildAssistantReply(
    "hi", "", "", "default", null, null, null, {}, () => {},
  );
  assert.equal(reply, "llama-cli reply");
});
