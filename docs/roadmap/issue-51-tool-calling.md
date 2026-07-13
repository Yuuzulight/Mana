# Issue 51: Scope Tool-Calling (Shell/File) Access for Mana's Local Model

## Goal

Let Mana's local model actively call tools (shell commands, file access)
under policy control, the way odysseus's `agent_tools`/`tool_policy.py`
does — a prerequisite already flagged in issue #42's MCP scoping.

## Why

Odysseus's agent loop gives the model bash + file access under an explicit
policy/security layer. Mana's local llama-server runtime
(`node-bot/ai/llama-server-runtime.js`) has no tool-calling loop today —
replies are built from a regex/heuristic intent classifier, not the model
requesting tools.

## Proposed Scope

- Investigate llama.cpp/llama-server's `--jinja` tool-calling template
  support for Mana's current Qwen3/Qwen2.5-Coder models.
- Design a minimal, policy-gated tool set (e.g. read-only file access, a
  narrow allowlisted shell action) with explicit user approval before any
  write/execute action — mirroring node-bot's existing pending-writes
  approval flow for editor edits.
- This is exploratory/foundational: land a working tool-call loop for at
  least one safe, read-only tool before considering anything destructive.

## Acceptance Criteria

- A documented finding on whether Mana's current local models support
  reliable tool-calling via llama-server.
- If viable: one working, policy-gated, read-only tool callable by the
  model end-to-end.
- No destructive/write tool is auto-approved; matches the existing
  approval-required pattern already used for editor edits.
- This issue is understood as a prerequisite for MCP client support
  (issue #42's Phase 2), not a replacement for it.
