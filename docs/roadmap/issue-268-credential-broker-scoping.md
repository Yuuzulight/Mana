# Issue 268 (part 2): local credential broker -- scoping notes (not scheduled)

## Status: design note only, no OAuth-gated plugin exists to build this for yet

Part 1 of issue #268 (restricting `read_file` from `.env`, `ai/tool-policy.js`)
shipped. This document covers part 2: what a local, self-hosted credential
broker would look like *if* Mana ever adds an OAuth-gated plugin (a real
external service requiring a user login/token). Nothing here is implemented;
it exists so that whoever picks up the first OAuth plugin doesn't have to
design the trust boundary from scratch under deadline pressure.

## Why this isn't just "put the token in `.env` like everything else"

Every credential Mana holds today (Discord/Telegram bot tokens, TTS provider
keys) is a **service credential**: Mana herself is the identity, scoped to
what Mana is allowed to do, and losing it is bad but bounded. An OAuth token
is different in kind: it's typically **the user's own identity** on a real
account (email, calendar, a paid service), often with broad scope by default,
and frequently refreshable/long-lived. The read_file fix (part 1) already
established the actual threat model that matters here -- not the model
choosing to misuse a credential, but a prompt-injected instruction (hidden in
a page Mana reads, a doc she's asked to summarize) getting a tool call to
exfiltrate one. A `.env`-style flat file readable by any tool-execution code
path is an acceptable risk for a service credential Mana already has by
design; it is not acceptable for the user's own external-account access.

## The shape

- **A separate local process**, not a library imported into `node-bot`.
  Process isolation is the actual point: `node-bot`'s own crash, a bug in a
  plugin, or a compromised tool-execution path never has a code path that
  reaches into the broker's memory or storage directly.
- **RPC-only surface, not token retrieval.** The broker never hands a raw
  token to a caller. It exposes verbs like `call(service, action, params)`
  that make the authenticated request *inside the broker* and return only
  the result. This is the load-bearing design choice -- if the broker's API
  shape ever includes something like `getToken(service)`, the whole
  isolation boundary collapses back to "a slightly-harder-to-find `.env`".
- **Token material never enters `node-bot`'s process, node-bot's `data/`
  directory, or the model's context.** Stored in the broker's own local
  storage (OS keychain via something like `keytar`, or an encrypted local
  file the broker alone holds the key for -- a concrete choice for whoever
  implements this, not decided here).
- **The OAuth flow itself (browser redirect, code exchange, refresh) lives
  entirely in the broker**, triggered by a one-time manual step (open a
  local broker UI/URL, click "Connect X"), not by anything the model
  initiates or that a tool call can trigger.
- **A plugin that needs the external service asks the broker to act, not
  the token to act with.** E.g. a hypothetical calendar plugin would call
  `broker.call("google-calendar", "listEvents", {...})`, never see a token,
  never construct the authenticated HTTP request itself.

## What already fits this shape

- Mana's plugin architecture (`plugins/*/index.js`, capability
  enable/disable via `GET /plugins`) already treats each integration as a
  bounded, independently-toggleable unit -- an OAuth plugin would slot into
  the same pattern, just with its actual API calls routed through the
  broker instead of a direct `fetch`.
- The approval-gate pattern (issue #152) already establishes "agent-authored
  or agent-initiated action gets a human checkpoint" as a norm in this
  codebase -- the broker's one-time "Connect X" step is the same idea
  applied to credential *acquisition* instead of content *creation*.

## Explicitly not decided here

- Which broker implementation (a tiny bespoke Node process vs. an existing
  local credential-manager tool) -- no OAuth plugin exists yet to make this
  a real decision instead of a guess.
- Whether the broker is one shared process for all future OAuth-gated
  plugins or one per plugin -- shared is the obvious default (less to run),
  revisit if a real second integration shows the isolation should be
  per-service instead.
- UI for the "Connect X" step -- almost certainly a small addition to
  Settings > Plugins, not scoped further than that here.

Revisit when a specific OAuth-gated plugin is actually being built, not
before.
