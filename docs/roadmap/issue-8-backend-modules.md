# Issue 8: Split Mana Backend Into Focused Modules

## Goal

Reduce the size and coupling of the Node backend by moving unrelated responsibilities out of `node-bot/server.js` into focused modules while preserving current endpoint behavior.

## Proposed Scope

- Move local llama and model-selection logic into `node-bot/ai/`.
- Move FFXIV and Universalis routes/services into focused route and service files.
- Move TTS, VTube, and market routes into their own route modules.
- Keep `createApp()` as the application composition point.
- Preserve current public endpoint URLs.

## Acceptance Criteria

- `node-bot/server.js` is primarily app setup and route registration.
- Existing tests pass with `npm test` from `node-bot`.
- Current launcher and mobile clients continue to use the same backend URLs.
- No remote AI is introduced or enabled by default.
