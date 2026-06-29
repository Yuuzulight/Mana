# Issue 12: Add Local Model Management And Switching Status

## Goal

Make Mana's local model stack visible and switchable without editing batch files by hand.

## Proposed Scope

- Track default chat, fast fallback, quality fallback, and coding model profiles.
- Expose model list and status through the backend.
- Support switching the active local profile for a session or runtime setting.
- Clearly show when a model file is missing.
- Warn if remote AI is enabled.

## Acceptance Criteria

- The configured 4B, 1.5B, 8B, and coding profiles can be listed.
- Missing model files are reported clearly.
- Local-only behavior remains the default.
- Tests cover profile selection and fallback behavior.

## Implementation Notes

- Added explicit `default`, `fast`, `quality`, and `coding` local profiles.
- Added runtime local model status and active-profile switching APIs.
- Reported missing configured GGUF files without failing the backend.
- Kept local-only behavior as the default and only reported remote-AI warning state.

## Verification

- `node --test test\local-ai.test.js test\llama-model-selection.test.js test\model-management.test.js test\server-routes.test.js`
- `node --check ai\local-ai.js`
- `node --check model-management.js`
- `node --check server-routes.js`
- `node --check server.js`
- `npm test`
- Forbidden external-project reference scan.
