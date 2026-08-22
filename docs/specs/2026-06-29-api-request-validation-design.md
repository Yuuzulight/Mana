# API Request Validation Design

## Goal

Mana should reject malformed API requests with clear, stable 400 responses before deeper route logic runs. Validation must stay local, lightweight, and dependency-free.

## Scope

This design covers issue #11:

- Add reusable request validation helpers for body, query, and file inputs.
- Validate `/reply`, `/transcribe`, `/transcribe-only`, `/mobile/*`, `/ffxiv/market`, and `/ffxiv/crafting/profit`.
- Keep current valid requests working.
- Return concise JSON errors for invalid inputs.
- Avoid logging sensitive request values, passcodes, tokens, or full request bodies.

This slice does not reorganize FFXIV modules into a new folder. That belongs to issue #13 capability module boundaries.

## Approach

Use a small helper module instead of adding a schema dependency. The helper should support common operations:

- Required non-empty string.
- Optional trimmed string with default.
- Positive integer parsing with min, max, and default.
- Boolean parsing for `1`, `0`, `true`, and `false`.
- Multipart file presence checks.
- Stable `400` response formatting.

Route handlers should call these helpers near the start of the request. If validation fails, the route should return `400` and should not call deeper services.

## Components

### `node-bot/request-validation.js`

Responsibilities:

- Define a `ValidationError` with `statusCode: 400`.
- Provide helper functions that either return normalized values or throw `ValidationError`.
- Provide a `sendValidationError(res, error, fallbackMessage)` helper for stable JSON responses.

The module should not import Express. It should operate on plain values so it is easy to test.

### Core Routes

`node-bot/server-routes.js` should use validation helpers for:

- `/reply`: require `body.text`; validate optional `screenText`, `modelProfile`, and `ffxivWorld`.
- `/transcribe` and `/transcribe-only`: require multipart `file`.
- `/ffxiv/market`: validate that either `itemId` is a positive integer or `itemName` is a non-empty string.
- `/ffxiv/crafting/profit`: validate integer ranges for `limit`, `scanLimit`, `pageSize`, `historyDays`, and `minUnitsSold`; validate booleans and strings without throwing 500s.

### Mobile Routes

`node-bot/mobile-routes.js` should use validation helpers for:

- `/mobile/auth/unlock`: require non-empty `passcode`.
- `/mobile/chat/text`: require non-empty `text`.
- `/mobile/chat/audio`: require authenticated multipart `file`.
- `/mobile/summaries`: require non-empty `summary`; keep optional `id`, `chatId`, and `title` as trimmed strings.
- `/mobile/synthesize`: require non-empty `text`.

Auth failures should remain `401` or `429` as they are today. Validation should not weaken auth ordering. For authenticated upload routes, auth must still run before file processing.

## Error Shape

Validation failures should return:

```json
{
  "error": "text is required"
}
```

The response should not include stack traces, raw request bodies, passcodes, tokens, or uploaded file paths.

## Testing

Add focused tests for:

- Helper behavior in `node-bot/test/request-validation.test.js`.
- `/reply` rejects missing or whitespace-only text with 400.
- `/ffxiv/market` rejects requests with neither valid `itemId` nor `itemName`.
- `/ffxiv/crafting/profit` rejects out-of-range numeric query values with 400.
- `/mobile/auth/unlock` rejects missing passcode with 400.
- `/mobile/chat/text` rejects missing text with 400 after auth succeeds.
- `/mobile/summaries` rejects missing summary with 400 after auth succeeds.
- `/mobile/chat/audio` rejects missing multipart file with 400 after auth succeeds.

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation\node-bot
node --test test\request-validation.test.js test\mobile-routes.test.js
node --test test\server-routes.test.js
node --check request-validation.js
node --check server-routes.js
node --check mobile-routes.js
```

Final verification should run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation\node-bot
npm test
```

Also run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation
git status --short --branch
```
