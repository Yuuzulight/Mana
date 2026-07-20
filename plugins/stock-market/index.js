const marketData = require("./market-data");

function registerStockMarketRoutes(app, deps) {
  const { marketDataClient } = deps;

  app.get("/market/stock/summary", async (req, res) => {
    try {
      const symbol =
        typeof req.query.symbol === "string" ? req.query.symbol : "";
      const summary = await marketDataClient.getStockSummary(symbol);
      return res.json({
        ...summary,
        disclaimer: "Market analysis only. Not financial advice.",
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/market/stock/compare", async (req, res) => {
    try {
      const symbols =
        typeof req.query.symbols === "string" ? req.query.symbols : "";
      const results = await marketDataClient.compareStocks(symbols);
      return res.json({
        source: "Alpha Vantage",
        symbols: results.map((item) => item.symbol),
        results,
        disclaimer: "Market analysis only. Not financial advice.",
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/market/watchlist", async (req, res) => {
    try {
      const results = await marketDataClient.getWatchlistSummary();
      return res.json({
        source: "Alpha Vantage",
        symbols: results.map((item) => item.symbol),
        results,
        disclaimer: "Market analysis only. Not financial advice.",
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
}

// This is Mana's plugin entry point convention: everything market-data.js
// exports (Alpha Vantage client + prompt-context helpers), plus the route
// registration + metadata a plugin needs to show up in GET /plugins and get
// wired into node-bot's capabilities array. See plugins/README.md.
module.exports = {
  ...marketData,
  key: "stockMarket",
  name: "Stock Market Data",
  category: "Market Data",
  description:
    "Real-world stock quotes, comparisons, and watchlist summaries via Alpha Vantage, plus market-analysis context for Mana's replies.",
  registerRoutes: registerStockMarketRoutes,
  getHealth: (context) => ({
    status: context.marketDataClient.isConfigured ? "configured" : "unconfigured",
    configured: context.marketDataClient.isConfigured,
    message: context.marketDataClient.isConfigured
      ? "Alpha Vantage API key is configured."
      : "Set ALPHA_VANTAGE_API_KEY to enable real-world stock market data (see docs/API_KEYS.md).",
  }),
};
