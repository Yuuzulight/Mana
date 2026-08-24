# Issue 428: Restorable Snapshots For Applied Agent Edits

## Goal

Give applied editor-handoff edits an undo path beyond a raw `.bak` file.

## Why

Inspired by Cursor's checkpoints -- auto-snapshot before each agent
action, restorable from a timeline, deliberately independent of git
state. See `docs/roadmap/oss-inspiration-survey-2026-08.md`.

Not the same as #387, which verifies an edit landed on disk before
marking it applied (a write-verification check) -- this issue is about
undoing an edit that already applied successfully.

## Proposed Scope

- Snapshot affected file(s) before each applied edit, timestamped.
- Expose a restorable list in the UI, independent of git.
- Keep snapshots bounded (don't grow unbounded disk usage) -- prune old
  ones on some reasonable policy.

## Acceptance Criteria

- After an edit is applied, a snapshot exists that can restore the
  pre-edit file content.
- Restoring works without requiring a git repo or git history.
- Snapshot storage doesn't grow unbounded over normal use.

## Related

#387
