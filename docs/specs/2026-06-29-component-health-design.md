# Component Health Design

## Goal

Expand `/health` so Mana can report component-level readiness for launchers and troubleshooting while preserving the existing flat health fields.

## Scope

This slice covers issue #10:

- Add a structured `components` object to `/health`.
- Preserve existing top-level health fields used by current clients.
- Report backend, local llama, Whisper, TTS, mobile auth, local memory, Cloudflare Tunnel config, FFXIV market APIs, and VTube status.
- Avoid secrets, tokens, passcodes, and full API keys.
- Keep `/health` fast and local. Deeper network probes remain in Doctor.

## Status Model

Use these component statuses:

- `available`: configured and usable from local configuration.
- `configured`: configured, but not actively probed by `/health`.
- `degraded`: partially configured or using fallback behavior.
- `unavailable`: missing required configuration or disabled.

Each component should include:

- `status`
- `configured`
- `message`

Components may also include non-secret details such as provider names, model paths, boolean flags, and watchlist symbols.

## Component Rules

- `backend`: always `available` when the route responds.
- `localLlama`: based on `getLlamaStatus()`.
- `whisper`: available only when both Whisper binary and model are configured.
- `tts`: unavailable when provider is `none`; degraded when provider has missing local CLI details; configured for service-backed providers.
- `mobileAuth`: available when passcode hash and session secret are configured.
- `localMemory`: available when the mobile memory store has a data file path or data directory.
- `cloudflareTunnel`: configured when a tunnel token, named tunnel, or tunnel URL environment variable is present.
- `ffxivMarket`: configured when Universalis/XIVAPI/Garland URLs are configured through defaults or env.
- `vtubeStudio`: configured when VTube integration is enabled; unavailable when disabled.

## Testing

Add route tests that verify:

- `/health` keeps top-level compatibility fields.
- `/health.components` contains all expected component keys.
- Missing local config produces `unavailable` or `degraded` statuses without exposing secrets.
- Configured mobile auth, Cloudflare, and VTube values are reflected without leaking token values.

Final verification:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-10-component-health\node-bot
node --test test\health-components.test.js test\mobile-routes.test.js test\doctor.test.js
node --check server.js
npm test
```
