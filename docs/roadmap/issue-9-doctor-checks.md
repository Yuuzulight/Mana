# Issue 9: Add Mana Doctor Checks For Local Setup

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
