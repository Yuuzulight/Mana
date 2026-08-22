# Capability Module Boundaries Design

## Goal

Introduce a small internal capability pattern so optional Mana features can register routes and health/status details without continuing to grow the central backend files.

## Scope

- Add a lightweight capability shape for route registration and health contribution.
- Apply it first to the FFXIV/Universalis market and crafting endpoints.
- Preserve every existing public FFXIV endpoint URL and request/response behavior.
- Move FFXIV route registration into a clearer capability folder or module.
- Keep the pattern Mana-specific and internal. This is not a plugin marketplace or external extension system.
- Avoid external project references.

## Capability Shape

A capability is a plain object:

```js
{
  key: "ffxivMarket",
  registerRoutes(app, context) {},
  getHealth(context) {}
}
```

Fields:

- `key`: stable component name used for health/status output.
- `registerRoutes(app, context)`: optional function that registers Express routes.
- `getHealth(context)`: optional function that returns a health component object.

The context object contains only the dependencies needed by registered capabilities. It should be built in `server.js` from existing runtime helpers and configuration.

## Architecture

Add `node-bot/capabilities/registry.js` with small helpers:

- `registerCapabilities(app, capabilities, context)`: calls each capability's `registerRoutes` when present.
- `buildCapabilityHealth(capabilities, context)`: calls each capability's `getHealth` when present and returns an object keyed by capability key.

Add `node-bot/capabilities/ffxiv-market-capability.js` for FFXIV routes and health.

The FFXIV capability will own these routes:

- `GET /ffxiv/market`
- `GET /ffxiv/crafting/profit`
- `POST /ffxiv/market/from-screen`

These routes currently live in `node-bot/server-routes.js`. They will move with the same validation helpers, dependency names, and response shapes.

`server-routes.js` will keep general backend routes such as transcription, screen OCR, stock-market helpers, reply, and synthesis.

`server.js` will:

- import the FFXIV capability and registry helpers.
- build one capability context from existing dependencies.
- register the FFXIV capability after editor/model routes and before general route registration.
- merge capability health into `/health.components`.

## Health Behavior

The existing `/health.components.ffxivMarket` object remains present and keeps the same shape:

```json
{
  "status": "configured",
  "configured": true,
  "message": "FFXIV market providers are configured from local defaults.",
  "universalisConfigured": true,
  "xivapiConfigured": true
}
```

The difference is ownership: the FFXIV capability contributes this health component instead of `server.js` hardcoding it inside `buildHealthComponents`.

## Error Handling

Route behavior must stay compatible:

- Validation errors return stable `400` responses through the existing `ValidationError` flow.
- Unexpected errors return `500` with the current JSON error shape.
- Moving the route code must not change query parameter names, defaults, limits, or ranking behavior.

## Testing

Use TDD for implementation.

Add tests covering:

- Registry helpers register routes from capabilities.
- Registry helpers collect health from capabilities by key.
- FFXIV routes still respond through the same public URLs after moving into the capability.
- `/health.components.ffxivMarket` remains present with the same fields.
- `server-routes.js` no longer owns the FFXIV route paths.

Run focused route/health/capability tests, JavaScript syntax checks, the full `npm test` suite, and the forbidden-reference scan before merging.

## Out Of Scope

- No dynamic plugin loading.
- No user-installable capability marketplace.
- No change to public FFXIV endpoint URLs.
- No broad rewrite of stock, mobile, editor, TTS, or local AI modules in this slice.
