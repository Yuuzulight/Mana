# Issue 68: Dynamic VRAM Hotswap Tuning + Explicit VRAM Purge for TTS Services

## Goal

Tighten Mana's existing model-swap path so switching between local model
profiles (and between local TTS services) is fast, predictable, and doesn't
leave stale VRAM allocated — without loading multiple heavy models
simultaneously.

## Why

Mana already has real infrastructure for this, it just isn't tuned or
measured yet:

- `node-bot/ai/local-ai.js` already defines 4 named model profiles
  (`default`, `fast`, `quality`, `coding` — `LLAMA_MODEL_PROFILES`), and
  `selectLlamaModelProfileForPrompt()` already picks one per-request from
  prompt keywords.
- `node-bot/ai/llama-server-runtime.js`'s `ensureServerConfig()` already
  does a real hotswap: if the next reply needs a different model than the
  currently-loaded one, it logs `switching model X -> Y`, calls
  `stopAndWait()` (kills the child `llama-server.exe`, waits up to 5s for
  the port to free), then spawns the new one. Only one model is ever loaded
  at a time — there's no dual-load path to remove.
- What's missing: this swap isn't *measured* (no timing/telemetry on how
  long a swap actually takes), there's no debouncing (a single request
  with a coding keyword right after a casual one forces a full kill/respawn
  even for back-to-back turns), and `GGML_CUDA_ENABLE_UNIFIED_MEMORY` (a
  real llama.cpp/GGML build flag that lets inactive model weights page to
  system RAM instead of fully evicting) isn't used anywhere.
- Separately, Mana's **Python/torch-based** local services (Fish Speech's
  `api_server.py` per docs/fish_speech_tts.md, GPT-SoVITS, Kokoro) are
  where `torch.cuda.empty_cache()` / `gc.collect()` actually apply —
  llama.cpp's GGUF child-process model doesn't hold a Python/torch CUDA
  context, so "explicit memory purging" as literally described (PyTorch
  cache flush) is only meaningful for those services, not for the
  llama-server swap path. Worth scoping as a separate, smaller piece rather
  than conflating the two.
- `node-bot/model-management.js`'s `setActiveProfile()`/`getActiveProfile()`
  is currently close to vestigial: most replies re-derive their profile
  per-request via `selectLlamaModelProfileForPrompt()`, and only fall back
  to the stored active profile when a request omits `modelProfile` entirely
  (`server-routes.js`). Worth deciding whether this should become the real
  source of truth or stay a fallback.

## Proposed Scope

- Add timing telemetry around `ensureServerConfig()`'s swap path (log/measure
  actual stop→start→healthy latency) so "under 3 seconds" is a verified
  number on real hardware, not an assumption.
- Add debounce/hysteresis to `selectLlamaModelProfileForPrompt()`-driven
  swaps — e.g. don't swap away from a just-loaded model for N seconds
  unless the new request is unambiguous, to avoid needless thrashing on
  back-to-back mixed-topic turns.
- Evaluate `GGML_CUDA_ENABLE_UNIFIED_MEMORY=1` as a `llama-server.exe`
  launch flag in `startServer()` (llama-server-runtime.js) — measure
  whether it actually reduces cold-swap latency on this hardware (RTX
  3070 Ti, 8GB) versus a plain kill/respawn.
- Separately: add explicit `torch.cuda.empty_cache()` + `gc.collect()`
  calls to Mana's Python-based TTS services (Fish Speech's `api_server.py`,
  if/when Mana forks or wraps it; GPT-SoVITS's `api_v2.py` launch wrapper)
  around model load/unload, where a real persistent torch CUDA context
  exists.
- Decide and document whether `model-management.js`'s `setActiveProfile`
  should become the authoritative source of truth for the next reply's
  profile (removing the per-request re-derivation) or stay a
  fallback-only mechanism, since today it's ambiguous which one wins.

## Acceptance Criteria

- Real, measured swap latency (stop old model → healthy new model) is
  logged and documented for at least the default/coding profile pair.
- Debounce logic prevents a needless swap-and-swap-back within a short
  window of mixed-topic turns, with a documented threshold.
- `GGML_CUDA_ENABLE_UNIFIED_MEMORY` is evaluated with before/after
  numbers; only adopted as default if it measurably helps on real
  hardware.
- Fish Speech and/or GPT-SoVITS's Python-side services explicitly release
  CUDA memory on unload, verified via `nvidia-smi` before/after.
- `model-management.js`'s role (authoritative vs. fallback) is decided
  and documented, with existing behavior unchanged unless explicitly
  redesigned.

## Notes

Part of a 3-issue initiative:
- #69 — idle-triggered Dream Mode memory consolidation
- #70 — Best-of-N self-voting inference
