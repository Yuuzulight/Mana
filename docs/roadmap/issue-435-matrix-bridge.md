# Issue 435: Matrix Bridge

## Goal

Add a self-hosted, E2EE messaging bridge alongside Discord and Telegram.

## Why

A self-hosted Matrix homeserver (Synapse/Dendrite) with Mana as a bot
user gives E2EE chat with a pairing-style DM flow similar to the existing
bridges, but federatable to other chat networks from one integration
point instead of one bridge per network. See
`docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Proposed Scope

- Follow the same shape as the existing Discord (#185) / Telegram (#151)
  bridges: opt-in, pairing-code approval.
- Target a self-hosted homeserver rather than a cloud vendor API.

## Acceptance Criteria

- Opt-in Matrix bridge works against a self-hosted homeserver with the
  same pairing-approval flow as Discord/Telegram.
- Off by default; no behavior change for users who don't configure it.

## Related

#151, #185
