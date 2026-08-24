# Issue 417: Model-Invoked Vision Tool Call

## Goal

Let the model decide mid-reply when looking at the screen would help answer
the question, instead of only reacting to the `Ctrl+Alt+M` hotkey or the
passive ambient-glance loop.

## Why

Inspired by my-neuro's "language-intent-based activation." Mana's
multi-round tool-calling loop (#183) and existing tool sources
(`node-bot/ai/expression-tool-source.js`, `node-bot/ai/skill-tool-source.js`)
already give this an idiomatic home -- no `vision_look`-style tool exists
today (confirmed by grep). See `docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Proposed Scope

- Add a vision tool source alongside the existing tool sources, following
  the same registration pattern.
- Gate it exactly like the existing `/vision/describe` path: requires a
  local vision GGUF installed, respects whatever opt-in currently applies.
- Tool result feeds back into the same conversation turn, same as other
  tool calls in the multi-round loop.

## Acceptance Criteria

- The model can request a screenshot description mid-reply via a tool
  call, without the user pressing the vision hotkey.
- No vision model installed -> tool call fails gracefully, same behavior
  as the existing hotkey path today.
- Doesn't change the existing hotkey or ambient-glance behavior.
