# Issue 47: Add a Multi-Step Deep Research Mode to the Web-Access Capability

## Status

Implemented. `node-bot/tools/deep-research.js` orchestrates the full pass:
it first asks the local model to decompose the question into up to
`maxSubQueries` distinct search queries (default 3, capped at 4 — any
planning failure silently falls back to searching the original question),
searches each (reusing `tools/web-access.js`'s `searchWeb`), pools and
dedupes results by URL, reads a bounded number of them (`fetchPage`), and
synthesizes a cited report via an injected local-model call. Bounds:
`maxSources` (default 4, capped at 8) and `maxTotalMs` (default 60s, capped
at 3 minutes), with an `onProgress` callback at each step. A single
unreadable source falls back to its search snippet, and a single failing
sub-search doesn't sink the pass (only all-searches-failed does). An
`isCancelled` hook stops the run between steps
(`ResearchCancelledError`) — in-flight fetches/LLM calls finish first.

`node-bot/capabilities/deep-research-capability.js` exposes this as a small
job-based HTTP API — `POST /research/start` returns a `jobId` immediately,
`GET /research/:jobId` reports `{status, progress, result}` for polling,
and `POST /research/:jobId/cancel` requests cancellation (idempotent; a
job cancelled mid-synthesis discards its result). Finished jobs are pruned
from the in-memory store after `MANA_RESEARCH_JOB_TTL_MS` (default 10
minutes). Persistent per-machine defaults for the bounds come from
`MANA_RESEARCH_MAX_SOURCES` / `MANA_RESEARCH_MAX_TOTAL_MS` /
`MANA_RESEARCH_MAX_SUB_QUERIES`; per-request body values still win, and the
tool's hard caps apply regardless. Both the sub-query planner and the
synthesizer deliberately use the same `"quality"` model profile so a
research pass never triggers a mid-run llama-server model swap.

`windows-launcher` gets a "Research" button next to the composer that posts
the typed text as a research question, polls for progress (a pulsing status
line with a Cancel button), and appends the final cited report (source
list, plus the sub-queries actually searched) as a chat message once done.
Existing single-shot search/read behavior (`web-access-capability.js`,
`buildWebContextForPrompt`) is untouched.

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
