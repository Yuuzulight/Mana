# Issue 426: User-Configurable PreToolUse/PostToolUse-Style Hooks

## Goal

Let the user declare their own deterministic checks around tool
execution, alongside Mana's built-in approval gate and audit layer.

## Why

Inspired by Claude Code's `PreToolUse`/`PostToolUse` hook config
(allow/deny/ask/modify-input). Mana's approval gate (#152) and unified
audit layer (#188) are fixed internal gates with no user-authored
extension point. See `docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Proposed Scope

- A local per-project hook config format.
- Hooks run deterministically (not LLM-judged) before/after tool
  execution.
- Additive to the existing approval gate and audit layer, not a
  replacement for either.

## Acceptance Criteria

- A user can declare a hook (e.g. "run prettier after a write", "block
  writes under `.env`") and see it enforced.
- No hook config -> behavior identical to today.
- Hooks can't bypass the existing approval gate; they add checks, they
  don't remove any.
