const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildMarketContextForPrompt,
  createMarketDataClient,
  isMarketQuestion,
  parseTickerList,
} = require("../market-data");

test("parseTickerList normalizes symbols and removes duplicates", () => {
  assert.deepEqual(parseTickerList(" nvda, AMD msft, nvda "), [
    "NVDA",
    "AMD",
    "MSFT",
  ]);
});

test("isMarketQuestion detects stock analysis prompts", () => {
  assert.equal(isMarketQuestion("Mana, summarize NVDA today"), true);
  assert.equal(isMarketQuestion("compare AMD and Nvidia stock"), true);
  assert.equal(isMarketQuestion("what is my FFXIV marketboard price"), false);
});

test("getStockSummary fetches and formats Alpha Vantage data", async () => {
  const calls = [];
  const client = createMarketDataClient({
    apiKey: "demo-key",
    now: () => 1000,
    fetchJson: async (url) => {
      calls.push(url.toString());
      if (url.searchParams.get("function") === "GLOBAL_QUOTE") {
        return {
          "Global Quote": {
            "01. symbol": "NVDA",
            "05. price": "128.50",
            "09. change": "1.25",
            "10. change percent": "0.98%",
            "06. volume": "123456",
            "07. latest trading day": "2026-06-22",
            "08. previous close": "127.25",
          },
        };
      }
      return {
        Symbol: "NVDA",
        Name: "NVIDIA Corporation",
        Exchange: "NASDAQ",
        Sector: "Technology",
        MarketCapitalization: "3100000000000",
        PERatio: "45.5",
      };
    },
  });

  const summary = await client.getStockSummary("nvda");

  assert.equal(summary.symbol, "NVDA");
  assert.equal(summary.name, "NVIDIA Corporation");
  assert.equal(summary.price, 128.5);
  assert.equal(summary.changePercent, "0.98%");
  assert.equal(summary.volume, 123456);
  assert.match(summary.summaryText, /NVDA/);
  assert.match(summary.summaryText, /128\.50/);
  assert.equal(calls.length, 2);
});

test("getStockSummary reuses cached summary within cache window", async () => {
  let fetchCount = 0;
  const client = createMarketDataClient({
    apiKey: "demo-key",
    cacheMs: 300000,
    now: () => 1000,
    fetchJson: async (url) => {
      fetchCount += 1;
      if (url.searchParams.get("function") === "GLOBAL_QUOTE") {
        return {
          "Global Quote": {
            "01. symbol": "AAPL",
            "05. price": "200",
            "09. change": "2",
            "10. change percent": "1.00%",
          },
        };
      }
      return { Symbol: "AAPL", Name: "Apple Inc.", Sector: "Technology" };
    },
  });

  await client.getStockSummary("AAPL");
  await client.getStockSummary("aapl");

  assert.equal(fetchCount, 2);
});

test("getStockSummary rejects missing API keys", async () => {
  const client = createMarketDataClient({
    apiKey: "",
    fetchJson: async () => {
      throw new Error("should not fetch without key");
    },
  });

  await assert.rejects(() => client.getStockSummary("MSFT"), /not configured/i);
});

test("buildMarketContextForPrompt builds compare context", async () => {
  const requestedSymbols = [];
  const client = createMarketDataClient({
    apiKey: "demo-key",
    fetchJson: async (url) => {
      const symbol =
        url.searchParams.get("symbol") || url.searchParams.get("keywords");
      requestedSymbols.push(symbol);
      if (url.searchParams.get("function") === "GLOBAL_QUOTE") {
        return {
          "Global Quote": {
            "01. symbol": symbol,
            "05. price": symbol === "NVDA" ? "128.50" : "164.25",
            "09. change": "1.25",
            "10. change percent": "0.98%",
          },
        };
      }
      return { Symbol: symbol, Name: `${symbol} Corp`, Sector: "Technology" };
    },
  });

  const context = await buildMarketContextForPrompt(
    "Mana, compare NVDA and AMD stocks",
    client,
  );

  assert.match(context, /Market analysis data:/);
  assert.match(context, /NVDA/);
  assert.match(context, /AMD/);
  assert.match(context, /not financial advice/i);
  assert.deepEqual([...new Set(requestedSymbols)], ["NVDA", "AMD"]);
});

test("buildMarketContextForPrompt maps common company names to tickers", async () => {
  const requestedSymbols = [];
  const client = createMarketDataClient({
    apiKey: "demo-key",
    fetchJson: async (url) => {
      const symbol = url.searchParams.get("symbol");
      requestedSymbols.push(symbol);
      if (url.searchParams.get("function") === "GLOBAL_QUOTE") {
        return {
          "Global Quote": {
            "01. symbol": symbol,
            "05. price": symbol === "NVDA" ? "128.50" : "164.25",
            "09. change": "1.25",
            "10. change percent": "0.98%",
          },
        };
      }
      return { Symbol: symbol, Name: `${symbol} Corp`, Sector: "Technology" };
    },
  });

  const context = await buildMarketContextForPrompt(
    "Mana, compare AMD and Nvidia stock",
    client,
  );

  assert.match(context, /AMD/);
  assert.match(context, /NVDA/);
  assert.deepEqual([...new Set(requestedSymbols)], ["AMD", "NVDA"]);
});
