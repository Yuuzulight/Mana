# Issue 421: Per-Session Token/Cost Meter For Remote AI

## Goal

Surface a visible token/cost total when remote AI is enabled, so usage
isn't invisible until a bill or a rate-limit surprise.

## Why

Inspired by opencode's per-session token/cost tracking with configurable
budget thresholds. Mana already caps tool-call *count* per session but has
no token/cost visibility. Local inference has no metered cost, so this
only matters when `MANA_ALLOW_REMOTE_AI` is on. See
`docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Proposed Scope

- Track token usage per session when remote AI is enabled, using the
  provider's own response metadata where available.
- Surface a running total in the UI, plus an optional configurable
  warn/stop threshold.
- No change to local-only sessions -- nothing new to show when there's no
  cost to meter.

## Acceptance Criteria

- With remote AI enabled, a running per-session token/cost total is
  visible somewhere in the UI.
- An optional threshold can warn or stop further remote calls once
  crossed.
- Local-only (default) sessions show no new UI and have no behavior
  change.
