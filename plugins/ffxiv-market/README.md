# FFXIV Market & Crafting (Mana plugin)

Universalis market-board prices and Garland Tools/XIVAPI craft-profitability
lookups for Final Fantasy XIV, so Mana can answer "how much does X sell for"
and "what's profitable to craft right now" questions.

- `GET /ffxiv/market?itemName=...&world=...` — current listings + recent
  sales for one item.
- `GET /ffxiv/crafting/profit?query=...&world=...` — ranked profitable
  crafts, optionally filtered to gatherable-only materials.
- `POST /ffxiv/market/from-screen` — resolves an item hovered on-screen
  (via OCR text) and looks up its price.

Also contributes prompt context directly into Mana's chat replies when a
message looks like a market or crafting-profit question, via
`contributePromptContext` (craft-profit checked before a plain market
lookup) — see [../README.md](../README.md) for how the plugin hook works.

No API keys required — Universalis, Garland Tools, and XIVAPI are all
public, unauthenticated APIs. Optional env vars (`UNIVERSALIS_API_URL`,
`FFXIV_RECIPE_SOURCE`, `XIVAPI_RECIPE_SCAN_LIMIT`, etc.) are documented at
the top of `ffxiv-market.js`.

## Dev

```bash
npm test    # pure-logic tests, no running Mana server needed
```
