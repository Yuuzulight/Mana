# Issue 9: Add Mana Doctor Checks For Local Setup

Status: Done
Issue: https://github.com/Yuuzulight/Mana/issues/9
Merged PR: https://github.com/Yuuzulight/Mana/pull/16

## Goal

Add a local setup checker that explains missing or misconfigured dependencies before Mana fails at runtime.

## Proposed Scope

- Check Node runtime and required npm dependencies.
- Check llama executable and configured GGUF model paths.
- Check Whisper paths and model paths when configured.
- Check TTS service availability.
- Check required ports and local storage writability.
- Check mobile auth configuration.
- Check local-only AI policy and warn if remote AI is enabled.

## Acceptance Criteria

- A command or endpoint returns structured pass, warn, and fail results.
- The Windows launcher can surface the same status later.
- Results include actionable messages.
- No external AI service is required.

## Progress

- Added structured Doctor checks in `node-bot/doctor.js`.
- Added Doctor endpoint coverage through `createApp`.
- Added async probes for TTS health URLs, backend port availability, and Zed external-agent backend health.
- Added checks for local-only AI policy and Zed external agent availability.

## Verification

- Covered by `node-bot/test/doctor.test.js`.
- Continued to pass in the final issue #8 verification run: `npm test` in `node-bot` with 107 passing, 0 failing.
