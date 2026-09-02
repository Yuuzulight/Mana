# Issue 492: Short-Video Generation + Social Auto-Publish Plugin

## Goal

Automate short-form video creation end to end -- script, narration, stock
footage, subtitles -- and publish it to TikTok/Instagram/YouTube Shorts,
as one opt-in plugin.

## Why

Inspired by harry0703/MoneyPrinterTurbo. Mana already has the generation-
side building blocks: image-generation (#149, ComfyUI-backed), local TTS
(Fish Speech/Kokoro/GPT-SoVITS) for narration, and an LLM for script
generation. No ffmpeg-based video compositing pipeline or stock-footage
sourcing integration exists today, and no social-platform publishing
integration exists anywhere in Mana today.

## History

An earlier version of this issue scoped publishing out as a trust-
boundary mismatch with Mana's companion identity. Revisited on
2026-08-25: this is wanted as a real social-automation capability, not
scoped down to generation-only. Publishing is in scope.

## Proposed Scope

- Opt-in plugin, following the existing self-contained plugin pattern:
  script generation (LLM) -> narration (existing local TTS) -> stock
  footage or generated video -> subtitle composition (ffmpeg) -> saved
  output.
- Cross-platform publishing to TikTok/Instagram/YouTube Shorts via each
  platform's own OAuth flow. This is the OAuth-gated plugin #268's
  credential broker scoping note was written for -- build the
  credential/trust design on that rather than inventing a new pattern.
- Off by default, explicit opt-in per platform -- local generation works
  without ever connecting a publishing account.

## Acceptance Criteria

- A user can generate a complete short video (script, narration,
  footage, subtitles) from a topic, saved locally, without connecting any
  publishing account.
- Opting into a specific platform's publishing requires that platform's
  own OAuth flow, stored per #268's credential broker design.
- No plugin behavior changes for users who don't enable this plugin.

## Related

#149, #268
