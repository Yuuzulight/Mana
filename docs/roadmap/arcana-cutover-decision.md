# Arcana Cutover & Architectural Decisions (M6)

**Status: Complete.**  
**Date: 2026-11-14**

This document records the Milestone 6 (M6) cutover decisions for Arcana and Mana headless and interactive browsing:
1. Cutover of Arcana's default browser engine to Folio.
2. Architectural decision on browser fallback (Edge).
3. Architectural decision on Playwright retirement.
4. Deferral status of release code-signing.

---

## 1. Engine Cutover: Folio as the Default Backend

Arcana has officially switched its default browser backend from Obscura to **Folio** (`--backend=folio` is default in `ArcanaOptions` and the Arcana CLI).

### Technical Rationale & Qualification
- **Contract Conformance**: Folio implements the versioned Arcana Page API v1 (`IArcanaBrowserBackend`, `IArcanaPageBackend`), passing the shared wire contract test suite (`tests/Arcana.Runtime.Tests/FolioContractTests.cs`).
- **Maintained Real-Site Qualification**: Folio qualified against all 6 maintained SPA flows in `tests/Arcana.Runtime.Tests/SpaQualificationTests.cs` and `docs/m5-spa-matrix.md`:
  - Structured content and table DOM extraction (Wikipedia / reference pattern)
  - Multi-step interactive form filling, validation, and submission
  - Client-side Single Page Application (SPA) routing with History API (`pushState`) and hash changes
  - Dynamic client-rendered DOM mutations and query selector matching
  - LocalStorage, SessionStorage, and Cookie persistence across page reloads
  - Live screencast frame streaming (`Page.screencastFrame`), pointer hit-testing, and keyboard typing
- **Sandboxed Containment**: Folio runs inside AppContainer and process isolation with Windows Job Object containment, bounding memory, and terminating process trees automatically on host exit or crash.
- **Obscura Build & Runtime Option**: Obscura is retained as an explicit build and runtime option (`--backend=obscura`) for one release cycle to ensure backward compatibility and comparison benchmarking.

---

## 2. Decision on Browser Fallback: Windows Default Browser (Edge)

### Decision
The Windows default browser (Edge) is **RETAINED as an explicit user-directed fallback**.

### Rationale & Policy Boundaries
As established in Milestone 4 (`arcana-m4-acceptance.md`), autonomous AI agents must never attempt to automate or defeat anti-bot gates, solve CAPTCHAs, or handle sensitive financial/SaaS authentication credentials:
1. **Interactive Human Takeover**: When encountering bank-grade authentication, interactive CAPTCHAs, or complex enterprise SSO, Mana explicitly prompts the user to open the flow in their personal, secure default browser.
2. **Explicit User Intent Only**: Mana never falls back to Edge silently. Fallbacks occur only via explicit user instruction or when human takeover is necessary.
3. **Session Hand-back**: After the user completes sign-in in their browser, cookies and storage state can be handed back to Mana/Arcana for continuing approved workflows.

---

## 3. Decision on Playwright: Full Retirement

### Decision
Playwright is **FULLY RETIRED** from the Mana and Arcana browsing paths.

### Rationale
- **Zero Heavy Process Overhead**: Arcana communicates directly with Folio and Obscura over authenticated loopback HTTP and WebSocket using the versioned Page API v1.
- **Elimination of Node Driver Dependencies**: Eliminating Playwright removes heavy external browser binaries, brittle driver version mismatches, and excess Node.js subprocess layers.
- **Direct Control**: Mana interacts directly with Arcana via HTTP/WebSocket, reducing memory overhead, startup latency, and failure surfaces.

---

## 4. Release Code-Signing: Postponed

### Decision
Release code-signing remains **DELIBERATELY POSTPONED**.

### Rationale
In accordance with user instructions and project roadmap guidelines:
- Code-signing certificates, timestamping, and signed Windows installer artifacts remain deferred until distribution packaging.
- Functional validation, security boundaries, and test suites are 100% verified without signed binaries.
