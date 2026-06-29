const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const test = require("node:test");

const { ffxivMarketCapability } = require("../capabilities/ffxiv-market-capability");

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

test("ffxiv capability market route rejects requests without item id or item name", async () => {
  let resolveCalls = 0;
  const app = express();
  app.use(express.json());
  ffxivMarketCapability.registerRoutes(app, {
    UNIVERSALIS_DEFAULT_WORLD: "Kujata",
    resolveFfxivItemByName: async () => {
      resolveCalls += 1;
      return { itemId: 1, name: "Potion" };
    },
    getUniversalisMarketSummary: async () => ({ itemId: 1 }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ffxiv/market?itemId=abc`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, { error: "itemId or itemName is required" });
    assert.equal(resolveCalls, 0);
  });
});

test("ffxiv capability crafting route normalizes valid query options", async () => {
  let received = null;
  const app = express();
  app.use(express.json());
  ffxivMarketCapability.registerRoutes(app, {
    UNIVERSALIS_DEFAULT_WORLD: "Kujata",
    FFXIV_PROFIT_TOP_LIMIT: 10,
    FFXIV_RECIPE_SOURCE: "garland",
    XIVAPI_RECIPE_PAGE_SIZE: 100,
    XIVAPI_RECIPE_SCAN_LIMIT: 500,
    findProfitableCrafts: async (options) => {
      received = options;
      return { results: [] };
    },
    logPerf: () => {},
    normalizeCraftRankingMode: (rankBy) => rankBy || "balanced",
    normalizeGatheringSourceFilter: (sources) => sources || ["normal"],
    normalizeGatheringJobFilter: (jobs) => jobs || ["MIN", "BTN"],
    nowMs: () => 1,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/ffxiv/crafting/profit?limit=10&useSalesHistory=true&gatherableOnly=1&historyDays=30&minUnitsSold=5`,
    );

    assert.equal(response.status, 200);
    assert.equal(received.world, "Kujata");
    assert.equal(received.limit, 10);
    assert.equal(received.useSalesHistory, true);
    assert.equal(received.gatherableOnly, true);
    assert.equal(received.historyDays, 30);
    assert.equal(received.minUnitsSold, 5);
  });
});

test("ffxiv capability from-screen route resolves hovered item names", async () => {
  const app = express();
  app.use(express.json());
  ffxivMarketCapability.registerRoutes(app, {
    UNIVERSALIS_DEFAULT_WORLD: "Kujata",
    extractExplicitItemNameFromText: () => "",
    extractHoveredItemName: () => "Iron Ore",
    resolveFfxivItemByName: async (name) => ({ itemId: 5114, name }),
    getUniversalisMarketSummary: async (world, itemId, itemName) => ({
      world,
      itemId,
      itemName,
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ffxiv/market/from-screen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ screenText: "hovered item" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.hoveredItemName, "Iron Ore");
    assert.equal(payload.itemId, 5114);
    assert.equal(payload.world, "Kujata");
  });
});

test("ffxiv capability contributes market health status", () => {
  assert.deepEqual(ffxivMarketCapability.getHealth(), {
    status: "configured",
    configured: true,
    message: "FFXIV market providers are configured from local defaults.",
    universalisConfigured: true,
    xivapiConfigured: true,
  });
});
