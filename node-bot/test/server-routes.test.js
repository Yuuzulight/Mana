const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp, formatMemoryMarkdown, buildMemoryNotes } = require("../server");
const { withServer } = require("./helpers");

// Stands in for a real plugin/capability's contributePromptContext (issue
// #108) so /reply's context chain can be tested deterministically -- the
// real ffxivMarket/stockMarket/webAccess capabilities self-guard on text
// detection internally and webAccess can reach real network calls, neither
// of which belongs in a unit test.
function fakeContextCapability(key, contributePromptContext) {
  return { key, contributePromptContext };
}

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

test("reply passes presetId through to buildAssistantReply", async () => {
  let receivedPresetId = "not-set";
  const app = createApp({
    buildAssistantReply: async (
      transcript,
      screenText,
      marketText,
      modelProfile,
      sessionId,
      assistantMode,
      presetId,
    ) => {
      receivedPresetId = presetId;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response } = await postJson(`${baseUrl}/reply`, {
      text: "hello",
      presetId: "preset-123",
    });

    assert.equal(response.status, 200);
    assert.equal(receivedPresetId, "preset-123");
  });
});

test("reply omits presetId as null when the request doesn't select one", async () => {
  let receivedPresetId = "not-set";
  const app = createApp({
    buildAssistantReply: async (
      transcript,
      screenText,
      marketText,
      modelProfile,
      sessionId,
      assistantMode,
      presetId,
    ) => {
      receivedPresetId = presetId;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    await postJson(`${baseUrl}/reply`, { text: "hello" });
    assert.equal(receivedPresetId, null);
  });
});

test("transcribe passes presetId through to buildAssistantReply", async () => {
  let receivedPresetId = "not-set";
  const app = createApp({
    normalizeUploadedAudio: (file) => ({ tmpPath: file.path, audioPath: file.path }),
    runWhisper: () => "hello",
    cleanupUploadedAudio: () => {},
    buildAssistantReply: async (
      transcript,
      screenText,
      marketText,
      modelProfile,
      sessionId,
      assistantMode,
      presetId,
    ) => {
      receivedPresetId = presetId;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const form = new FormData();
    form.append("file", new Blob(["fake audio"], { type: "audio/wav" }), "voice.wav");
    form.append("presetId", "preset-123");
    const response = await fetch(`${baseUrl}/transcribe`, { method: "POST", body: form });

    assert.equal(response.status, 200);
    assert.equal(receivedPresetId, "preset-123");
  });
});

test("transcribe omits presetId as null when the request doesn't select one", async () => {
  let receivedPresetId = "not-set";
  const app = createApp({
    normalizeUploadedAudio: (file) => ({ tmpPath: file.path, audioPath: file.path }),
    runWhisper: () => "hello",
    cleanupUploadedAudio: () => {},
    buildAssistantReply: async (
      transcript,
      screenText,
      marketText,
      modelProfile,
      sessionId,
      assistantMode,
      presetId,
    ) => {
      receivedPresetId = presetId;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const form = new FormData();
    form.append("file", new Blob(["fake audio"], { type: "audio/wav" }), "voice.wav");
    const response = await fetch(`${baseUrl}/transcribe`, { method: "POST", body: form });

    assert.equal(response.status, 200);
    assert.equal(receivedPresetId, null);
  });
});

// Regression test for a real bug this feature surfaced: buildAssistantReply
// computes a mode/preset-aware system prompt (selectedSystemPrompt), but the
// local-inference call site never forwarded it, so presets (and the
// pre-existing casual/everyday/coding modes) had zero effect on local
// replies -- only the opt-in remote/OpenAI path ever received it. This
// exercises the REAL buildAssistantReply (not mocked) end to end and checks
// what actually reaches the model call.
test("a selected preset's instructions reach the local model's system prompt", async () => {
  let capturedSystemPrompt = null;
  const presetsStore = {
    getPreset: (id) =>
      id === "preset-1"
        ? { id: "preset-1", name: "Concise", instructions: "Keep every reply under two sentences." }
        : null,
  };
  const app = createApp({
    presetsStore,
    runLocalAssistantReply: async (prompt, maxTokens, profile, overrideSystemPrompt) => {
      capturedSystemPrompt = overrideSystemPrompt;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "hello",
      presetId: "preset-1",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "ok");
    assert.match(capturedSystemPrompt, /Keep every reply under two sentences\./);
  });
});

test("no preset selected leaves the local model's system prompt unchanged", async () => {
  let capturedSystemPrompt = null;
  const app = createApp({
    runLocalAssistantReply: async (prompt, maxTokens, profile, overrideSystemPrompt) => {
      capturedSystemPrompt = overrideSystemPrompt;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    await postJson(`${baseUrl}/reply`, { text: "hello" });
    assert.doesNotMatch(capturedSystemPrompt || "", /Keep every reply under two sentences\./);
  });
});

// Tool-calling wiring (issue #51): opt-in via MANA_TOOL_CALLING_ENABLED,
// scoped to the "default" profile only (the one profile verified to emit
// reliable tool_calls -- see docs/roadmap/issue-51-tool-calling.md), and
// falls back to the plain reply path on any failure or empty result.
async function withToolCallingEnv(value, fn) {
  const prior = process.env.MANA_TOOL_CALLING_ENABLED;
  process.env.MANA_TOOL_CALLING_ENABLED = value;
  try {
    await fn();
  } finally {
    if (prior === undefined) delete process.env.MANA_TOOL_CALLING_ENABLED;
    else process.env.MANA_TOOL_CALLING_ENABLED = prior;
  }
}

test("tool-calling stays off by default even when a runToolAwareReply is provided", async () => {
  await withToolCallingEnv(undefined, async () => {
    let toolAwareCalls = 0;
    let plainCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async () => {
        toolAwareCalls += 1;
        return { content: "tool reply", toolCalls: [] };
      },
      runLocalAssistantReply: async () => {
        plainCalls += 1;
        return "plain reply";
      },
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, { text: "hello" });
      assert.equal(payload.reply, "plain reply");
      assert.equal(toolAwareCalls, 0);
      assert.equal(plainCalls, 1);
    });
  });
});

test("tool-calling activates for the default profile when enabled and llama-server is available", async () => {
  await withToolCallingEnv("1", async () => {
    let capturedPrompt = null;
    let plainCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async (prompt) => {
        capturedPrompt = prompt;
        return {
          content: "The file says hello",
          toolCalls: [{ name: "read_file", args: { path: "notes.txt" }, ok: true }],
        };
      },
      runLocalAssistantReply: async () => {
        plainCalls += 1;
        return "plain reply";
      },
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "what does notes.txt say?",
        modelProfile: "default",
      });
      assert.equal(payload.reply, "The file says hello");
      assert.match(capturedPrompt, /notes\.txt/);
      assert.equal(plainCalls, 0);
    });
  });
});

test("tool-calling does not activate for a non-default profile even when enabled", async () => {
  await withToolCallingEnv("1", async () => {
    let toolAwareCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async () => {
        toolAwareCalls += 1;
        return { content: "should not happen", toolCalls: [] };
      },
      runLocalAssistantReply: async () => "plain coding reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "debug this function",
        modelProfile: "coding",
      });
      assert.equal(payload.reply, "plain coding reply");
      assert.equal(toolAwareCalls, 0);
    });
  });
});

test("tool-calling falls back to the plain reply when llama-server isn't available", async () => {
  await withToolCallingEnv("1", async () => {
    let toolAwareCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => false,
      runToolAwareReply: async () => {
        toolAwareCalls += 1;
        return { content: "should not happen", toolCalls: [] };
      },
      runLocalAssistantReply: async () => "plain reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, { text: "hello" });
      assert.equal(payload.reply, "plain reply");
      assert.equal(toolAwareCalls, 0);
    });
  });
});

test("tool-calling falls back to the plain reply when runToolAwareReply throws", async () => {
  await withToolCallingEnv("1", async () => {
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async () => {
        throw new Error("llama-server executable not found");
      },
      runLocalAssistantReply: async () => "plain reply",
    });

    await withServer(app, async (baseUrl) => {
      const { response, payload } = await postJson(`${baseUrl}/reply`, { text: "hello" });
      assert.equal(response.status, 200);
      assert.equal(payload.reply, "plain reply");
    });
  });
});

test("tool-calling falls back to the plain reply when runToolAwareReply returns empty content", async () => {
  await withToolCallingEnv("1", async () => {
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async () => ({ content: "", toolCalls: [] }),
      runLocalAssistantReply: async () => "plain reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, { text: "hello" });
      assert.equal(payload.reply, "plain reply");
    });
  });
});

// Best-of-N wiring (issue #70): opt-in via MANA_BEST_OF_N_ENABLED, scoped to
// coding-mode replies only, layered on top of the tool-calling/plain path so
// any failure or empty result falls straight through to it.
async function withBestOfNEnv(value, fn) {
  const prior = process.env.MANA_BEST_OF_N_ENABLED;
  process.env.MANA_BEST_OF_N_ENABLED = value;
  try {
    await fn();
  } finally {
    if (prior === undefined) delete process.env.MANA_BEST_OF_N_ENABLED;
    else process.env.MANA_BEST_OF_N_ENABLED = prior;
  }
}

test("best-of-N stays off by default even when a runBestOfNReply is provided", async () => {
  await withBestOfNEnv(undefined, async () => {
    let bestOfNCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runBestOfNReply: async () => {
        bestOfNCalls += 1;
        return { content: "best-of-n reply", candidates: [], judgeIndex: 0 };
      },
      runLocalAssistantReply: async () => "plain coding reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "debug this function",
        modelProfile: "coding",
      });
      assert.equal(payload.reply, "plain coding reply");
      assert.equal(bestOfNCalls, 0);
    });
  });
});

test("best-of-N activates for coding-mode replies when enabled and llama-server is available", async () => {
  await withBestOfNEnv("1", async () => {
    let capturedOptions = null;
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runBestOfNReply: async (prompt, options) => {
        capturedOptions = options;
        return {
          content: "the judged best fix",
          candidates: ["a", "b", "c"],
          judgeIndex: 1,
        };
      },
      runLocalAssistantReply: async () => "plain coding reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "debug this function",
        modelProfile: "coding",
      });
      assert.equal(payload.reply, "the judged best fix");
      assert.equal(capturedOptions.profile, "coding");
    });
  });
});

test("best-of-N does not activate for a non-coding reply even when enabled", async () => {
  await withBestOfNEnv("1", async () => {
    let bestOfNCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runBestOfNReply: async () => {
        bestOfNCalls += 1;
        return { content: "should not happen", candidates: [], judgeIndex: 0 };
      },
      runLocalAssistantReply: async () => "plain reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, { text: "hello there" });
      assert.equal(payload.reply, "plain reply");
      assert.equal(bestOfNCalls, 0);
    });
  });
});

test("best-of-N falls back to the plain reply when llama-server isn't available", async () => {
  await withBestOfNEnv("1", async () => {
    let bestOfNCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => false,
      runBestOfNReply: async () => {
        bestOfNCalls += 1;
        return { content: "should not happen", candidates: [], judgeIndex: 0 };
      },
      runLocalAssistantReply: async () => "plain coding reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "debug this function",
        modelProfile: "coding",
      });
      assert.equal(payload.reply, "plain coding reply");
      assert.equal(bestOfNCalls, 0);
    });
  });
});

test("best-of-N falls back to the plain reply when runBestOfNReply throws", async () => {
  await withBestOfNEnv("1", async () => {
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runBestOfNReply: async () => {
        throw new Error("llama-server returned no usable candidates");
      },
      runLocalAssistantReply: async () => "plain coding reply",
    });

    await withServer(app, async (baseUrl) => {
      const { response, payload } = await postJson(`${baseUrl}/reply`, {
        text: "debug this function",
        modelProfile: "coding",
      });
      assert.equal(response.status, 200);
      assert.equal(payload.reply, "plain coding reply");
    });
  });
});

test("reply continues when optional market context fails", async () => {
  const app = createApp({
    capabilities: [
      fakeContextCapability("stockMarket", async () => {
        throw new Error("Alpha Vantage API key is not configured");
      }),
    ],
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

test("reply falls through the whole plugin chain when nothing contributes context", async () => {
  const calls = [];
  const app = createApp({
    capabilities: [
      fakeContextCapability("ffxivMarket", async () => {
        calls.push("ffxivMarket");
        return "";
      }),
      fakeContextCapability("stockMarket", async () => {
        calls.push("stockMarket");
        return "";
      }),
    ],
    buildAssistantReply: async (transcript, screenText, marketText) => {
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
    assert.deepEqual(calls, ["ffxivMarket", "stockMarket"]);
  });
});

test("reply skips optional context builders when includeContext is false", async () => {
  let contextCalls = 0;
  const app = createApp({
    capabilities: [
      fakeContextCapability("ffxivMarket", async () => {
        contextCalls += 1;
        return "craft or universalis context";
      }),
      fakeContextCapability("stockMarket", async () => {
        contextCalls += 1;
        return "market context";
      }),
    ],
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
    capabilities: [
      fakeContextCapability("webAccess", async (text) => {
        assert.equal(text, "search for FFXIV patch notes");
        return "Web search results:\n1. Patch Notes\n   https://example.com\n   ...\n\n";
      }),
    ],
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
    capabilities: [
      fakeContextCapability("webAccess", async () => {
        webContextCalls += 1;
        return "Web search results:\n...";
      }),
    ],
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

async function withIdleThresholdMs(value, fn) {
  const original = process.env.MANA_IDLE_THRESHOLD_MS;
  process.env.MANA_IDLE_THRESHOLD_MS = String(value);
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.MANA_IDLE_THRESHOLD_MS;
    else process.env.MANA_IDLE_THRESHOLD_MS = original;
  }
}

test("idle-report does not trigger consolidation below the idle threshold", async () => {
  let triggerCalls = 0;
  const app = createApp({
    triggerIdleConsolidation: async () => {
      triggerCalls += 1;
    },
    getGamingStatus: () => ({ gamingAppRunning: false }),
  });

  await withIdleThresholdMs(60000, async () => {
    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/internal/idle-report`, {
        idleSeconds: 5,
      });
      assert.equal(payload.idleTriggered, false);
    });
  });

  assert.equal(triggerCalls, 0);
});

test("idle-report triggers consolidation once idle time crosses the threshold", async () => {
  let triggerCalls = 0;
  const app = createApp({
    triggerIdleConsolidation: async () => {
      triggerCalls += 1;
    },
    getGamingStatus: () => ({ gamingAppRunning: false }),
  });

  await withIdleThresholdMs(1000, async () => {
    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/internal/idle-report`, {
        idleSeconds: 5,
      });
      assert.equal(payload.idleTriggered, true);
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  assert.equal(triggerCalls, 1);
});

test("idle-report does not re-trigger on repeated reports during the same idle period", async () => {
  let triggerCalls = 0;
  const app = createApp({
    triggerIdleConsolidation: async () => {
      triggerCalls += 1;
    },
    getGamingStatus: () => ({ gamingAppRunning: false }),
  });

  await withIdleThresholdMs(1000, async () => {
    await withServer(app, async (baseUrl) => {
      await postJson(`${baseUrl}/internal/idle-report`, { idleSeconds: 5 });
      const { payload } = await postJson(`${baseUrl}/internal/idle-report`, {
        idleSeconds: 10,
      });
      assert.equal(payload.idleTriggered, false);
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  assert.equal(triggerCalls, 1);
});

test("idle-report fires again after the user goes active and idles out a second time", async () => {
  let triggerCalls = 0;
  const app = createApp({
    triggerIdleConsolidation: async () => {
      triggerCalls += 1;
    },
    getGamingStatus: () => ({ gamingAppRunning: false }),
  });

  await withIdleThresholdMs(1000, async () => {
    await withServer(app, async (baseUrl) => {
      await postJson(`${baseUrl}/internal/idle-report`, { idleSeconds: 5 });
      await postJson(`${baseUrl}/internal/idle-report`, { idleSeconds: 0 });
      const { payload } = await postJson(`${baseUrl}/internal/idle-report`, {
        idleSeconds: 5,
      });
      assert.equal(payload.idleTriggered, true);
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  assert.equal(triggerCalls, 2);
});

test("formatMemoryMarkdown renders a placeholder with no summary or facts", () => {
  const md = formatMemoryMarkdown("", []);
  assert.match(md, /_\(no summary yet\)_/);
  assert.doesNotMatch(md, /## Key Facts/);
});

test("formatMemoryMarkdown renders the compacted summary and key facts", () => {
  const md = formatMemoryMarkdown("User prefers concise replies.", [
    "Likes FFXIV crafting",
    "Uses windows-launcher",
  ]);
  assert.match(md, /## Summary\n\nUser prefers concise replies\./);
  assert.match(md, /## Key Facts\n\n- Likes FFXIV crafting\n- Uses windows-launcher/);
});

test("formatMemoryMarkdown omits the Connections section when there are none (issue #75)", () => {
  const md = formatMemoryMarkdown("Summary text.", ["a fact"]);
  assert.doesNotMatch(md, /## Connections/);
});

test("formatMemoryMarkdown renders connections in their own section, separate from facts (issue #75)", () => {
  const md = formatMemoryMarkdown(
    "Summary text.",
    ["a fact"],
    ["Summary #1 <-> Summary #3: both discuss the FFXIV Weaver crafting rotation."],
  );
  assert.match(
    md,
    /## Connections\n\n- Summary #1 <-> Summary #3: both discuss the FFXIV Weaver crafting rotation\./,
  );
  // Connections must stay a distinct section, not folded into Key Facts.
  const factsIndex = md.indexOf("## Key Facts");
  const connectionsIndex = md.indexOf("## Connections");
  assert.ok(factsIndex > -1 && connectionsIndex > factsIndex);
});

test("buildMemoryNotes creates one note per entity, empty otherwise", () => {
  const notes = buildMemoryNotes(
    { "acme corp": [{ sessionId: "s1", at: "2026-07-01", display: "Acme Corp" }] },
    [],
    [],
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0].slug, "acme-corp");
  assert.equal(notes[0].title, "Acme Corp");
  assert.match(notes[0].body, /# Acme Corp/);
  assert.match(notes[0].body, /session `s1`/);
  assert.deepEqual(notes[0].links, []);
});

test("buildMemoryNotes links entities that co-occur in the same session", () => {
  const notes = buildMemoryNotes(
    {
      "acme corp": [{ sessionId: "s1", at: "t1", display: "Acme Corp" }],
      "jane doe": [{ sessionId: "s1", at: "t1", display: "Jane Doe" }],
      "unrelated topic": [{ sessionId: "s2", at: "t2", display: "Unrelated Topic" }],
    },
    [],
    [],
  );
  const acme = notes.find((n) => n.slug === "acme-corp");
  const jane = notes.find((n) => n.slug === "jane-doe");
  const unrelated = notes.find((n) => n.slug === "unrelated-topic");

  assert.deepEqual(acme.links, ["jane-doe"]);
  assert.deepEqual(jane.links, ["acme-corp"]);
  assert.match(acme.body, /\[\[jane-doe\]\]/);
  assert.deepEqual(unrelated.links, []);
});

test("buildMemoryNotes creates a Key Facts note linking to mentioned entities", () => {
  const notes = buildMemoryNotes(
    { "ffxiv": [{ sessionId: "s1", at: "t1", display: "FFXIV" }] },
    ["Plays FFXIV on weekends", "Prefers concise replies"],
    [],
  );
  const facts = notes.find((n) => n.slug === "key-facts");
  assert.ok(facts);
  assert.match(facts.body, /- Plays FFXIV on weekends \(\[\[ffxiv\]\]\)/);
  assert.match(facts.body, /- Prefers concise replies\n/);
});

test("buildMemoryNotes creates a Connections note verbatim, and omits empty sections", () => {
  const notes = buildMemoryNotes({}, [], [
    "Summary #1 <-> Summary #3: both discuss the same crafting rotation.",
  ]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].slug, "connections");
  assert.match(notes[0].body, /both discuss the same crafting rotation/);
});

test("createApp wires the memory inbox watcher with a usable appendTurn/runVisionReply/runWhisper", async () => {
  let capturedOptions = null;
  createApp({
    startMemoryInboxWatcher: (options) => {
      capturedOptions = options;
    },
  });

  assert.ok(capturedOptions, "watcher start was called");
  assert.equal(typeof capturedOptions.inboxDir, "string");
  assert.equal(typeof capturedOptions.appendTurn, "function");
  assert.equal(typeof capturedOptions.runVisionReply, "function");
  assert.equal(typeof capturedOptions.runWhisper, "function");
});
