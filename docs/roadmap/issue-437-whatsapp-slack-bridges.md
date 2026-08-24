# Issue 437: Evaluate WhatsApp/Slack Bridges

## Goal

Record why WhatsApp and Slack were considered and ruled out, so the
question doesn't get re-asked from scratch later.

## Why

Mana has opt-in Discord (#185) and Telegram (#151) bridges. WhatsApp and
Slack were considered as further options during the 2026-08 OSS survey.

## Findings

WhatsApp has no compliant local bridge -- only reverse-engineered,
ToS-risk libraries exist. Slack has no meaningful local/self-hosted
server option. Both fail Mana's local-first, no-cloud-mandatory-dependency
constraint on the merits, not on effort. See
`docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Proposed Scope

None -- this is a scoped-out record, not planned work.

## Acceptance Criteria

N/A -- close as not-planned unless a compliant local option emerges for
either platform.

## Related

#151, #185
