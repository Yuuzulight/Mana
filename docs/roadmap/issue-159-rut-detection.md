# Issue 159: Conversational Rut Detection

## Goal

Give Mana's reply pipeline a check against her own recent replies: before
a reply is finalized, compare it to her last N replies for repetition,
and if it's too similar, prefer a different candidate or regenerate with
a nudge instead of sending it as-is. A persona with a fixed set of verbal
tics (kaomoji, catchphrases, sentence openers) is especially prone to
this over a long session.

## Best-of-N is coding-only -- the literal scope wouldn't actually fire on conversation

The issue's scope says to wire this into "the existing Best-of-N
candidate-selection step" (issue #43/#70). Auditing before building:
Best-of-N is gated on `mode === "coding"` with a "terse code reviewer"
judge -- it never runs for casual/everyday conversation, which is exactly
where verbal-tic repetition (the issue's actual concern) shows up.
Wiring the rut check only into Best-of-N as literally worded would
satisfy the letter of the issue but never fire in the scenario it's meant
to catch. Confirmed with the user before building: the detector is wired
into **both** Best-of-N's candidate selection (as asked) **and** the
general single-shot reply path that every mode -- including
casual/everyday -- actually funnels through.

## Status: Implemented (`node-bot/rut-detection.js`, core, always on)

- **`computeNGramSimilarity(textA, textB, n=3)`**: Jaccard similarity over
  word n-grams (no embedding model, matching the `manneri` project this
  issue is modeled on). Falls back to unigram overlap when either text is
  too short to produce any 3-grams, so two short-but-identical replies
  don't score a false 0.
- **`createRutDetector(options)`**: `lookback` (default 10 -- how many
  recent replies to compare against), `similarityThreshold` (default
  0.5), `cooldownReplies` (default 3 -- replies to skip checking after an
  intervention, so breaking a rut doesn't degrade into constant
  regeneration), `minMessageLength`/`excludeKeywords` (trivially short
  replies/exact acknowledgements like "okay"/"yeah" are excluded from
  both sides of the comparison). All four are env-var configurable
  (`MANA_RUT_LOOKBACK`/`MANA_RUT_SIMILARITY_THRESHOLD`/
  `MANA_RUT_COOLDOWN_REPLIES`), matching how other tuning knobs in this
  codebase work -- no UI, per the issue's own scope.
- **`checkReply(sessionId, replyText, recentReplies)`**: the general
  reply-path entry point. Consumes exactly one cooldown tick per call
  (one call = one reply being finalized), so a cooldown set by an
  intervention correctly covers the next N *replies*, not the next N
  candidates compared within a single reply.
- **`pickLeastRepetitive(sessionId, candidates, judgeIndex,
  recentReplies)`**: the Best-of-N entry point. Best-of-N already pays
  for N candidates, so rather than trusting the judge's pick blindly or
  paying for a whole extra regeneration call, this prefers whichever
  already-generated candidate scores lowest against recent history.
  Reports `needsRegeneration: true` only when every candidate on hand is
  a rut (nothing better to switch to).
- **`server.js` wiring**: `replyMaybeWithBestOfN`'s success branch now
  calls `pickLeastRepetitive` against the session's recent assistant
  turns (from `acpMemoryStore`) before returning a candidate. Separately,
  right after `reply = await replyMaybeWithBestOfN(finalPrompt)` (the
  point every mode's reply funnels through, Best-of-N or not),
  `checkReply` runs against the same recent-turns history; if it flags a
  rut, one regeneration call fires with an explicit "say this differently"
  nudge appended to the prompt, and `recordIntervention` starts the
  cooldown. `MANA_RUT_DETECTION_ENABLED` (default "1") can turn this off
  entirely.

## Deliberate simplifications

- **No full conversation-level topic/keyword-bias tracking.** Per-reply
  repetition only, per the issue's explicit scope -- this is the piece
  that plugs directly into Best-of-N and the general reply path.
- **No tuning UI.** Env-var config only, per the issue's own "out of
  scope" section.
- **One regeneration attempt on the general path, not a loop.** If the
  regenerated reply is still a rut, it gets sent anyway rather than
  retrying indefinitely -- matches the existing reply-verification
  auto-retry's own `maxRetries`-bounded behavior elsewhere in this file.

## Verified

- `node-bot/test/rut-detection.test.js` (14 tests): n-gram similarity
  (identical/unrelated/short-text fallback/symmetry), rut flagging
  against recent replies, exclusion of short replies and exact
  acknowledgements, lookback-window boundaries, cooldown suppressing
  checks for the configured number of *replies* (not candidates) and
  expiring correctly, per-session cooldown isolation,
  `pickLeastRepetitive`'s keep/switch/needsRegeneration branches
  (including respecting cooldown the same way `checkReply` does), and
  case-insensitive exclude-keyword matching.
- `node-bot/test/server-routes.test.js` (62 tests): full regression pass
  after wiring both the Best-of-N candidate-selection hook and the
  general reply-path check into `server.js` -- confirms the new checks
  (which run by default, `MANA_RUT_DETECTION_ENABLED` defaults to "1")
  don't break any existing reply-pipeline test.
