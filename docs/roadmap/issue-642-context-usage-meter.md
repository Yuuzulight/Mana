# Issue 642: Add A Context-Window Usage Meter With Per-Category Breakdown

## Goal

Let the user see how full the active model's context window is and what's
consuming it, instead of context usage being entirely invisible until
something breaks.

## Why

Hermes Desktop shows a live "% full" meter in the composer status bar;
clicking it opens a breakdown by category — system prompt, tool
definitions, skills, memory, rules, MCP, conversation. Nothing equivalent
exists anywhere in Mana's UI today (no matches for context-usage/
token-meter code in either launcher).

This matters more for Mana than for a cloud-model-backed agent: Mana runs
local GGUF models with much smaller effective context windows than hosted
frontier models, and already has multiple things competing for that
budget (plugin tool schemas, MCP tool schemas, memory-graph context,
conversation history). Right now none of that is visible to the user or,
apparently, to the model's own prompt-construction logic in an
inspectable way.

## Proposed Scope

- Expose a per-turn context-usage breakdown from the backend
  (`node-bot/server.js`'s prompt-construction path) categorized at
  minimum: system prompt, tool/plugin schemas, MCP tool schemas,
  memory/skills content, conversation history.
- Surface it as a status-bar meter in both launchers, with a click/hover
  breakdown by category.
- Not in scope: automatically trimming/compacting context based on this
  data — visibility only, as a first step.

## Acceptance Criteria

- Both launchers show a live, per-turn context-usage percentage against
  the active model's real context window.
- The breakdown reflects real categorized token counts, not estimates
  from static heuristics.

## Related

`docs/roadmap/hermes-desktop-eval-2026-09.md`. Relevant to issue #621's
plugin-schema-loading concerns (small local models are more sensitive to
context bloat than cloud models).
