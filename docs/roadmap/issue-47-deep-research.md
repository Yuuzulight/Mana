# Issue 47: Add a Multi-Step Deep Research Mode to the Web-Access Capability

## Status

Implemented. `node-bot/tools/deep-research.js` orchestrates search (reusing
`tools/web-access.js`'s `searchWeb`) + read (`fetchPage`) + synthesis (a
local model call, injected by the caller) into one bounded pass, with
`maxSources` (default 4, capped at 8) and `maxTotalMs` (default 60s, capped
at 3 minutes) limits and an `onProgress` callback at each step. A single
unreadable source falls back to its search snippet instead of failing the
whole run.

`node-bot/capabilities/deep-research-capability.js` exposes this as a small
job-based HTTP API — `POST /research/start` returns a `jobId` immediately,
`GET /research/:jobId` reports `{status, progress, result}` for polling —
so the UI never blocks on a long synchronous request. `windows-launcher`
gets a "Research" button next to the composer that posts the typed text as
a research question, polls for progress (shown as a pulsing status line),
and appends the final cited report (with a source list) as a chat message
once done. Existing single-shot search/read behavior
(`web-access-capability.js`, `buildWebContextForPrompt`) is untouched.

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
