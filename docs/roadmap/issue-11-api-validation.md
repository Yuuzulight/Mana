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

## Progress

- Added lightweight dependency-free request validation helpers.
- Added stable 400 responses for malformed core and mobile API requests.
- Validated local-first routes without logging sensitive request values.

## Verification

- `node --test test\request-validation.test.js test\server-routes.test.js test\mobile-routes.test.js`
- `node --check request-validation.js`
- `node --check server-routes.js`
- `node --check mobile-routes.js`
- `npm test`
