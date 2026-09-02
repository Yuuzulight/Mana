# Issue 488: Auto-Detect And Offer To Install Local AI Backends

## Goal

Reduce Mana's setup friction by detecting what's already installed and
offering to fetch/configure what's missing, instead of requiring the user
to walk through `docs/quick_start_windows.md` by hand.

## Why

Inspired by PurpleDoubleD/locally-uncensored, which auto-detects 12
different local AI backends and auto-installs ComfyUI on first run. Not a
duplicate of #225, which added ComfyUI as a second image-gen backend
*option* -- this is about detecting/installing what's missing, not adding
another provider choice.

## Proposed Scope

- Extend the Doctor/setup-check flow to detect already-installed local AI
  backends (existing llama.cpp/whisper.cpp installs, GGUF models in
  common locations).
- Offer to fetch/configure what's missing, with the manual path in
  `docs/quick_start_windows.md` remaining available as a fallback.

## Acceptance Criteria

- On first run with no config, Doctor reports what it found (or didn't)
  instead of a bare "not configured" state.
- A user with an existing llama.cpp/whisper.cpp setup doesn't need to
  hand-edit config to have Mana find it.
- Manual setup remains fully supported for users who prefer it.

## Related

#225
