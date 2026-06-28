# Issue 10: Expand Mana Health Status Into Component Status

## Goal

Make `/health` useful for the launcher and troubleshooting by reporting component-level readiness.

## Proposed Scope

- Report backend status independently from optional components.
- Report local llama, Whisper, TTS, mobile auth, local memory, Cloudflare Tunnel config, FFXIV market APIs, and VTube status.
- Keep a top-level `ok` field.
- Distinguish configured, available, degraded, and unavailable states.
- Preserve compatibility for existing launcher health checks.

## Acceptance Criteria

- `/health` includes structured component status.
- Existing launcher checks continue to work.
- Tests cover healthy and missing-component cases.
- The response contains no secrets or full auth tokens.
