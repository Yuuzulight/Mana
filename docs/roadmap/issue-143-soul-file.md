# Issue 143: Durable SOUL File

## Goal

Give Mana's persona one clearly-separated, easily-editable file distinct
from operational/context config, plus a session-scoped temporary override
for one-off mode switches.

## Finding: the persona was already scattered and drifting

Before this, "who Mana is" was hand-copied across four places:
`local-llama-runtime.js`'s `DEFAULT_SYSTEM_PROMPT`, an identical fallback
string inside `server.js`'s `runOpenAIReply`, and three separate per-mode
prompts (`CASUAL_SYSTEM_PROMPT`/`EVERYDAY_SYSTEM_PROMPT`/
`CODING_SYSTEM_PROMPT`) that each redefined Mana's personality from scratch
with slightly different wording. Editing Mana's personality meant touching
up to five places and risking them drift further apart.

## Status: Implemented

- **`node-bot/persona.js`** (new file): `MANA_PERSONA` is the single
  identity baseline. `DEFAULT_SYSTEM_PROMPT` composes it with the one extra
  instruction the old local-runtime default had (keep replies
  spoken-conversation-shaped). `setPersonaOverride`/`getPersonaOverride`/
  `clearPersonaOverride` manage an in-memory, session-scoped Map;
  `buildPersonaPrompt(sessionId)` returns the base persona, or the base
  plus that session's override if one is set.
- **`local-llama-runtime.js`** no longer hand-defines `DEFAULT_SYSTEM_PROMPT`
  -- it imports it from `persona.js` and re-exports it unchanged, so
  `llama-server-runtime.js` (which imports it from here) needed no changes.
- **`server.js`**: `runOpenAIReply`'s fallback now reads
  `persona.DEFAULT_SYSTEM_PROMPT` instead of a second hardcoded copy. The
  three mode prompts now compose `persona.buildPersonaPrompt(sessionId)`
  (identity) with just their mode-specific *operational* instructions
  (format, tone-of-task, output shape) -- the redundant personality
  preambles each used to carry are gone.
- **Session override routes**: `POST /persona/override` (body:
  `sessionId`, `override`) and `POST /persona/override/clear` (body:
  `sessionId`). Applied automatically the next time `buildAssistantReply`
  builds a mode prompt for that session -- no restart, no edit to
  `persona.js` itself, and it reverts cleanly via the clear route.

## Wording consolidation is a real (small) behavior change

Merging four descriptions of Mana's personality into one necessarily
changed the exact prompt text sent to the model for the `casual`,
`everyday`, and `coding` modes -- each previously had its own personality
preamble with slightly different phrasing; now all three share
`MANA_PERSONA` verbatim. This was flagged to the user for review rather
than presented as a silent side effect, since prompt tone here was
deliberately hand-tuned before (issue #39).

## Deliberate simplifications

- **No slash-command system for switching modes.** Just two small routes;
  something above them (a chat command, a UI toggle) can call them later
  if wanted, matching the issue's explicit "a simple session-scoped
  override flag is enough for v1."
- **Persisted history (13 already-merged commits, etc.) is untouched.**
  This only changes what's sent to the model going forward.

## Verified

- `node-bot/test/persona.test.js` (7 tests, new): `DEFAULT_SYSTEM_PROMPT`
  builds on `MANA_PERSONA`; override layering, session isolation, clearing,
  rejecting empty input, and reading back the raw override text.
- `node-bot/test/server-routes.test.js` (62 tests, 3 new): both persona
  routes, including the missing-field rejection case.
- `node-bot/test/llama-server-runtime.test.js` (28 tests): unaffected by
  the `DEFAULT_SYSTEM_PROMPT` source change.
