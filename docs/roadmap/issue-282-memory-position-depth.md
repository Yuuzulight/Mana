# Issue 282: Positionable Memory Injection (Depth/Position Control)

## Goal

Memory (the session summary, recent turns, cross-session related facts) used
to get flattened into one block of text glued onto the persona system
prompt, with no control over where it sits relative to the live user
message. The issue asked for SillyTavern-style "depth" control: let memory
become its own message(s), positioned independently.

## Status: Implemented (`node-bot/acp-memory-store.js`,
`node-bot/ai/llama-server-runtime.js`, `node-bot/server.js`)

`llama-server` already speaks a standard OpenAI-compatible `messages` array
over `/v1/chat/completions` -- the wire protocol never needed to change.
Only the application code that built exactly two messages (`system`,
`user`) before every call needed to change.

- `acp-memory-store.js` gains `buildPromptMemoryEntries(sessionId, options)`
  and `getRelatedFactsEntries(text, options)` -- structured-entry siblings
  of the existing `buildPromptMemory`/`getRelatedFacts`. Both pairs share
  their internal gathering logic (`gatherRelatedFactsBlocks`,
  `selectPartsWithinTokenBudget`) so the token/char budgeting behavior is
  identical; the existing string-returning functions are untouched, so
  none of their ~15 existing test assertions needed to change. Each entry
  is `{role: "system", position: "early"|"late", content}`. Defaults:
  session summary -> `"early"` (durable background, belongs near the
  persona), recent turns and related facts -> `"late"` (right before the
  live user message -- the higher-salience slot, since what was *just*
  discussed or previously said about the current topic is most relevant to
  what's being asked right now).
- `ai/llama-server-runtime.js`'s `runLocalAssistantReply` and
  `runToolAwareReply` take a new optional `extraMessages: {early, late}`
  param, spliced into the messages array as
  `[system, ...early, ...late, user]`. Omitting it preserves the exact
  2-message shape every other existing caller already depends on.
- `server.js`'s reply pipeline builds `memoryExtraMessages` once per reply
  from the two new structured functions, and passes it to the two reply
  paths that support a real messages array (the tool-calling path and the
  plain local-assistant fallback). Paths that only take a flat
  system-prompt string (the OpenAI proxy, Best-of-N -- neither builds a
  messages array of its own) fall back to `flatMemorySuffix`, the same
  content flattened back into text, so they don't lose memory context.

## Why `ai/local-llama-runtime.js` (the llama-cli fallback) is untouched

It has no `runToolAwareReply` at all and its `runLocalAssistantReply` uses
flat `-sys`/`-p` CLI string args, not a messages array -- there's no
tool-calling or memory-injected reply path through it to extend. Traced
during scoping, not assumed.

## Why Best-of-N and the OpenAI proxy path keep the old flattened text

Extending three more call sites (`runBestOfNReply` here, plus the OpenAI
proxy's own request shape) to support positioned messages was out of scope
for what was asked and would touch two more narrowly-used, opt-in paths
(Best-of-N is coding-mode-only and env-gated off by default) for no real
gain -- their system prompt still carries the memory content, just not
independently positioned. If depth control on those paths becomes worth
having, `memoryExtraMessages`/`flatMemorySuffix` are both already built at
the call site and available to wire in.

## Test coverage

`test/acp-memory-store.test.js`: `buildPromptMemoryEntries` returns the
same content `buildPromptMemory` would combine, honors position overrides,
and returns `{entries: []}` for an empty/unknown session;
`getRelatedFactsEntries` returns mentions and facts as separate `"late"`
entries and `{entries: []}` when nothing matches.
`test/llama-server-runtime.test.js`: `runLocalAssistantReply` and
`runToolAwareReply` both splice `extraMessages.early`/`.late` into the
right positions, and both keep the old 2-message shape when it's omitted.

## Out of scope

No change to how live conversation turns themselves are represented (a
much larger, unrequested restructure), no depth control for Best-of-N or
the OpenAI proxy path (see above), no user-facing UI for choosing
positions -- the defaults above are the only behavior exposed right now.
