# Issue 427: Hunk-Level Accept/Reject In Editor-Handoff Proposals

## Goal

Let a reviewer accept some hunks of a proposed diff and reject others,
instead of only approving or rejecting the whole proposal.

## Why

Inspired by avante.nvim and Cursor, which support hunk-level review. See
`docs/roadmap/oss-inspiration-survey-2026-08.md`. Mana's
`editors/workspace/proposals` diff preview is all-or-nothing today.

## Proposed Scope

- Change the proposal data model to track hunks as individually
  addressable units.
- Update the review UI to allow per-hunk accept/reject within one
  proposal.
- Apply only the accepted hunks; reject the rest with the same rejection
  path as today.

## Acceptance Criteria

- A multi-hunk proposal can be partially accepted.
- Only accepted hunks are applied to the file.
- Single-hunk proposals behave exactly as before (no regression).
