# Stock Market Data (Mana plugin)

Real-world stock quotes via Alpha Vantage, so Mana can answer "what's NVDA
trading at" and "compare AMD and Nvidia stock" questions and check a
watchlist.

- `GET /market/stock/summary?symbol=...` — price, change, volume, sector,
  market cap, and P/E for one ticker.
- `GET /market/stock/compare?symbols=...` — the same summary for up to 5
  tickers.
- `GET /market/watchlist` — summary for the configured watchlist
  (`MARKET_WATCHLIST`, default `NVDA,AMD,AAPL,MSFT`).

Also contributes prompt context directly into Mana's chat replies when a
message looks like a stock-market question, via `contributePromptContext`
(self-guards on `isMarketQuestion`) — see [../README.md](../README.md) for
how the plugin hook works.

Requires `ALPHA_VANTAGE_API_KEY` (free tier at alphavantage.co). Without it,
the plugin reports "unconfigured" in `/health` and its routes/prompt
context return no data rather than failing the whole reply. Optional env
vars: `ALPHA_VANTAGE_BASE_URL`, `MARKET_CACHE_MS` (default 5 minutes),
`MARKET_WATCHLIST`.

## Dev

```bash
npm test    # pure-logic tests, no running Mana server needed
```
