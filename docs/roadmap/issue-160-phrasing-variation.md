# Issue 160: Anti-Formulaic-Phrasing Rewrite Pass

## Goal

Catch Mana's own well-worn catchphrases/openers/kaomoji before a reply
goes to TTS, and vary just that part -- not the whole reply -- without
touching the actual content/meaning. Pairs with windows-launcher's
existing `reply-emotion.js` (which reads kaomoji/emoji in the final text
to pick an avatar mood) rather than replacing it.

## Status: Implemented (`node-bot/phrasing-variation.js`, core, always on)

- **`DEFAULT_LEXICON`**: a small, hand-curated set of Mana's known
  openers (`Mou,`/`Hmph,`/`Geez,`/`Well, well,`/`Fufu,`), catchphrases
  ("not that I care", "don't get the wrong idea", "I guess I could
  help", "if you insist"), and the exact kaomoji `persona.js` already
  names as examples ((＾▽＾), (T_T), (｀・ω・´)). Deliberately not
  learned -- matches this codebase's existing deterministic-before-ML
  bias (skills pruning, issue #140). Edit the array directly to retune
  Mana's tics; no admin UI, per the issue's own scope.
- **`createPhrasingVariator({lookback=3})`**: `checkReply(sessionId,
  replyText)` finds whether the reply contains a lexicon match, and
  whether that specific lexicon entry was already used in one of the
  session's last `lookback` recorded replies. `recordUsage` is called
  separately, once the *final* reply text is known (after any rewrite),
  so history reflects what Mana actually said rather than what she
  almost said.
- **`rewritePhrase(matchedText, {synthesize})`**: one small, targeted
  completion -- rewrites only the matched fragment (a few words), not
  the whole reply. Strips wrapping quote marks from the model's answer.
  `synthesize` is injected so this module has no direct knowledge of
  which model/runtime is in use.
- **`server.js` wiring**: runs last in the reply pipeline, right before
  the reply is recorded/returned -- after the verify/retry loop, since
  that loop can still replace the reply wholesale, and this needs to see
  whatever text will actually be spoken, not an intermediate draft. On a
  predictable match, one short (`maxTokens: 40`) completion asks for an
  alternate phrasing of just that fragment, using a plain "concise
  writing assistant" system prompt override rather than Mana's persona
  voice (this is a utility rewrite task, not an in-character reply).
  `MANA_PHRASING_VARIATION_ENABLED` (default "1") turns it off entirely;
  `MANA_PHRASING_LOOKBACK` tunes the window.

## Deliberate simplifications

- **Not a general anti-AI-slop rewriter.** Scoped specifically to Mana's
  own persona catchphrases via the hand-curated lexicon, per the issue's
  explicit "out of scope" section.
- **Hand-curated lexicon, not learned from usage.** Per the issue's own
  scope, matching the "deterministic before ML" bias elsewhere in this
  codebase.
- **One targeted rewrite call, not a loop.** If the model's alternate
  phrasing happens to be identical (case-insensitively) to the original,
  the original is kept rather than retrying.

## Verified

- `node-bot/test/phrasing-variation.test.js` (10 tests): lexicon
  detection (opener, kaomoji, no-match), first-use vs. repeated-within-
  lookback flagging, lookback-window boundary, per-session history
  isolation, a genuinely varied reply passing through untouched, and
  `rewritePhrase`'s prompt construction + quote-stripping + required-
  `synthesize` validation.
- `node-bot/test/server-routes.test.js` (62 tests): full regression pass
  after wiring the check into the reply pipeline (enabled by default).
