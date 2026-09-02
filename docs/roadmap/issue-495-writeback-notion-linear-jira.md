# Issue 495: Scheduled/Event Write-Back To Notion, Linear, Jira

## Goal

Let a cron job or research result push output into an external
productivity tool the user already keeps notes/tasks in, not just Mana's
own memory and the Obsidian vault sync.

## Why

Inspired by SurfSense's scheduled/event-triggered write-back to Notion,
Slack, Linear, and Jira. Mana has a cron scheduler plugin (#144) and
syncs memory to a local Obsidian vault, but nothing pushes to an external
service.

## Proposed Scope

- Start with Notion -- the most companion-relevant of the four (Linear/
  Jira lean team/engineering-tool rather than personal).
- Opt-in write-back target, following the existing plugin
  opt-in/credential pattern.
- Triggered by a cron job (#144) or explicitly by a research result, not
  automatic/unprompted.

## Acceptance Criteria

- A user can configure a Notion write-back target and have a scheduled
  or triggered result pushed there.
- Off by default; no behavior change without configuration.

## Related

#144
