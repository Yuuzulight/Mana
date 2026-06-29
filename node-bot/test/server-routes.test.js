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

test("ffxiv market rejects requests without item id or item name", async () => {
  let resolveCalls = 0;
  const app = createApp({
    resolveFfxivItemByName: async () => {
      resolveCalls += 1;
      return { itemId: 1, name: "Potion" };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ffxiv/market?itemId=abc`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, { error: "itemId or itemName is required" });
    assert.equal(resolveCalls, 0);
  });
});

test("ffxiv crafting profit rejects out of range limit", async () => {
  let searchCalls = 0;
  const app = createApp({
    findProfitableCrafts: async () => {
      searchCalls += 1;
      return { results: [] };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ffxiv/crafting/profit?limit=100`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, { error: "limit must be between 1 and 25" });
    assert.equal(searchCalls, 0);
  });
});

test("ffxiv crafting profit accepts valid query normalization", async () => {
  let received = null;
  const app = createApp({
    findProfitableCrafts: async (options) => {
      received = options;
      return { results: [] };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/ffxiv/crafting/profit?limit=10&useSalesHistory=true&gatherableOnly=1&historyDays=30&minUnitsSold=5`,
    );

    assert.equal(response.status, 200);
    assert.equal(received.limit, 10);
    assert.equal(received.useSalesHistory, true);
    assert.equal(received.gatherableOnly, true);
    assert.equal(received.historyDays, 30);
    assert.equal(received.minUnitsSold, 5);
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
