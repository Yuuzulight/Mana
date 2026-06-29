# Active Roadmap Issues

Last synced: 2026-06-29

These items are open on the GitHub Project board and should be treated as the current active roadmap.

## In Progress

### Issue #10: Expand Mana Health Status Into Component Status

Linked PR: #17

Target outcome:
- `/health` reports structured component readiness.
- Launcher and troubleshooting views can distinguish healthy, degraded, missing, and unavailable components.
- Secrets and auth tokens are not leaked.

### Issue #11: Add Request Validation For Mana API Endpoints

Linked PR: #18

Target outcome:
- Important route inputs return stable 400 responses when malformed.
- Existing valid requests keep working.
- Validation stays lightweight and local.

### Issue #12: Add Local Model Management And Switching Status

Linked PR: #19

Target outcome:
- Mana can list configured local model profiles and missing model files.
- Users can switch the active local profile without editing batch files by hand.
- Local-only behavior remains the default.

### Issue #13: Introduce Mana Capability Module Boundaries

Linked PR: #20

Target outcome:
- Optional capabilities can register routes and status through a consistent internal pattern.
- The pattern stays simple and Mana-specific.
- No external project references are introduced.

### Issue #14: Improve Mobile Device Security Controls

Linked PR: #21

Target outcome:
- Mobile clients can be listed, rotated, and revoked.
- Remote exposure warnings are visible in status output.
- Local chat memory remains the default.

## In Review

### Issue #4: Improve Speech Recognition Accuracy

Linked PR: #5

Target outcome:
- Improve wake-word reliability and Whisper accuracy without breaking local/offline behavior.
- Keep blank/noise filtering.
- Add repeatable local audio test coverage before broader changes.

## Backlog

### Issue #1: Add Screen Perception And Understanding For Mana

Keep the first slice opt-in, screenshot-based, local-first, and non-persistent by default.

### Issue #2: Optimize Mana Performance While Gaming In The Background

Validate with FFXIV running. Prioritize low overhead, throttling, and observability.

### Issue #3: Evaluate Fish Speech TTS Provider

Fish provider support exists in the backend, but the issue remains open for evaluation, health reporting, and smoke testing with a running Fish Speech server.

### Issue #6: Add Stock Market Analysis Helper

Needs triage. The backend already includes market-data support, stock endpoints, tests, and setup docs. Either close the MVP as complete or narrow the issue to remaining SEC/news/watchlist enhancements.
