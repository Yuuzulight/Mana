# Issue 68: Dynamic VRAM Hotswap Tuning for Local Model Profiles + Explicit VRAM Purge for TTS Services

## Goal

Tighten Mana's existing model-swap path so switching between local model
profiles (and between local TTS services) is fast, predictable, and doesn't
leave stale VRAM allocated — without loading multiple heavy models
simultaneously.

## Why

Mana already has real infrastructure for this, it just isn't tuned or
measured yet — see the original issue body for the full context on
`local-ai.js`'s model profiles, `llama-server-runtime.js`'s hotswap path,
and `model-management.js`'s active-profile tracking.

## Proposed Scope

- Add timing telemetry around `ensureServerConfig()`'s swap path.
- Add debounce/hysteresis to avoid needless swap-and-swap-back thrashing.
- Evaluate `GGML_CUDA_ENABLE_UNIFIED_MEMORY=1` with real before/after numbers.
- Add explicit `torch.cuda.empty_cache()` + `gc.collect()` to Mana's
  Python-based TTS services around model load/unload.
- Decide and document whether `model-management.js`'s `setActiveProfile`
  should be the authoritative source of truth or stay fallback-only.

## Acceptance Criteria

- Real, measured swap latency is logged and documented for the
  default/coding profile pair.
- Debounce logic prevents a needless swap-and-swap-back, with a documented
  threshold.
- `GGML_CUDA_ENABLE_UNIFIED_MEMORY` is evaluated with before/after numbers;
  only adopted as default if it measurably helps.
- Fish Speech and/or GPT-SoVITS explicitly release CUDA memory on unload,
  verified via `nvidia-smi` before/after.
- `model-management.js`'s role is decided and documented, existing behavior
  unchanged unless explicitly redesigned.

## Status

Implemented, with two acceptance criteria answered as "not applicable given
current architecture" rather than forced — see below.

### Swap timing telemetry

`ensureServerConfig()` in `node-bot/ai/llama-server-runtime.js` now times
every real swap (stop-old → healthy-new) and:
- logs it via the existing `logPerf("llama-server-swap", startedAt)` metrics
  pipeline (same one every other timed operation already reports through),
- logs a plain `console.log` line with the duration,
- exposes it as `getStatus().lastSwapMs` (`null` until the first real swap
  happens — a cold start from nothing running isn't a swap).

### Debounce

A new `state.loadedAt` timestamp tracks when the *currently loaded* model
became healthy (set on every successful start, cold or swapped). If a
different model is requested while `nowMs() - state.loadedAt` is still under
`LLAMA_SERVER_SWAP_DEBOUNCE_MS` (default **3000ms**), the swap is skipped for
that reply — Mana answers from whichever model is already loaded instead of
paying a full kill/respawn for what might be one stray back-and-forth turn.
Set `LLAMA_SERVER_SWAP_DEBOUNCE_MS=0` to disable. Every debounced skip is
logged so it's visible, not silent.

Real-world caveat worth being explicit about: as currently wired,
`selectLlamaModelProfileForPrompt()`'s keyword-inference branch (the thing
that would pick "coding" from a prompt containing the word "debug") is
**not reachable from `buildAssistantReply()` today** — see the
model-management.js section below for why. The debounce still does its job
(protecting against *any* rapid profile flip, from any future caller that
does hit the inference path, or from a client explicitly toggling profiles
quickly), it just isn't preventing a scenario that's live in the current UI.

### GGML_CUDA_ENABLE_UNIFIED_MEMORY — measured, and now the default

Measured directly on the actual hardware this runs on (RTX 3070 Ti, 8GB,
with FFXIV and LM Studio also holding VRAM at the time — i.e. under real
contention, not an idle GPU), swapping between the default (Qwen3-4B) and
coding (qwen2.5-coder-7b) profiles:

| | cold start (4B) | swap 4B→7B | swap 7B→4B |
|---|---|---|---|
| plain | 11,370ms | 21,025ms | 7,154ms |
| `GGML_CUDA_ENABLE_UNIFIED_MEMORY=1` | 4,074ms | 14,261ms | 7,131ms |
| **delta** | **−64%** | **−32%** | ~unchanged |

This clears the "measurably helps" bar clearly enough that it's now **on by
default** (`buildServerEnv()` in `llama-server-runtime.js` sets
`GGML_CUDA_ENABLE_UNIFIED_MEMORY=1` for the spawned `llama-server.exe`
process unless `MANA_LLAMA_UNIFIED_MEMORY=0` opts out).

### TTS VRAM purge — not applicable, documented why

Investigated Fish Speech (`tools/fish-speech/tools/api_server.py`) and
GPT-SoVITS (`tools/gpt-sovits/api_v2.py`) specifically for a real hook point,
and found there isn't a good one today:

1. **Both are vendored third-party packages**, each with its own bundled
   Python runtime under `tools/`. Neither is a Mana-authored wrapper —
   patching `torch.cuda.empty_cache()` calls into them directly means
   patching upstream code Mana doesn't own or track for updates. The
   original issue text itself flagged this as conditional ("if/when Mana
   forks or wraps it") rather than a firm requirement.
2. **There's no unload/swap lifecycle to hook into even if it were Mana's
   code.** Unlike the LLM profiles, Mana runs exactly *one* TTS provider for
   the whole app session (whichever `TTS_PROVIDER` selects) — checked
   `node-bot/tts-runtime.js` (talks to the TTS process over HTTP only, never
   spawns/kills it) and `windows-launcher/main.js` (does spawn
   Kokoro/GPT-SoVITS/Chatterbox processes, but only kills them on app quit,
   never mid-session to swap to a different one). There is no "unload the
   old TTS model, load a new one" event anywhere in the current codebase for
   `torch.cuda.empty_cache()`/`gc.collect()` to run around.

**Conclusion:** this sub-task doesn't have a real trigger point given how
Mana currently manages TTS processes, so nothing was changed here. If Mana
ever adds TTS provider hot-swapping (switching `TTS_PROVIDER` without an app
restart) or forks one of these services, that's the point where this becomes
actionable — tracked as a real prerequisite, not implemented speculatively
now.

### model-management.js's role — decided: stays fallback-only, and it's a narrower fallback than it looked

Traced every current path that ends up choosing a model profile:

- `POST /reply` (`server-routes.js`): if the request body includes a
  `modelProfile` key at all (even `"default"`), that value wins. Only when
  the key is *absent entirely* does it fall back to
  `modelManagement.getActiveProfile()`.
- `windows-launcher` always sends `modelProfile: selectedModelProfile` on
  every `/reply` call (defaults to `"default"`, but the key is always
  present) — Compare mode explicitly sets it per column too.
- `POST /transcribe` (`server-routes.js`, desktop-client's primary chat path)
  and both mobile routes (`mobile-routes.js`'s `/chat` and `/chat/audio`)
  call `buildAssistantReply(...)` with the literal string `"default"`
  hardcoded as the 4th argument — they never look at
  `getActiveModelProfile()` at all, and never will unless someone changes
  that hardcoding.

Net effect: **`getActiveModelProfile()`'s fallback in `/reply` is real code
that is not currently reachable from any of Mana's own shipped UIs** — every
one of them either always sends an explicit `modelProfile` or bypasses
`/reply` entirely. It only matters for a caller hitting `/reply` directly
without that field (a raw API/MCP-style integration, for example).

A second consequence of the same tracing: because `buildAssistantReply`
always passes an already-normalized, valid profile string into
`selectLlamaModelProfileForPrompt()`, and `hasExplicitLlamaModelProfile()`
treats *any* known profile name — including `"default"` — as "explicit",
**the keyword-based inference branch in `selectLlamaModelProfileForPrompt`
(detecting "coding"/"quality mode" from prompt text) is currently dead code
in the real request path.** It's still exercised directly by
`test/llama-model-selection.test.js`, just never reached through
`buildAssistantReply` today.

**Decision:** leave `model-management.js` as fallback-only, matching the
acceptance criterion's "existing behavior unchanged unless explicitly
redesigned" — no behavior change shipped here. Documenting two real
follow-ups instead of doing them speculatively in this issue:
- `/transcribe` and the mobile routes could consult `getActiveModelProfile()`
  instead of hardcoding `"default"`, so the Model panel's selection actually
  applies to desktop-client/mobile voice chat too. Currently it silently
  doesn't.
- If prompt-based inference is meant to be a real feature (not dead code),
  something upstream of `buildAssistantReply` would need to stop always
  supplying an explicit profile — a deliberate product decision, not a bug
  fix.

## Verified

- `node-bot` test suite: `test/llama-server-runtime.test.js` — 15/15 pass,
  including 5 new tests for swap timing, debounce (window active, window
  elapsed, disabled via `=0`), and the unified-memory default/opt-out.
- Full `node run_tests.js` — all files pass, no regressions.
- Real hardware measurement (not simulated) on the actual RTX 3070 Ti this
  runs on, under real concurrent GPU load (FFXIV + LM Studio running), via a
  standalone benchmark script driving the real `llama-server.exe` binary
  through cold-start and both swap directions, twice (plain and unified-
  memory) — see the numbers table above.
