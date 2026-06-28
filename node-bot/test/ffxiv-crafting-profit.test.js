const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatCraftRankingDetails,
  getCraftMarketabilityRequirement,
  getCraftRankingValue,
  getGarlandNodeGatheringJob,
  getGarlandNodeGatheringSources,
  isIgnoredGatheringMaterial,
  materialPassesGatheringFilters,
  normalizeCraftRankingMode,
  normalizeGatheringSourceFilter,
  resolveGatherableRecipeMaterials,
  summarizeSalesHistory,
  getSalesHistoryAdjustedPrice,
} = require("../server");

const now = Date.parse("2026-06-28T00:00:00.000Z");
const dayMs = 24 * 60 * 60 * 1000;

test("summarizeSalesHistory only counts sales within the requested day window", () => {
  const summary = summarizeSalesHistory(
    [
      { pricePerUnit: 1000, quantity: 1, timestamp: Math.floor((now - dayMs) / 1000) },
      { pricePerUnit: 1200, quantity: 2, timestamp: Math.floor((now - 15 * dayMs) / 1000) },
      { pricePerUnit: 999999, quantity: 1, timestamp: Math.floor((now - 45 * dayMs) / 1000) },
    ],
    { now, historyDays: 30 },
  );

  assert.equal(summary.salesCount, 2);
  assert.equal(summary.unitsSold, 3);
  assert.equal(summary.medianSalePrice, 1100);
  assert.equal(summary.averageSalePrice, 1100);
});

test("getCraftMarketabilityRequirement gives expensive items more sales leeway", () => {
  assert.equal(getCraftMarketabilityRequirement(99_999).minimumSales, 20);
  assert.equal(getCraftMarketabilityRequirement(100_000).minimumSales, 8);
  assert.equal(getCraftMarketabilityRequirement(1_000_000).minimumSales, 3);
  assert.equal(getCraftMarketabilityRequirement(10_000_000).minimumSales, 1);
});

test("getSalesHistoryAdjustedPrice rejects low-value slow sellers", () => {
  const result = getSalesHistoryAdjustedPrice({
    currentListingPrice: 70_000,
    materialCost: 10_000,
    amountResult: 1,
    salesHistory: Array.from({ length: 3 }, (_, index) => ({
      pricePerUnit: 65_000 + index,
      quantity: 1,
      timestamp: Math.floor((now - index * dayMs) / 1000),
    })),
    historyDays: 30,
    now,
  });

  assert.equal(result.marketabilityPassed, false);
  assert.equal(result.reason, "insufficient_sales");
});

test("getSalesHistoryAdjustedPrice allows expensive slow sellers and uses median sale price cap", () => {
  const result = getSalesHistoryAdjustedPrice({
    currentListingPrice: 999_999_999,
    materialCost: 2_000,
    amountResult: 1,
    salesHistory: [
      { pricePerUnit: 9_000_000, quantity: 1, timestamp: Math.floor((now - dayMs) / 1000) },
      { pricePerUnit: 11_000_000, quantity: 1, timestamp: Math.floor((now - 2 * dayMs) / 1000) },
      { pricePerUnit: 13_000_000, quantity: 1, timestamp: Math.floor((now - 3 * dayMs) / 1000) },
    ],
    historyDays: 30,
    now,
  });

  assert.equal(result.marketabilityPassed, true);
  assert.equal(result.estimatedUnitPrice, 11_000_000);
  assert.equal(result.estimatedRevenue, 11_000_000);
  assert.equal(result.estimatedProfit, 10_998_000);
  assert.equal(result.salesSummary.salesCount, 3);
});

test("normalizeCraftRankingMode defaults sales-history scans to balanced ranking", () => {
  assert.equal(normalizeCraftRankingMode(undefined, true), "balanced");
  assert.equal(normalizeCraftRankingMode(undefined, false), "profit");
  assert.equal(normalizeCraftRankingMode("salesVelocity", true), "salesVelocity");
  assert.equal(normalizeCraftRankingMode("profit", true), "profit");
  assert.equal(normalizeCraftRankingMode("unknown", true), "balanced");
});

test("getCraftRankingValue can rank by profit, sales velocity, or balanced monthly profit", () => {
  const candidate = {
    profit: 2_000,
    salesHistory: {
      unitsSold: 12,
    },
  };

  assert.equal(getCraftRankingValue(candidate, "profit"), 2_000);
  assert.equal(getCraftRankingValue(candidate, "salesVelocity"), 12);
  assert.equal(getCraftRankingValue(candidate, "balanced"), 24_000);
});

test("balanced ranking favors frequent lower-profit crafts over rare higher-profit crafts", () => {
  const rareHighProfit = {
    itemName: "Rare high-profit craft",
    profit: 100_000,
    salesHistory: {
      unitsSold: 1,
    },
  };
  const frequentLowerProfit = {
    itemName: "Frequent lower-profit craft",
    profit: 30_000,
    salesHistory: {
      unitsSold: 10,
    },
  };

  const ranked = [rareHighProfit, frequentLowerProfit].sort(
    (left, right) =>
      getCraftRankingValue(right, "balanced") -
      getCraftRankingValue(left, "balanced"),
  );

  assert.equal(ranked[0].itemName, "Frequent lower-profit craft");
});

test("formatCraftRankingDetails includes balanced ranking context", () => {
  const details = formatCraftRankingDetails({
    estimatedMonthlyProfit: 24_999_500,
    salesHistory: {
      historyDays: 30,
      salesCount: 5,
      unitsSold: 5,
    },
  });

  assert.match(details, /24999500 gil estimated 30d profit/);
  assert.match(details, /5 units sold/);
});

test("isIgnoredGatheringMaterial ignores shards, crystals, and clusters", () => {
  assert.equal(isIgnoredGatheringMaterial({ itemId: 2, itemName: "Fire Shard" }), true);
  assert.equal(isIgnoredGatheringMaterial({ itemId: 8, itemName: "Fire Crystal" }), true);
  assert.equal(isIgnoredGatheringMaterial({ itemId: 14, itemName: "Fire Cluster" }), true);
  assert.equal(isIgnoredGatheringMaterial({ itemId: 5106, itemName: "Copper Ore" }), false);
});

test("normalizeGatheringSourceFilter defaults to normal nodes", () => {
  assert.deepEqual(normalizeGatheringSourceFilter(undefined), ["normal"]);
  assert.deepEqual(normalizeGatheringSourceFilter("timed,legendary"), [
    "timed",
    "legendary",
  ]);
  assert.deepEqual(normalizeGatheringSourceFilter("all"), [
    "normal",
    "timed",
    "legendary",
    "ephemeral",
    "folklore",
  ]);
});

test("getGarlandNodeGatheringSources classifies normal and special nodes", () => {
  assert.deepEqual(getGarlandNodeGatheringSources({ t: 0 }), ["normal"]);
  assert.deepEqual(getGarlandNodeGatheringSources({ t: 0, lt: "Unspoiled" }), [
    "timed",
  ]);
  assert.deepEqual(getGarlandNodeGatheringSources({ t: 1, lt: "Legendary" }), [
    "legendary",
  ]);
  assert.deepEqual(getGarlandNodeGatheringSources({ t: 2, lt: "Ephemeral" }), [
    "ephemeral",
  ]);
  assert.deepEqual(
    getGarlandNodeGatheringSources({ t: 0, lt: "Legendary" }, { unlockId: 42 }),
    ["legendary", "folklore"],
  );
});

test("getGarlandNodeGatheringJob maps Garland node type to mining or botany", () => {
  assert.equal(getGarlandNodeGatheringJob({ t: 0 }), "mining");
  assert.equal(getGarlandNodeGatheringJob({ t: 1 }), "mining");
  assert.equal(getGarlandNodeGatheringJob({ t: 2 }), "botany");
  assert.equal(getGarlandNodeGatheringJob({ t: 3 }), "botany");
  assert.equal(getGarlandNodeGatheringJob({ t: 99 }), null);
});

test("materialPassesGatheringFilters excludes special sources unless included", () => {
  const normalOre = {
    itemId: 5106,
    itemName: "Copper Ore",
    nodes: [{ t: 0 }],
  };
  const timedOre = {
    itemId: 5121,
    itemName: "Darksteel Ore",
    nodes: [{ t: 0, lt: "Unspoiled" }],
  };
  const legendaryOre = {
    itemId: 36179,
    itemName: "Rhodium Sand",
    unlockId: 123,
    nodes: [{ t: 1, lt: "Legendary" }],
  };

  assert.equal(materialPassesGatheringFilters(normalOre).passes, true);
  assert.equal(materialPassesGatheringFilters(timedOre).passes, false);
  assert.equal(
    materialPassesGatheringFilters(timedOre, {
      allowedGatheringSources: ["normal", "timed"],
    }).passes,
    true,
  );
  assert.equal(
    materialPassesGatheringFilters(legendaryOre, {
      allowedGatheringSources: ["normal", "legendary"],
    }).passes,
    true,
  );
  assert.equal(
    materialPassesGatheringFilters(legendaryOre, {
      allowedGatheringSources: ["normal", "folklore"],
    }).passes,
    true,
  );
});

test("resolveGatherableRecipeMaterials expands intermediates and ignores crystals", async () => {
  const docs = new Map([
    [
      5062,
      {
        item: {
          id: 5062,
          name: "Copper Ingot",
          craft: [
            {
              yield: 1,
              ingredients: [
                { id: 5106, amount: 3 },
                { id: 2, amount: 1 },
              ],
            },
          ],
        },
        partials: [{ type: "node", obj: { i: 153, n: "Spineless Basin", t: 0, l: 5 } }],
      },
    ],
    [
      5106,
      {
        item: { id: 5106, name: "Copper Ore", nodes: [153] },
        partials: [{ type: "node", obj: { i: 153, n: "Spineless Basin", t: 0, l: 5 } }],
      },
    ],
    [
      5258,
      {
        item: {
          id: 5258,
          name: "Ragstone Whetstone",
          craft: [
            {
              yield: 1,
              ingredients: [
                { id: 5228, amount: 2 },
                { id: 2, amount: 1 },
              ],
            },
          ],
        },
        partials: [{ type: "node", obj: { i: 194, n: "Black Brush", t: 1, l: 15 } }],
      },
    ],
    [
      5228,
      {
        item: { id: 5228, name: "Ragstone", nodes: [194] },
        partials: [{ type: "node", obj: { i: 194, n: "Black Brush", t: 1, l: 15 } }],
      },
    ],
  ]);

  const result = await resolveGatherableRecipeMaterials(
    {
      resultItemName: "Copper Earrings",
      ingredients: [
        { itemId: 5062, itemName: "Copper Ingot", quantity: 1 },
        { itemId: 5258, itemName: "Ragstone Whetstone", quantity: 1 },
        { itemId: 2, itemName: "Fire Shard", quantity: 1 },
      ],
    },
    {
      getItemDoc: async (itemId) => docs.get(itemId),
      allowedGatheringSources: ["normal"],
      allowedGatheringJobs: ["mining", "botany"],
    },
  );

  assert.equal(result.passes, true);
  assert.deepEqual(
    result.materials.map((material) => ({
      itemId: material.itemId,
      itemName: material.itemName,
      quantity: material.quantity,
    })),
    [
      { itemId: 5106, itemName: "Copper Ore", quantity: 3 },
      { itemId: 5228, itemName: "Ragstone", quantity: 2 },
    ],
  );
});

test("resolveGatherableRecipeMaterials reports missing doc fetcher instead of throwing", async () => {
  const result = await resolveGatherableRecipeMaterials({
    ingredients: [{ itemId: 5106, itemName: "Copper Ore", quantity: 1 }],
  });

  assert.equal(result.passes, false);
  assert.equal(result.failures[0].reason, "missing_garland_item_doc_fetcher");
});
