# Issue 434: Home Assistant / Wyoming Voice-Satellite Integration

## Goal

Route smart-home commands through Mana's own wake-word/tool-calling loop
instead of needing a second assistant.

## Why

Home Assistant's Assist framework and the Wyoming protocol let a local
app register as a conversation agent or voice satellite, and Home
Assistant's local REST/WebSocket API lets Mana query device state for
situational replies. Fully local, reuses infrastructure Mana already has.
See `docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Proposed Scope

- Register Mana as a local Home Assistant Assist conversation agent (or
  Wyoming satellite).
- Add a tool source that queries Home Assistant's local API for device
  state ("is the office light on?").
- Opt-in, off by default -- requires a Home Assistant instance the user
  already runs.

## Acceptance Criteria

- With a configured Home Assistant instance, Mana can answer device-state
  questions and issue basic commands through its own conversation loop.
- No Home Assistant configured -> feature is inert, no errors surfaced to
  the normal chat flow.
