# Mid-turn correction / amend (#399)

## Context

The barge-in interruption-handling feature (#339/#340, implemented in a
prior sub-project, see
[2026-08-20-barge-in-interruption-handling-design.md](2026-08-20-barge-in-interruption-handling-design.md))
classifies an interruption into one of four categories — `backchannel`,
`correction`, `new_question`, `unclassified` — and dispatches accordingly.
Issue #399 identifies a real gap in that set: a *correction that keeps the
same topic* ("no, the other file", "in Python not JS") today falls into
either `correction` (discard everything, unrelated fresh turn) or
`new_question` (answer as an unrelated new topic, then resume the stale
original). Neither preserves the fact that the user is steering the
*same* reply, not starting over.

This sub-project adds a fifth category, `amend`, that treats the
interruption as steering the in-flight reply rather than replacing or
supplementing it.

Per #399's own scoping note, this is explicitly a fifth category on the
existing decision table, sharing the same classifier, held-state
mechanism, and dispatch shape already built — not a parallel interrupt
path.

## Key finding that shapes this design

By the time a barge-in can fire (playback must already be underway),
the original reply's full text is already recorded in the session's
conversation history: `buildAssistantReply` (`node-bot/server.js:4381-4407`)
calls `acpMemoryStore.appendTurn({sessionId, user, assistant: reply, ...})`
immediately before returning, and `POST /reply/stream`'s final NDJSON
event — the earliest point any client-side playback of the *last*
sentence could even begin — is written only after `buildAssistantReply`
has fully returned. So an amend turn does not need to reconstruct or
re-supply the original reply's text: it's already in the session history
the next `/reply` call will read.

## Design

### 1. Classifier — `amend` category

New keyword/pattern set in `node-bot/utils/barge-in-classifier.js`,
checked **before** `correctionKeywords` (so "no, the other file" hits
`amend`, not `correction` — "no" would otherwise match first):

```js
const amendKeywords = [
  "the other",
  "i meant",
  "not that",
  "not this",
];
```

Plain keyword list, matching `classifyBargeIn`'s existing style exactly
(ordered list, `.includes()`/whole-word checks) — no regex, no pattern
matching beyond what the rest of the classifier already does. This
covers the issue's own examples ("no, the other file") and the common
"not X" contrastive shape via "not that"/"not this" without a separate
pattern-matching code path. The exact keyword list is refined during
implementation the same way `correctionKeywords`/`backchannelKeywords`
already were (start from these, add more if regression tests surface
gaps) — this is a design requirement (amend-shaped phrasing checked
ahead of `correction`), not a placeholder for missing logic.

Returns `{ category: "amend", reason: "matched_amend_keyword (...)" }`
or `{ category: "amend", reason: "contrastive_shape" }`.

Category ordering in `classifyBargeIn`: `amend` → `correction` →
`new_question` → `backchannel` → length-based fallback (unchanged from
#339/#340's shipped behavior).

### 2. Dispatch (both apps) — same shape as `correction`, different framing

`amend` discards the held reply — nothing is resumed, since the amended
reply *replaces* what was being said, it doesn't supplement it. The
transcript is sent as a new turn through the same
`handleTranscript`/`handleTranscriptText` path `correction` already
uses, with one difference: the transcript is wrapped with a light
instructional prefix before sending, e.g.
`"(amending what you just said) " + transcript`, so the model — which
already has the original reply in its session history per the Key
Finding above — produces a corrected continuation instead of an
unrelated fresh answer.

No new backend endpoint, no new request fields, no schema changes: this
is entirely a classifier category plus a client-side text wrapper on an
existing dispatch path.

```js
if (category === "amend") {
  heldReply = null;
  if (transcript) {
    await handleTranscript(`(amending what you just said) ${transcript}`, gamingModeActive);
  }
  return;
}
```

(desktop-client's equivalent calls `handleTranscriptText` with the same
wrapped string.)

### 3. No LLM-abort, no held-text reconstruction

Consistent with #339's standing constraint (generation is never
aborted): the original generation has already finished by the time an
amend interruption can fire (per the Key Finding). Nothing new needs to
be tracked — `heldReply` is simply nulled, exactly like `correction`'s
branch already does.

## Testing

- `classifyBargeIn`: new test cases for `amend` — phrases matching the
  keyword list ("no, the other file", "I meant the second one", "not
  that one, the other one"), confirming `amend` wins over `correction`'s
  "no" match, and confirming `amend` is checked ahead of
  `new_question`/`backchannel` where an amend-shaped phrase might
  otherwise also look question-shaped.
- Known gap, accepted for this pass: a bare contrastive phrase with
  neither "the other" nor "i meant" nor "not that"/"not this" (e.g. "in
  Python not JS") won't match the initial keyword list and falls through
  to `new_question` instead of `amend` — still gets answered, just
  without the "no resume" amend framing. Matches this codebase's existing
  keyword-classifier tradeoff (`intent-classifier.js`, `correctionKeywords`,
  etc. are all fixed lists, not general pattern matchers); can be
  widened later if this proves common in practice.
- Renderer-side dispatch: same "not unit-testable, verified via final
  review and live manual testing" scoping as #339/#340 — the state
  machine itself has no automated coverage in either app.

## Explicitly out of scope

- Steering an actually-in-flight LLM generation stream (would require
  revisiting the no-abort constraint) — the amend turn is a fresh
  generation informed by session history, not a mid-stream edit.
- Any new backend endpoint or request schema — amend reuses the existing
  `/reply`(`-stream`) path with a client-side text wrapper.
- Distinguishing "amend" from "correction" beyond keyword/pattern
  matching (e.g. semantic/LLM-based classification) — matches the
  existing keyword-classifier house style.
