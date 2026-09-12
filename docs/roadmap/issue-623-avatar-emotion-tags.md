# Issue 623: Add Inline Per-Sentence Emotion Tags To Drive Avatar Expression

## Goal

Make Mana's Live2D/VRM avatar change facial expression per-sentence in
response to what it's actually saying, without a separate
emotion-classifier model.

## Why

Two closely-related open VTuber/companion projects (pixiv's ChatVRM, and
the Live2D-focused Open-LLM-VTuber) use the same cheap technique: prompt
the LLM (via system prompt/few-shot) to prefix each sentence of its reply
with a bracketed emotion tag from a fixed vocabulary (`[happy]`,
`[angry]`, `[sad]`, `[relaxed]`, `[neutral]`, etc.). The client splits the
streamed text into these tagged segments as they arrive and switches the
avatar's blendshape/expression per segment, synced to when that chunk of
audio actually plays. No separate emotion-classifier model is needed --
the LLM self-labels as part of its normal output. Open-LLM-VTuber
additionally moves the emotion-keyword-to-expression-file mapping out of
code and into a per-avatar config file, so new avatars can be dropped in
by authoring a mapping file rather than touching parsing code.

This is directly applicable to Mana's existing avatar rendering with zero
new model dependencies, and works with any of Mana's swappable local chat
models via prompting alone.

## Proposed Scope

- Add the bracketed-emotion-tag convention to the chat LLM's system
  prompt/few-shot examples, with a small fixed vocabulary.
- Parse the tags out of the streamed reply in the Electron renderer and
  map each to a Cubism/VRM expression per sentence.
- Keep the emotion-to-expression mapping in a per-avatar config file (not
  hardcoded), so new avatars are just a mapping file.
- Decide how (or whether) to couple the emotion tag to Fish Speech TTS:
  since Fish Speech is reference-audio voice cloning rather than a
  discrete emotion-parameterized API (unlike ChatVRM's Koeiromap), the
  simplest first cut is to use the tag only for the face and leave TTS
  prosody alone; picking from multiple reference clips per emotion is a
  possible follow-up, not required for the first version.

## Acceptance Criteria

- The chat LLM reliably emits per-sentence emotion tags in its normal
  streamed output.
- The avatar's expression visibly changes per sentence in sync with
  playback, driven by the tags.
- Adding a new avatar only requires authoring a new emotion-to-expression
  mapping file, not code changes.

## Related

`docs/roadmap/oss-inspiration-survey-2026-09.md` (full research backing).
