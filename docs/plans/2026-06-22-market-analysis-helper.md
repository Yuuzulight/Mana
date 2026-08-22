# Market Analysis Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight stock-market analysis helper so Mana can summarize tickers, compare tickers, and summarize a configured watchlist.

**Architecture:** Add a focused `node-bot/market-data.js` module for ticker parsing, Alpha Vantage fetching, caching, formatting, and prompt context. Wire the module into `node-bot/server.js` through small HTTP endpoints and the existing assistant reply flow.

**Tech Stack:** Node.js CommonJS, Express, built-in `node:test`, Alpha Vantage REST API, environment-variable configuration.

---

### Task 1: Market Data Module Tests

**Files:**
- Create: `node-bot/test/market-data.test.js`
- Create: `node-bot/market-data.js`
- Modify: `node-bot/package.json`

- [ ] **Step 1: Write failing tests**

Create tests for ticker normalization, market-question detection, summary formatting, cache reuse, and invalid API responses.

- [ ] **Step 2: Run tests to verify red**

Run: `cd node-bot; npm test`

Expected: fail because `node-bot/market-data.js` does not exist yet.

- [ ] **Step 3: Implement market module**

Add `createMarketDataClient`, `parseTickerList`, `isMarketQuestion`, and `buildMarketContextForPrompt`.

- [ ] **Step 4: Run tests to verify green**

Run: `cd node-bot; npm test`

Expected: all market module tests pass.

### Task 2: Backend Endpoints

**Files:**
- Modify: `node-bot/server.js`

- [ ] **Step 1: Wire routes**

Add:
- `GET /market/stock/summary?symbol=NVDA`
- `GET /market/stock/compare?symbols=NVDA,AMD`
- `GET /market/watchlist`

- [ ] **Step 2: Wire assistant context**

When a transcript looks like a market question, fetch compact market context and append it to the assistant prompt context before reply generation.

- [ ] **Step 3: Verify syntax**

Run: `cd node-bot; node --check server.js`

Expected: no syntax errors.

### Task 3: Documentation

**Files:**
- Modify: `node-bot/README.md`
- Modify: `docs/quick_start_windows.md`
- Modify: `docs/market_analysis_helper.md`

- [ ] **Step 1: Document env vars**

Document `MARKET_PROVIDER`, `ALPHA_VANTAGE_API_KEY`, `MARKET_WATCHLIST`, and `MARKET_CACHE_MS`.

- [ ] **Step 2: Document examples**

Add endpoint examples and voice prompt examples.

- [ ] **Step 3: Document limitations**

State that Mana provides analysis only, not financial advice or trading automation.

### Task 4: Verification And Commit

**Files:**
- All changed files from Tasks 1-3

- [ ] **Step 1: Run tests**

Run: `cd node-bot; npm test`

Expected: tests pass.

- [ ] **Step 2: Run syntax check**

Run: `cd node-bot; node --check server.js`

Expected: no syntax errors.

- [ ] **Step 3: Inspect staged diff**

Run: `git diff --cached --stat`

Expected: only source/docs/test/package files are staged.

- [ ] **Step 4: Commit and push**

Commit message: `Add market analysis helper MVP`

Push branch: `feature/market-analysis-helper`

## Self Review

- Spec coverage: The plan covers ticker summaries, comparisons, watchlist summaries, API-key environment handling, caching, docs, and safety boundaries.
- Placeholder scan: No implementation placeholders are left for the scoped MVP.
- Type consistency: The planned module functions are named consistently across tests, server wiring, and docs.
