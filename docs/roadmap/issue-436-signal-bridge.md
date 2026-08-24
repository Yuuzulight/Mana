# Issue 436: Evaluate A Signal Bridge

## Goal

Decide whether a Signal bridge is worth the added Docker dependency.

## Why

`signal-cli-rest-api` is a local, Dockerized REST/WebSocket wrapper
around `signal-cli` that lets a self-hosted bot send/receive Signal
messages, including E2EE DMs, with no cloud vendor API involved. See
`docs/roadmap/oss-inspiration-survey-2026-08.md`.

## Note -- flagged as a bigger lift in the survey

Real and local, but introduces a Docker dependency Mana doesn't otherwise
have, unlike the Discord/Telegram bridges which are plain API clients.

## Proposed Scope

- Evaluate whether requiring Docker for one opt-in bridge is acceptable.
- If so, follow the same pairing-approval shape as the existing bridges.

## Acceptance Criteria

- A documented decision on the Docker-dependency tradeoff exists before
  any implementation starts.

## Related

#151, #185
