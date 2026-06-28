const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatCraftRankingDetails,
  getCraftMarketabilityRequirement,
  getCraftRankingValue,
  normalizeCraftRankingMode,
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
