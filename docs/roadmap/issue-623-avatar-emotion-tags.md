# Issue 623: Add LLM-Emitted Emotion Tags And Per-Avatar Config Mapping (Electron Has Heuristic Detection; Native Has None)

## Correction notice

A follow-up codebase audit (2026-09-12) found this issue's premise was
wrong for Electron: `windows-launcher` already does per-sentence,
playback-synced mood detection, just via heuristics rather than
LLM-emitted tags. Native genuinely has nothing. Scope narrowed and
corrected accordingly.

## Goal

Replace Electron's heuristic per-sentence emotion detection with
LLM-emitted bracket tags and an external per-avatar config mapping, and
bring native up to at least Electron's current level.

## Why

The original research assumed "Mana has no per-sentence
emotion-tag-driven expression system today." That's false for Electron,
though the *specific mechanism* proposed (LLM-emitted tags) is still a
genuine gap:

- **Electron already does per-sentence detection**:
  `windows-launcher/renderer/reply-emotion.js`'s `detectReplyEmotion()`
  runs per streamed sentence chunk inside `playStreamingReply()`
  (`renderer.js` ~1600-1609), switching avatar mood in sync with
  playback. It's heuristic (kaomoji/emoji/word matching), not
  LLM-tag-driven -- this is the real gap worth closing, per the original
  research's rationale (an LLM self-labeling via prompting is more
  reliable and language-agnostic than keyword matching).
- **The mapping is hardcoded, not config-driven**: the emotion-to-expression
  binding lives in a hardcoded table (`STATE_EXPRESSION_PREFERENCES` in
  `live2d-logic.js`, ported to `AvatarExpressionSelector.cs` for native)
  rather than an external per-avatar config file -- the original
  research's proposal to move this to a config file is still valid and
  unimplemented.
- **Native has nothing**: `windows-native-launcher`'s streaming path has
  no per-sentence emotion detection at all -- `VoiceLoop.cs` explicitly
  comments this is "a deliberate scope cut." Native is currently behind
  Electron here, not at parity.

## Proposed Scope

- Add the bracketed-emotion-tag convention (`[happy]`, `[angry]`, etc.)
  to the chat LLM's system prompt/few-shot examples, replacing or
  supplementing `detectReplyEmotion()`'s heuristic.
- Parse the tags out of the streamed reply and drive the same
  per-sentence expression switching `playStreamingReply()` already does,
  in both Electron and native.
- Move the emotion-to-expression mapping out of the hardcoded
  `STATE_EXPRESSION_PREFERENCES`/`AvatarExpressionSelector.cs` tables
  into a per-avatar config file.
- Port whichever mechanism is chosen (heuristic or LLM-tag) to
  `windows-native-launcher`'s `VoiceLoop.cs`, which currently has none.

## Acceptance Criteria

- The chat LLM reliably emits per-sentence emotion tags in its normal
  streamed output, and the avatar's expression changes per sentence in
  sync with playback using those tags (not just the existing heuristic).
- Adding a new avatar only requires authoring a new emotion-to-expression
  mapping file, not code changes.
- `windows-native-launcher` has per-sentence emotion-driven expression
  switching, matching or exceeding Electron's current behavior.

## Related

`docs/roadmap/oss-inspiration-survey-2026-09.md`.
