# Issue 49: Add a Compare Mode for Side-by-Side Local Model Output

## Goal

Let users see how Mana's different local model profiles
(default/fast/quality/coding) respond to the same prompt, to help tune
their own setup.

## Why

Inspired by odysseus's Compare (blind side-by-side model testing and
synthesis). Mana already has multiple local profiles but no way to
directly compare their output.

## Proposed Scope

- New UI view: enter one prompt, get replies from two selected profiles
  side by side.
- Reuse the existing `/reply` endpoint with an explicit `modelProfile` per
  call rather than building a new inference path.
- Optionally let the user mark a preferred response (local-only, no
  telemetry).

## Acceptance Criteria

- Users can run the same prompt against two model profiles and see both
  replies side by side.
- No new backend inference path is introduced — this reuses `/reply` with
  different `modelProfile` values.
- Compare mode is opt-in from the UI, not the default chat flow.
