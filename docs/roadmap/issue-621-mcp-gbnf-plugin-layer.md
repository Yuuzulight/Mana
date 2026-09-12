# Issue 621: Adopt MCP And GBNF Grammar Constraints For The Plugin/Tool-Calling Layer

## Goal

Reduce malformed tool-call failures from Mana's local models, and stop
hand-rolling a bespoke integration surface for every new plugin.

## Why

Mana's plugin system (browser automation, FFXIV/stock market, job search,
Discord/Telegram bridges, cron scheduler, image gen, document reader,
video watch) presumably exposes ad hoc tool-calling functions to the LLM
today, with each plugin likely wired in separately. Two converging
findings from the research address this directly:

- **GBNF grammar-constrained decoding**: llama.cpp natively supports GBNF
  grammars that constrain decoding token-by-token so the model is
  physically unable to emit a token that would produce invalid JSON
  against a tool's schema. `llama-cpp-agent` auto-generates such grammars
  from function signatures/Pydantic models. Since Mana already runs
  llama.cpp/GGUF directly with swappable per-role models -- including a
  small/fast role where malformed tool-call JSON is most likely -- wiring
  per-plugin GBNF grammars at the call site eliminates a whole class of
  "model almost got the tool call right" failures for free, with no new
  dependency (the grammar engine is already in llama.cpp).
- **Model Context Protocol (MCP)**: an open protocol that standardizes
  how an LLM client discovers and invokes tools exposed by a server
  process, decoupling tool implementation from any specific framework.
  Exposing Mana's own plugins as local MCP servers (stdio transport, no
  network dependency, staying local-first) would let Mana consume the
  growing ecosystem of existing MCP servers without hand-writing new
  plugins for capabilities that already exist, and would let the
  ACP-based coding agent and the companion chat loop share one
  tool-calling interface instead of two.
- Also worth folding in at the same call site: Neuro-sama's published
  game-integration protocol (context push vs. forced-action-request as
  separate message types, deliberately restricted JSON Schemas with no
  `$ref`/`anyOf`/`oneOf` so small models can't hallucinate malformed
  nested calls, a priority/interruptibility level on each forced
  decision, and a bounded-time result callback so a stalled plugin can't
  hang the loop) and Home Assistant's cheap intent-matching-first tier
  (route obviously-simple commands through a fast deterministic matcher,
  only falling through to full LLM tool-calling for anything ambiguous).

## Proposed Scope

- Add GBNF grammar generation for existing plugin tool schemas at the
  llama.cpp call site; measure malformed-tool-call rate before/after on
  the fast/small model role specifically.
- Prototype exposing one existing plugin (a simple one, e.g. document
  reader) as a local MCP server over stdio, and have the existing
  tool-calling loop consume it the same way it would consume a
  hand-written plugin, to validate the integration shape before
  converting the rest.
- Evaluate whether a cheap deterministic/embedding-based router (before
  any LLM call) for high-frequency simple commands is worth adding ahead
  of the tool-calling loop, given the gaming-mode resource constraint.

## Acceptance Criteria

- Measured reduction in malformed/invalid tool-call JSON from at least
  the fast/small model role after adding GBNF grammars.
- One plugin successfully converted to a local MCP server and consumed
  through the existing tool-calling loop with no regression in
  functionality.
- A clear recommendation on whether to convert the remaining plugins to
  MCP servers, and whether a pre-LLM intent router is worth adding.

## Related

`docs/roadmap/oss-inspiration-survey-2026-09.md` (full research backing).
