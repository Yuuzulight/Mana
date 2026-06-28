# Issue 11: Add Request Validation For Mana API Endpoints

## Goal

Validate important API inputs consistently so malformed requests fail clearly and safely.

## Proposed Scope

- Add lightweight validation helpers for request body and query parameters.
- Validate `/reply`, `/transcribe`, `/mobile/*`, `/ffxiv/market`, and `/ffxiv/crafting/profit` inputs.
- Return stable 400 responses with concise error messages.
- Avoid logging sensitive values.

## Acceptance Criteria

- Invalid requests return 400 instead of causing unclear failures.
- Valid existing requests still work.
- Tests cover common invalid inputs.
- Validation stays local and does not depend on a remote service.
