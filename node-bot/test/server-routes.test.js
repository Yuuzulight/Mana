const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../server");

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

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
