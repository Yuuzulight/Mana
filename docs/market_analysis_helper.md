# Mana Market Analysis Helper

Mana's market feature should help explain public stock-market data from normal
voice or text prompts. It should stay focused on analysis and never place trades.

## Quick rundown

- Use a market-data API for prices, company data, and news.
- Use SEC EDGAR for official filing context when it is useful.
- Cache API results so Mana does not hit rate limits or slow down replies.
- Let Mana answer simple prompts like `summarize NVDA today`.
- Let Mana compare tickers and summarize a small watchlist.
- Keep every response framed as analysis, not financial advice.

## First version

The first version should be small and reliable:

- `GET /market/stock/summary?symbol=NVDA`
- `GET /market/stock/compare?symbols=NVDA,AMD`
- `GET /market/watchlist`

The backend should collect structured data first, then pass a compact summary
into Mana's normal reply flow. That keeps the language model from guessing
numbers and makes the feature easier to test.

## Data sources

Start with one primary provider to avoid complexity.

- Alpha Vantage is the simplest first choice for daily prices, indicators, and
  company overview data.
- Finnhub is a good second option if Mana needs broader market news later.
- SEC EDGAR should be used for official filings, especially 10-K, 10-Q, and 8-K
  summaries.

API keys must come from environment variables. They should never be written into
launcher scripts or committed to the repository.

## Safety boundaries

Mana can explain market data, compare companies, and summarize risks. Mana
should not:

- Place trades.
- Connect to a brokerage account.
- Tell the user that a trade is guaranteed.
- Present scraped or stale data as real-time data.

## Performance notes

Market analysis should stay lightweight while games are running:

- Cache quote and overview responses.
- Avoid background polling unless the user enables a watchlist refresh mode.
- Keep large filing analysis on demand only.
- Prefer short summaries over large raw payloads in prompts.

Related issue: #6
