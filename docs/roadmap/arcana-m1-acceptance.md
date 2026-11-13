# Arcana M1 acceptance matrix

Status: **complete** for the Obscura-backed Arcana path (2026-11-13).

Run date: 2026-11-13

## Direct API wire contract coverage

| Capability | Result | Evidence |
| --- | --- | --- |
| Loopback HTTP / WebSocket transport with bearer token and origin checks | Pass | `ApiServerTests.V1RequiresTokenOriginAndServesPageActions` |
| Full page lifecycle, tabs query and history (back, forward, reload) | Pass | `ApiServerTests.V1ServesFullLifecycleTabsAndHistory` |
| Snapshots, find, element actions (fill, select, click), keys, scroll, wait | Pass | `ApiServerTests.V1ServesFullActionsSnapshotAndEvaluation` |
| PNG screenshot capture, cookies, local storage, CDP extension, WebSocket events and logs | Pass | `ApiServerTests.V1ServesStorageCookiesScreenshotAndDiagnostics` |
| Independent loopback targeting with explicit engine identity verification | Pass | `ApiServerTests` with `ARCANA_TEST_ENDPOINT`, `ARCANA_TEST_TOKEN`, `ARCANA_TEST_ENGINE_ID` |

## Mana direct integration

| Capability | Result | Evidence |
| --- | --- | --- |
| Page actions and reading without Playwright | Pass | `arcana-real-engine.test.js` real engine suite |
| Local storage persisted across browser restart | Pass | `arcana-real-engine.test.js` restart test |
| Engine cleanup on host exit or crash | Pass | Windows Job object and parent-process watch |
| Multi-tab isolation and session lifecycle | Pass | `arcana-real-engine.test.js` and `browser-automation.test.js` |
| Explicit Edge fallback preserved | Pass | Edge fallback routes and configuration |

## Exit assessment

M1 exit condition is fully satisfied:
1. Versioned page API v1 runs on Obscura over authenticated loopback HTTP and WebSocket.
2. Shared test harness tests the full API contract and can target independent backends with engine identity verification.
3. Mana's direct Arcana path passes real-engine tests for actions, storage persistence across restart, and crash cleanup.
4. Playwright is eliminated from the Arcana path while preserving Edge as an explicit fallback.
