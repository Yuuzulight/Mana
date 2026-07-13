# Issue 47: Add a Multi-Step Deep Research Mode to the Web-Access Capability

## Goal

Extend Mana's existing web-access capability (search/read via SearXNG) into
a multi-step research flow that gathers from several sources and
synthesizes a report, rather than a single search-and-answer.

## Why

Inspired by odysseus's Deep Research (multi-step web research with source
reading and report generation). Mana's
`node-bot/capabilities/web-access-capability.js` already covers single-shot
search/read.

## Proposed Scope

- New capability mode (or extension of `web-access-capability.js`) that
  takes a research question, runs several searches/reads across sources,
  and builds a structured summary with citations.
- Bound the number of search/read steps and total time to keep it
  local-first and predictable.
- Surface progress (e.g. "searching...", "reading source 2 of 4...") to
  the UI rather than a long silent wait.

## Acceptance Criteria

- Given a research question, Mana can produce a multi-source summary with
  links to what it read.
- The research step count/time is bounded and configurable.
- Existing single-shot web search/read behavior is unaffected for normal
  chat.
