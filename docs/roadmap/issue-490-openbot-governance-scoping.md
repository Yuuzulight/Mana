# Issue 490: OpenBot-Style Multi-Agent Governance -- Scoping

## Status: investigation complete, not adopted -- named condition for revisiting

Scoping note. No code changes. The question: does Mana need anything like
CopilotKit/OpenBot's multi-agent enterprise governance model?

## What OpenBot is

A platform for deploying many independent AI agent "coworkers," each in
its own container with its own browser/logins, behind a centralized
policy gateway that validates every action pre-execution and keeps a full
audit trail, with multi-user SSO (Google/Microsoft/Okta/SAML/OIDC).

## What Mana already has

The single-user version of most of this already exists or is already
in progress: the approval gate (#152) reviews agent-authored actions
pre-execution, the unified tool-execution audit layer (#188) logs and
gates tool calls, #284 adds a second-model "Guardian" pre-check ahead of
human approval, #352 is evaluating an OS-level sandbox boundary for
generated-skill execution, and #426 proposes user-configurable pre/post-
tool hooks. Deep Research's parallel subagent delegation (#145) already
runs multiple subagents concurrently -- but those are read-only research
subagents, not independently-acting agents with separate credentials or
trust boundaries.

## Why OpenBot's model doesn't map directly

OpenBot solves a problem Mana doesn't have: many *different* agents, on
behalf of many *different* users, who don't trust each other by default
and so need separate identity, credentials, and audit trails. Mana is one
always-on assistant for one user -- there's no multi-tenant boundary to
govern, and OpenBot's SSO/multi-user surface has no target user in Mana's
architecture.

## Verdict: not now

Mana's existing single-user governance path (approval gate + audit layer
+ Guardian pre-check + the in-progress hook/sandbox work) already covers
today's actual risk surface. Building multi-tenant machinery ahead of a
need for it would be infrastructure with no user.

**Named condition for revisiting**: if Mana ever spawns multiple
independently-acting subagents (beyond Deep Research's read-only research
fan-out) that need genuinely separate credential/trust boundaries -- e.g.
one subagent per plugin task with different external-service access --
OpenBot's policy-gateway-plus-audit-trail shape becomes directly relevant
then, not before.

## Salvaged piece

OpenBot's mid-task manual control handoff -- distinct from Mana's
approval gate, which only reviews *before* execution -- was split out as
its own idea. See #491.

## Related

#152, #188, #284, #352, #426, #145, #491
