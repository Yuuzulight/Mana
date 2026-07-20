# Plugins

Self-contained, optional features that node-bot wires into itself at
startup instead of hardcoding into `server.js`/`server-routes.js`. Each
plugin is its own package (own `package.json`, tests, README) so it can be
read, tested, and reasoned about without the rest of the backend.

## Available plugins

- [`ffxiv-market`](ffxiv-market/): Universalis market-board prices and
  Garland/XIVAPI craft-profitability lookups for Final Fantasy XIV.
- [`stock-market`](stock-market/): real-world stock quotes, comparisons,
  and watchlist summaries via Alpha Vantage.
- [`job-applications`](job-applications/): local job-application tracker
  plus a reusable answer knowledge base (resume bullets, project
  descriptions, canned Q&A), and a `POST /jobs/match` flow that tailors a
  resume/cover letter from a pasted posting. No LinkedIn or other
  third-party integration, and never auto-submits anywhere -- local storage
  only, prep for you to send by hand.
- [`job-search-adzuna`](job-search-adzuna/): live job postings via the
  Adzuna API (search-only -- no auto-apply, no scraping). Paste a result's
  description into job-applications' `POST /jobs/match` for a tailored
  resume/cover letter; the two plugins are independent.

All four are always loaded (no separate install step). FFXIV/stock-market/
job-search-adzuna are effectively opt-in since their routes/prompt-context
return nothing useful without network access (FFXIV) or an API key
(`ALPHA_VANTAGE_API_KEY` for stock market, `ADZUNA_APP_ID`/`ADZUNA_APP_KEY`
for job search); job-applications works out of the box since it's pure
local storage (its `/jobs/match` tailoring still needs a local model
configured). `GET /plugins` on the running backend lists everything
currently loaded, grouped by category.

## The plugin shape

A plugin's `index.js` exports:

```js
{
  key,                 // stable identifier, e.g. "stockMarket"
  name,                 // display name for GET /plugins
  category,             // groups plugins in GET /plugins, e.g. "Market Data"
  description,          // one line, shown in GET /plugins
  registerRoutes(app, context) {},        // optional: mount Express routes
  getHealth(context) {},                  // optional: contributes to GET /health's components
  contributePromptContext(text, context) {}, // optional: inject context into chat replies
}
```

All four hooks are optional except `key` — a plugin that only wants to show
up in `GET /plugins` can supply just `key`/`name`/`category`/`description`.

`node-bot/server.js` builds a `capabilities` array containing every
plugin/capability and a shared `context` object (API clients, config
values, etc.), then:

- `capabilities/registry.js`'s `registerCapabilities(app, capabilities, context)`
  calls each plugin's `registerRoutes(app, context)`.
- `buildCapabilityHealth(capabilities, context)` calls each plugin's
  `getHealth(context)` to build `GET /health`'s `components` object.
- `contributePluginPromptContext(capabilities, text, context)` tries each
  plugin's `contributePromptContext(text, context)` **in array order**,
  returning the first non-empty result — this is how a chat message like
  "what's NVDA trading at" gets real market data injected into Mana's
  reply without `server-routes.js` needing to know stock-market exists.
  A plugin that isn't relevant to the given text should return `""` (or
  throw — the loop swallows errors and logs a warning, then moves on to
  the next plugin) rather than always contributing something.

See [`ffxiv-market/index.js`](ffxiv-market/index.js) and
[`stock-market/index.js`](stock-market/index.js) for real examples,
including how `contributePromptContext` self-guards on whether the text is
actually relevant before doing any real work.

## Adding a plugin

1. New directory under `plugins/` with its own `package.json` (`private:
   true`, `main: "index.js"`, `scripts.test: "node --test test/"`) and
   `test/`.
2. `index.js` exports the shape above.
3. Add it to the `capabilities` array in `node-bot/server.js` (and to
   `capabilityContext` if it needs config/clients only your plugin uses).
4. If it needs deps also used by `node-bot` directly (like `express`),
   reference `node-bot/node_modules` rather than adding a duplicate copy —
   see the comment in `ffxiv-market/test/ffxiv-market-capability.test.js`.
