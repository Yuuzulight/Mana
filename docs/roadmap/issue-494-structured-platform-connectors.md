# Issue 494: Structured Data Connectors For High-Value Platforms

## Goal

Give Deep Research and chat context dedicated structured data sources for
platforms generic web search handles poorly, the same way Mana already
does for FFXIV market data, stocks, and job postings.

## Why

Inspired by SurfSense's structured, rate-limit-bypassing connectors to
Reddit, YouTube, Instagram, TikTok, Amazon, Walmart, Google Maps, and
Indeed. Mana already has the pattern: Universalis (FFXIV), Alpha Vantage
(stock), Adzuna (jobs) -- all self-contained opt-in plugins.

## Proposed Scope

- Start with Reddit and YouTube -- discussion/opinion data and video
  metadata that generic web search handles poorly.
- Same shape as the existing market/job plugins: self-contained,
  opt-in, injects context into chat replies and/or Deep Research.
- Expand to more platforms later only if the first two prove valuable.

## Acceptance Criteria

- At least one new structured connector (Reddit or YouTube) works as an
  opt-in plugin following the existing `plugins/` pattern.
- No behavior change for users who don't enable the new plugin(s).

## Related

`plugins/README.md`, the existing Universalis/Alpha Vantage/Adzuna
plugins.
