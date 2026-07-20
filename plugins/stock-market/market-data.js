const https = require("https");

const DEFAULT_ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const DEFAULT_CACHE_MS = 300000;
const DEFAULT_WATCHLIST = ["NVDA", "AMD", "AAPL", "MSFT"];
const MARKET_WORD_SYMBOLS = {
  AMAZON: "AMZN",
  APPLE: "AAPL",
  GOOGLE: "GOOGL",
  MICROSOFT: "MSFT",
  NVIDIA: "NVDA",
  TESLA: "TSLA",
};
const MARKET_EXTRACTION_STOPWORDS = new Set([
  "A",
  "AN",
  "AND",
  "ANALYSIS",
  "ANALYZE",
  "COMPARE",
  "MARKET",
  "MANA",
  "MY",
  "PRICE",
  "STOCK",
  "STOCKS",
  "SUMMARIZE",
  "SUMMARY",
  "THE",
  "TODAY",
  "WATCHLIST",
]);

function parseTickerList(input) {
  return [
    ...new Set(
      String(input || "")
        .toUpperCase()
        .split(/[^A-Z0-9.\-]+/)
        .map((part) => part.trim())
        .filter((part) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(part)),
    ),
  ];
}

function isMarketQuestion(text) {
  const cleanText = String(text || "");
  if (/\b(ffxiv|universalis|marketboard|market board|gil)\b/i.test(cleanText)) {
    return false;
  }

  if (
    /\b(summarize|summary|compare|analyze|analysis|price|watchlist)\b/i.test(
      cleanText,
    ) &&
    parseTickerList(cleanText).length > 0
  ) {
    return true;
  }

  return /\b(stock|stocks|ticker|tickers|share|shares|equity|equities|nasdaq|nyse|market analysis|watchlist|portfolio|earnings|filing|sec|price action|volume|rsi|moving average|compare)\b/i.test(
    cleanText,
  );
}

function numberOrNull(value) {
  const parsed = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function compactNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "unknown";
  }

  const number = Number(value);
  if (Math.abs(number) >= 1_000_000_000_000) {
    return `${(number / 1_000_000_000_000).toFixed(2)}T`;
  }
  if (Math.abs(number) >= 1_000_000_000) {
    return `${(number / 1_000_000_000).toFixed(2)}B`;
  }
  if (Math.abs(number) >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(2)}M`;
  }
  return String(number);
}

function money(value) {
  return value === null || value === undefined ? "unknown" : value.toFixed(2);
}

function fetchJsonWithHttps(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 200)}`));
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${error.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

function formatSummaryText(summary) {
  const parts = [
    `${summary.symbol}${summary.name ? ` (${summary.name})` : ""}`,
    `price ${money(summary.price)}`,
  ];

  if (summary.change !== null || summary.changePercent) {
    parts.push(
      `change ${summary.change === null ? "unknown" : summary.change.toFixed(2)} (${summary.changePercent || "unknown"})`,
    );
  }

  if (summary.volume !== null) {
    parts.push(`volume ${compactNumber(summary.volume)}`);
  }

  if (summary.sector) {
    parts.push(`sector ${summary.sector}`);
  }

  if (summary.marketCap !== null) {
    parts.push(`market cap ${compactNumber(summary.marketCap)}`);
  }

  if (summary.peRatio !== null) {
    parts.push(`P/E ${summary.peRatio}`);
  }

  return `${parts.join("; ")}.`;
}

function createMarketDataClient(options = {}) {
  const apiKey = options.apiKey ?? process.env.ALPHA_VANTAGE_API_KEY ?? "";
  const baseUrl =
    options.baseUrl || process.env.ALPHA_VANTAGE_BASE_URL || DEFAULT_ALPHA_VANTAGE_URL;
  const cacheMs = Number(
    options.cacheMs ?? process.env.MARKET_CACHE_MS ?? DEFAULT_CACHE_MS,
  );
  const now = options.now || Date.now;
  const fetchJson = options.fetchJson || fetchJsonWithHttps;
  const watchlist = parseTickerList(
    options.watchlist ?? process.env.MARKET_WATCHLIST ?? DEFAULT_WATCHLIST.join(","),
  );
  const cache = new Map();

  async function alphaVantage(functionName, symbol) {
    if (!apiKey) {
      throw new Error("Alpha Vantage API key is not configured");
    }

    const url = new URL(baseUrl);
    url.searchParams.set("function", functionName);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("apikey", apiKey);
    return await fetchJson(url);
  }

  async function getStockSummary(inputSymbol) {
    const symbol = parseTickerList(inputSymbol)[0];
    if (!symbol) {
      throw new Error("A valid ticker symbol is required");
    }

    const cacheKey = `summary:${symbol}`;
    const cached = cache.get(cacheKey);
    if (cached && now() - cached.createdAt < cacheMs) {
      return cached.value;
    }

    const [quoteData, overviewData] = await Promise.all([
      alphaVantage("GLOBAL_QUOTE", symbol),
      alphaVantage("OVERVIEW", symbol),
    ]);
    const quote = quoteData?.["Global Quote"] || {};

    const price = numberOrNull(quote["05. price"]);
    if (price === null) {
      throw new Error(`No market quote found for ${symbol}`);
    }

    const summary = {
      source: "Alpha Vantage",
      symbol,
      name: overviewData?.Name || "",
      exchange: overviewData?.Exchange || "",
      sector: overviewData?.Sector || "",
      price,
      change: numberOrNull(quote["09. change"]),
      changePercent: quote["10. change percent"] || "",
      volume: numberOrNull(quote["06. volume"]),
      latestTradingDay: quote["07. latest trading day"] || "",
      previousClose: numberOrNull(quote["08. previous close"]),
      marketCap: numberOrNull(overviewData?.MarketCapitalization),
      peRatio: numberOrNull(overviewData?.PERatio),
    };
    summary.summaryText = formatSummaryText(summary);

    cache.set(cacheKey, {
      createdAt: now(),
      value: summary,
    });
    return summary;
  }

  async function compareStocks(symbols) {
    const tickerList = parseTickerList(symbols).slice(0, 5);
    if (tickerList.length < 2) {
      throw new Error("At least two ticker symbols are required for comparison");
    }
    return await Promise.all(tickerList.map((symbol) => getStockSummary(symbol)));
  }

  async function getWatchlistSummary() {
    const tickerList = watchlist.length ? watchlist.slice(0, 10) : DEFAULT_WATCHLIST;
    return await Promise.all(tickerList.map((symbol) => getStockSummary(symbol)));
  }

  return {
    compareStocks,
    getStockSummary,
    getWatchlistSummary,
    isConfigured: Boolean(apiKey),
    watchlist,
  };
}

function extractMarketTickers(text) {
  const symbols = [];
  for (const token of parseTickerList(text)) {
    const mappedSymbol = MARKET_WORD_SYMBOLS[token] || token;
    if (MARKET_EXTRACTION_STOPWORDS.has(token)) {
      continue;
    }
    if (!symbols.includes(mappedSymbol)) {
      symbols.push(mappedSymbol);
    }
  }
  return symbols.slice(0, 5);
}

async function buildMarketContextForPrompt(text, client) {
  if (!isMarketQuestion(text)) {
    return "";
  }

  const cleanText = String(text || "");
  let summaries;
  if (/\bwatchlist\b/i.test(cleanText)) {
    summaries = await client.getWatchlistSummary();
  } else if (/\b(compare|versus|vs\.?|against)\b/i.test(cleanText)) {
    summaries = await client.compareStocks(extractMarketTickers(cleanText));
  } else {
    const symbol = extractMarketTickers(cleanText)[0];
    if (!symbol) {
      return "";
    }
    summaries = [await client.getStockSummary(symbol)];
  }

  const lines = summaries.map((summary) => `- ${summary.summaryText}`);
  lines.push(
    "Use this as market analysis context only. This is not financial advice.",
  );
  return ["Market analysis data:", ...lines].join("\n");
}

module.exports = {
  buildMarketContextForPrompt,
  createMarketDataClient,
  isMarketQuestion,
  parseTickerList,
};
