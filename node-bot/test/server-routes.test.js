const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { response, payload };
}

test("admin restart accepts loopback requests and schedules restart once", async () => {
  let buildPayloadCalls = 0;
  let scheduleCalls = 0;
  const acceptedPayload = {
    ok: true,
    action: "restart",
    scope: "backend",
    exitCode: 77,
    message: "restart accepted",
  };
  const app = createApp({
    restartController: {
      buildAcceptedPayload: () => {
        buildPayloadCalls += 1;
        return acceptedPayload;
      },
      scheduleRestart: () => {
        scheduleCalls += 1;
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/admin/restart`, {});
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.status, 200);
    assert.deepEqual(payload, acceptedPayload);
    assert.equal(buildPayloadCalls, 1);
    assert.equal(scheduleCalls, 1);
  });
});

test("admin restart rejects non-loopback forwarded clients without scheduling restart", async () => {
  let buildPayloadCalls = 0;
  let scheduleCalls = 0;
  const app = createApp({
    restartController: {
      buildAcceptedPayload: () => {
        buildPayloadCalls += 1;
        return { ok: true };
      },
      scheduleRestart: () => {
        scheduleCalls += 1;
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(
      `${baseUrl}/admin/restart`,
      {},
      { "X-Forwarded-For": "192.168.1.50" },
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.status, 403);
    assert.deepEqual(payload, { error: "restart is only available from this PC" });
    assert.equal(buildPayloadCalls, 0);
    assert.equal(scheduleCalls, 0);
  });
});

test("reply restart command acknowledges restart without model inference", async () => {
  let buildAssistantReplyCalls = 0;
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
      buildAssistantReplyCalls += 1;
      return "should not run";
    },
    restartController: {
      buildAcceptedPayload: () => acceptedPayload,
      scheduleRestart: () => {
        scheduleCalls += 1;
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "/restart",
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      reply: acceptedPayload.message,
      restart: acceptedPayload,
      ttsConfigured: false,
    });
    assert.equal(scheduleCalls, 1);
    assert.equal(buildAssistantReplyCalls, 0);
  });
});

test("reply rejects missing text with a stable validation error", async () => {
  let replyCalls = 0;
  const app = createApp({
    buildAssistantReply: async () => {
      replyCalls += 1;
      return "should not run";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, { text: "   " });

    assert.equal(response.status, 400);
    assert.deepEqual(payload, { error: "text is required" });
    assert.equal(replyCalls, 0);
  });
});

test("model status route reports active profile and configured profiles", async () => {
  const app = createApp({
    modelManagement: {
      getModelStatus: () => ({
        activeProfile: "default",
        remoteAiEnabled: false,
        remoteAiWarning: null,
        profiles: {
          default: { key: "default", label: "Default chat", candidates: [] },
          fast: { key: "fast", label: "Fast fallback", candidates: [] },
        },
      }),
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/models/status`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.activeProfile, "default");
    assert.equal(payload.profiles.fast.label, "Fast fallback");
  });
});

test("active profile route switches profile and rejects invalid profiles", async () => {
  let activeProfile = "default";
  const app = createApp({
    modelManagement: {
      getModelStatus: () => ({ activeProfile, profiles: {} }),
      setActiveProfile: (profile) => {
        if (profile !== "coding") {
          throw new Error("profile must be one of: default, fast, quality, coding");
        }
        activeProfile = profile;
        return { activeProfile, profiles: {} };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const accepted = await postJson(`${baseUrl}/models/active-profile`, {
      profile: "coding",
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.payload.activeProfile, "coding");

    const rejected = await postJson(`${baseUrl}/models/active-profile`, {
      profile: "unknown",
    });
    assert.equal(rejected.response.status, 400);
    assert.deepEqual(rejected.payload, {
      error: "profile must be one of: default, fast, quality, coding",
    });
    assert.equal(activeProfile, "coding");
  });
});

test("reply uses active model profile when request omits modelProfile", async () => {
  let receivedProfile = null;
  const app = createApp({
    modelManagement: {
      getActiveProfile: () => "fast",
      getModelStatus: () => ({ activeProfile: "fast", profiles: {} }),
      setActiveProfile: () => ({ activeProfile: "fast", profiles: {} }),
    },
    buildCraftProfitContextForPrompt: async () => "",
    buildUniversalisContextForPrompt: async () => "",
    buildMarketContextForPrompt: async () => "",
    buildAssistantReply: async (transcript, screenText, marketText, modelProfile) => {
      receivedProfile = modelProfile;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "hello",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "ok");
    assert.equal(receivedProfile, "fast");
  });
});

test("reply keeps explicit modelProfile above active profile", async () => {
  let receivedProfile = null;
  const app = createApp({
    modelManagement: {
      getActiveProfile: () => "fast",
      getModelStatus: () => ({ activeProfile: "fast", profiles: {} }),
      setActiveProfile: () => ({ activeProfile: "fast", profiles: {} }),
    },
    buildCraftProfitContextForPrompt: async () => "",
    buildUniversalisContextForPrompt: async () => "",
    buildMarketContextForPrompt: async () => "",
    buildAssistantReply: async (transcript, screenText, marketText, modelProfile) => {
      receivedProfile = modelProfile;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response } = await postJson(`${baseUrl}/reply`, {
      text: "hello",
      modelProfile: "coding",
    });

    assert.equal(response.status, 200);
    assert.equal(receivedProfile, "coding");
  });
});

test("reply continues when optional market context fails", async () => {
  const app = createApp({
    buildCraftProfitContextForPrompt: async () => "",
    buildUniversalisContextForPrompt: async () => "",
    buildMarketContextForPrompt: async () => {
      throw new Error("Alpha Vantage API key is not configured");
    },
    buildAssistantReply: async (transcript, screenText, marketText) => {
      assert.equal(transcript, "can you read the current repository's readme?");
      assert.equal(marketText, "");
      return "README summary";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "can you read the current repository's readme?",
      modelProfile: "coding",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "README summary");
  });
});

test("reply skips optional context builders for general repository prompts", async () => {
  const calls = [];
  let contextCalls = 0;
  const app = createApp({
    buildCraftProfitContextForPrompt: async () => {
      contextCalls += 1;
      throw new Error("craft context should not run");
    },
    buildUniversalisContextForPrompt: async () => {
      contextCalls += 1;
      throw new Error("universalis context should not run");
    },
    buildMarketContextForPrompt: async () => {
      contextCalls += 1;
      throw new Error("market context should not run");
    },
    textLooksLikeCraftProfitQuestion: () => false,
    textLooksLikeMarketQuestion: () => false,
    textLooksLikeStockMarketQuestion: () => false,
    buildAssistantReply: async (transcript, screenText, marketText) => {
      calls.push({ transcript, screenText, marketText });
      return "README summary";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "can you read the current repository's readme?",
      modelProfile: "coding",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "README summary");
    assert.equal(calls[0].marketText, "");
    assert.equal(contextCalls, 0);
  });
});

test("reply skips optional context builders when includeContext is false", async () => {
  let contextCalls = 0;
  const app = createApp({
    buildCraftProfitContextForPrompt: async () => {
      contextCalls += 1;
      return "craft context";
    },
    buildUniversalisContextForPrompt: async () => {
      contextCalls += 1;
      return "universalis context";
    },
    buildMarketContextForPrompt: async () => {
      contextCalls += 1;
      return "market context";
    },
    textLooksLikeCraftProfitQuestion: () => true,
    textLooksLikeMarketQuestion: () => true,
    textLooksLikeStockMarketQuestion: () => true,
    buildAssistantReply: async (transcript, screenText, marketText) => {
      assert.match(transcript, /Repository README/);
      assert.equal(marketText, "");
      return "README summary";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "Repository README:\nFFXIV and Universalis crafting market data",
      modelProfile: "coding",
      includeContext: false,
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "README summary");
    assert.equal(contextCalls, 0);
  });
});

test("vision describe returns a reply from the vision runtime", async () => {
  const app = createApp({
    getVisionStatus: () => ({ available: true, model: "vl.gguf", mmproj: "mmproj.gguf" }),
    runVisionReply: async (prompt, images) => {
      assert.equal(prompt, "What is this?");
      assert.equal(images.length, 1);
      assert.match(images[0], /^data:image\/png;base64,/);
      return "That looks like a chocobo.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/vision/describe`, {
      image: "data:image/png;base64,iVBORw0KGgo=",
      prompt: "What is this?",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "That looks like a chocobo.");
  });
});

test("vision describe reports 503 when no vision model is available", async () => {
  const app = createApp({
    getVisionStatus: () => ({ available: false, reason: "No local vision model found." }),
    runVisionReply: async () => {
      throw new Error("should not be called");
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/vision/describe`, {
      image: "data:image/png;base64,iVBORw0KGgo=",
    });

    assert.equal(response.status, 503);
    assert.match(payload.error, /no local vision model/i);
    assert.match(payload.detail, /No local vision model found/);
  });
});

test("reply with an attached image routes through the vision runtime", async () => {
  let visionCalls = 0;
  const app = createApp({
    getVisionStatus: () => ({ available: true }),
    runVisionReply: async (prompt, images) => {
      visionCalls += 1;
      assert.equal(prompt, "what am I looking at?");
      assert.equal(images.length, 1);
      return "A market board, obviously.";
    },
    buildAssistantReply: async () => {
      throw new Error("text reply path should not run for image replies");
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "what am I looking at?",
      image: "data:image/png;base64,iVBORw0KGgo=",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "A market board, obviously.");
    assert.equal(visionCalls, 1);
  });
});

test("reply with an image allows empty text", async () => {
  const app = createApp({
    getVisionStatus: () => ({ available: true }),
    runVisionReply: async (prompt, images) => {
      assert.equal(prompt, "");
      assert.equal(images.length, 1);
      return "I see a screenshot.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      image: "data:image/png;base64,iVBORw0KGgo=",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "I see a screenshot.");
  });
});

test("POST /web/search returns results from the injected searchWeb", async () => {
  const app = createApp({
    searchWeb: async (query, options) => {
      assert.equal(query, "chocobo racing tips");
      assert.equal(options.limit, 3);
      return [{ title: "Tips", url: "https://example.com", snippet: "..." }];
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/web/search`, {
      query: "chocobo racing tips",
      limit: 3,
    });

    assert.equal(response.status, 200);
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].title, "Tips");
  });
});

test("POST /web/search rejects a missing query", async () => {
  const app = createApp({
    searchWeb: async () => {
      throw new Error("should not be called");
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/web/search`, {});
    assert.equal(response.status, 400);
    assert.match(payload.error, /query/i);
  });
});

test("POST /web/read returns the injected fetchPage result", async () => {
  const app = createApp({
    fetchPage: async (url) => {
      assert.equal(url, "https://example.com/page");
      return { url, title: "Example", text: "Hello page", truncated: false };
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/web/read`, {
      url: "https://example.com/page",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.title, "Example");
    assert.equal(payload.text, "Hello page");
  });
});

test("GET /wiki/:term returns the injected wikiLookup result", async () => {
  const app = createApp({
    wikiLookup: async (term) => {
      assert.equal(term, "chocobo");
      return { title: "Chocobo", extract: "A large bird.", url: "https://en.wikipedia.org/wiki/Chocobo" };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/wiki/chocobo`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.title, "Chocobo");
  });
});

test("GET /wiki/:term returns 404 when nothing matches", async () => {
  const app = createApp({
    wikiLookup: async () => null,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/wiki/asdkjfhaskdjfh`);
    assert.equal(response.status, 404);
  });
});

test("reply falls back to web context when no market question is detected", async () => {
  const app = createApp({
    buildCraftProfitContextForPrompt: async () => "",
    buildUniversalisContextForPrompt: async () => "",
    buildMarketContextForPrompt: async () => "",
    buildWebContextForPrompt: async (text) => {
      assert.equal(text, "search for FFXIV patch notes");
      return "Web search results:\n1. Patch Notes\n   https://example.com\n   ...\n\n";
    },
    buildAssistantReply: async (transcript, screenText, marketText) => {
      assert.match(marketText, /Web search results/);
      return "Here's what I found.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "search for FFXIV patch notes",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "Here's what I found.");
  });
});

test("reply skips web context when includeContext is false", async () => {
  let webContextCalls = 0;
  const app = createApp({
    buildCraftProfitContextForPrompt: async () => "",
    buildUniversalisContextForPrompt: async () => "",
    buildMarketContextForPrompt: async () => "",
    buildWebContextForPrompt: async () => {
      webContextCalls += 1;
      return "Web search results:\n...";
    },
    buildAssistantReply: async (transcript, screenText, marketText) => {
      assert.equal(marketText, "");
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    await postJson(`${baseUrl}/reply`, {
      text: "search for FFXIV patch notes",
      includeContext: false,
    });
  });

  assert.equal(webContextCalls, 0);
});
