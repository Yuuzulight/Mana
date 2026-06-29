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

## Progress

- Extracted local AI policy, model profile selection, preferred GGUF model selection, and model-file discovery into `node-bot/ai/local-ai.js`.
- Kept `server.js` re-exporting the same helper functions for existing tests and callers.
- Added focused module tests for the extracted local AI helpers.
- Extracted local llama binary/model status checks and reply execution into `node-bot/ai/local-llama-runtime.js`.
- Added focused runtime tests for local GGUF args, HF repo args, missing-binary placeholders, and local model detection.
- Extracted FFXIV, Universalis, crafting-profit, sales-history, and gatherable-material helpers into `node-bot/ffxiv-market.js`.
- Extracted TTS provider selection, CLI synthesis, Fish Speech, Kokoro, and Chatterbox synthesis into `node-bot/tts-runtime.js`.
- Extracted VTube reaction logic and VTube Studio route registration into `node-bot/vtube-runtime.js` and `node-bot/vtube-routes.js`.
- Moved the main stock, FFXIV, reply, transcription, screen OCR, and synthesis endpoint registration into `node-bot/server-routes.js`.
