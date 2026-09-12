# Issue 625: Add Hardware-Aware Model Recommendations And Backend Auto-Selection To First-Run Setup

## Goal

Stop asking a non-technical user to pick GGUF quants and llama.cpp
backend builds blind at first run, and warn them before they pick
something their hardware can't run.

## Why

Three local-AI tools converge on the same first-run UX problem Mana's
launcher will also hit, since Mana already commits to swappable per-role
models (chat/vision/coding/fast) plus gaming-mode resource backoff --
both situations where a user picking a model that doesn't fit their VRAM
leads to a cryptic OOM or crawling inference:

- **LM Studio** shows a per-model/per-quant hardware-fit signal
  (green/yellow/red against detected VRAM/RAM) directly in its model
  browser, before download.
- **AnythingLLM** ships as a single all-in-one executable and
  auto-recommends a model based on detected hardware specs during its
  first-run wizard, rather than presenting a raw quant picker.
- **NVIDIA's RTX AI app ecosystem / Windows AI Toolkit** tag each
  model/engine build with the specific GPU/NPU it's compiled for and
  auto-select the matching backend (CUDA vs. TensorRT-LLM vs.
  CPU/DirectML) rather than making the user choose a backend flavor.

This maps onto a real Windows-specific problem for Mana: llama.cpp has
separate CUDA/Vulkan/CPU (and ROCm) builds, and a non-technical user has
no way to know which one their machine needs, on top of not knowing
whether a given per-role model/quant will even fit.

## Proposed Scope

- Detect GPU vendor/VRAM (and CPU/RAM as fallback) at first run and
  silently select the matching llama.cpp/whisper.cpp backend build, with
  a manual override buried in advanced settings.
- Add a per-role, per-model/quant hardware-fit indicator (fits
  comfortably / tight / likely too large) to the launcher's model-picker
  screen, using detected free VRAM/RAM, recalculated when gaming-mode
  backoff is active.
- Consider a first-run "recommend a sane default per role for my
  hardware" step for users who don't want to pick manually at all,
  similar to AnythingLLM's wizard.

## Acceptance Criteria

- First run auto-selects a working llama.cpp/whisper.cpp backend build
  for the detected hardware, with no manual step required for the common
  case.
- The model picker shows a hardware-fit indicator per model/quant per
  role, using real detected VRAM/RAM.
- A user with an under-specced GPU is warned before downloading/loading a
  model that won't fit, rather than discovering it via an OOM crash.

## Related

`docs/roadmap/oss-inspiration-survey-2026-09.md` (full research backing).
Relevant to the native launcher work in PR #538.
