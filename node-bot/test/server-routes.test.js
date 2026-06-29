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
