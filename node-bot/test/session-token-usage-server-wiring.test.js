// Issue #421: end-to-end check that a real remote-AI HTTP response's
// `usage` field actually reaches session-token-usage.js and /perf/status --
// runOpenAIReply has no prior test coverage of its own (it's a closure
// inside server.js, not independently exported), so this exercises the real
// wiring via app.locals.buildAssistantReply against a fake OpenAI-compatible
// upstream, the same technique test/server-build-assistant-reply-streaming.test.js
// uses for the local-completion path.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer, withRawServer } = require("./helpers");
const { resetSessionTokenUsage } = require("../session-token-usage");

function fakeOpenAiHandler(reply, usage) {
  return (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: reply } }],
          usage,
        }),
      );
    });
  };
}

async function withFakeOpenAiBaseUrl(handler, fn) {
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  try {
    await withRawServer(handler, async ({ url }) => {
      // withRawServer binds 127.0.0.1 -- a loopback host, which
      // shouldUseRemoteAi() exempts from needing MANA_ALLOW_REMOTE_AI/an API
      // key, so no extra env setup is needed to reach the remote-AI branch.
      process.env.OPENAI_BASE_URL = url;
      await fn();
    });
  } finally {
    if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBaseUrl;
  }
}

test("a remote-AI reply's usage is recorded per session and surfaced via /perf/status", async () => {
  resetSessionTokenUsage();
  await withFakeOpenAiBaseUrl(
    fakeOpenAiHandler("fake remote reply", {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
    }),
    async () => {
      const app = createApp({});
      const reply = await app.locals.buildAssistantReply("hi", "", "", "default", "sess-421");
      assert.equal(reply, "fake remote reply");

      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/perf/status?sessionId=sess-421`);
        const status = await res.json();
        assert.equal(status.tokenUsage.promptTokens, 120);
        assert.equal(status.tokenUsage.completionTokens, 30);
        assert.equal(status.tokenUsage.totalTokens, 150);
        assert.equal(status.tokenUsage.calls, 1);
      });
    },
  );
});

test("usage accumulates across multiple remote-AI calls in the same session", async () => {
  resetSessionTokenUsage();
  await withFakeOpenAiBaseUrl(
    fakeOpenAiHandler("reply", { prompt_tokens: 10, completion_tokens: 5 }),
    async () => {
      const app = createApp({});
      await app.locals.buildAssistantReply("hi", "", "", "default", "sess-accum");
      await app.locals.buildAssistantReply("hi again", "", "", "default", "sess-accum");

      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/perf/status?sessionId=sess-accum`);
        const status = await res.json();
        assert.equal(status.tokenUsage.totalTokens, 30);
        assert.equal(status.tokenUsage.calls, 2);
      });
    },
  );
});

test("/perf/status omits tokenUsage when no sessionId is given, even with remote AI enabled", async () => {
  resetSessionTokenUsage();
  await withFakeOpenAiBaseUrl(
    fakeOpenAiHandler("reply", { prompt_tokens: 10, completion_tokens: 5 }),
    async () => {
      const app = createApp({});
      await withServer(app, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/perf/status`);
        const status = await res.json();
        assert.equal("tokenUsage" in status, false);
      });
    },
  );
});

test("/perf/status omits tokenUsage for a sessionId when remote AI is not enabled (local-only session)", async () => {
  resetSessionTokenUsage();
  // No OPENAI_BASE_URL override here -- defaults to the real, non-loopback
  // api.openai.com, so shouldUseRemoteAi() is false without an explicit key.
  const originalKey = process.env.OPENAI_API_KEY;
  const originalAllow = process.env.MANA_ALLOW_REMOTE_AI;
  delete process.env.OPENAI_API_KEY;
  delete process.env.MANA_ALLOW_REMOTE_AI;
  try {
    const app = createApp({});
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/perf/status?sessionId=sess-local-only`);
      const status = await res.json();
      assert.equal("tokenUsage" in status, false);
    });
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalAllow === undefined) delete process.env.MANA_ALLOW_REMOTE_AI;
    else process.env.MANA_ALLOW_REMOTE_AI = originalAllow;
  }
});

test("MANA_SESSION_TOKEN_STOP blocks further remote-AI calls for a session once the threshold is reached", async () => {
  resetSessionTokenUsage();
  const originalStop = process.env.MANA_SESSION_TOKEN_STOP;
  process.env.MANA_SESSION_TOKEN_STOP = "20";
  try {
    await withFakeOpenAiBaseUrl(
      fakeOpenAiHandler("reply", { prompt_tokens: 15, completion_tokens: 10 }), // 25 total, over the 20 stop threshold
      async () => {
        // Stub out local completion (rather than letting it fall through to
        // a real llama-cli.exe/GGUF model, which this test environment
        // doesn't have) -- only the remote-block behavior is under test.
        const app = createApp({ runLocalAssistantReply: async () => "local fallback" });
        // First call: under the threshold before it runs, so it goes through
        // and pushes the session to 25 tokens.
        const first = await app.locals.buildAssistantReply("hi", "", "", "default", "sess-stop");
        assert.equal(first, "reply");

        // Second call: session is now over the stop threshold, so
        // runOpenAIReply must refuse before ever hitting the fake upstream --
        // buildAssistantReply falls back to the local path instead.
        const second = await app.locals.buildAssistantReply(
          "hi again",
          "",
          "",
          "default",
          "sess-stop",
        );
        assert.equal(second, "local fallback");

        await withServer(app, async (baseUrl) => {
          const res = await fetch(`${baseUrl}/perf/status?sessionId=sess-stop`);
          const status = await res.json();
          // Still just the one call's usage -- the second call never reached
          // the upstream, so nothing new was recorded.
          assert.equal(status.tokenUsage.calls, 1);
          assert.equal(status.tokenUsage.stopExceeded, true);
        });
      },
    );
  } finally {
    if (originalStop === undefined) delete process.env.MANA_SESSION_TOKEN_STOP;
    else process.env.MANA_SESSION_TOKEN_STOP = originalStop;
  }
});
