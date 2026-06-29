# Issue 13: Introduce Mana Capability Module Boundaries

## Goal

Create a simple internal module pattern so optional capabilities can be added without growing the main server file.

## Proposed Scope

- Define a small capability shape with route registration and status reporting.
- Apply the pattern first to one or two existing capabilities.
- Keep the pattern simple and internal to Mana.
- Avoid a full plugin system unless a later issue proves it is needed.

## Acceptance Criteria

- Capabilities can register routes through a consistent function.
- Capabilities can contribute health/status information.
- The pattern is documented in Mana terms.
- No external project names or references are added.

## Implementation Notes

- Added a small internal capability registry for route registration and health collection.
- Moved FFXIV/Universalis market and crafting routes into the `ffxivMarket` capability.
- Preserved all existing public FFXIV endpoint URLs.
- Moved `ffxivMarket` health ownership from `server.js` into the capability.

## Verification

- `node --test test\capabilities-registry.test.js test\ffxiv-market-capability.test.js test\capability-boundaries.test.js test\server-routes.test.js test\health-components.test.js`
- `node --check capabilities\registry.js`
- `node --check capabilities\ffxiv-market-capability.js`
- `node --check server-routes.js`
- `node --check server.js`
- `npm test`
- Forbidden external-project reference scan.
