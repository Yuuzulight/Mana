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
