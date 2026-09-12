# Issue 625: Surface The Existing Hardware-Fit Recommendation In First-Run UI, Add Backend Auto-Selection

## Correction notice

A follow-up codebase audit (2026-09-12) found this issue's premise was
wrong: GPU/RAM detection and a tested hardware-fit recommender already
exist on the backend. It's just never surfaced anywhere in either
launcher's UI. Scope narrowed accordingly.

## Goal

Surface the already-computed hardware-fit recommendation in the launcher
UI at first run, and add the genuinely-missing backend
(CUDA/Vulkan/ROCm/CPU) auto-selection.

## Why

The original research assumed "no hardware-fit/backend-auto-selection
logic exists at first run." Half of that is false:

- **Hardware detection and recommendation already exist and are
  tested**: `node-bot/model-management.js`'s `detectGpuVramMb` (via
  `nvidia-smi`), `detectSystemMemoryMb`, and
  `recommendModelProfile({vramMb, ramMb})` (lines 183-228) are
  implemented and covered by `node-bot/test/model-management.test.js`,
  exposed as a `recommendation` field on `GET /models/status`
  (`model-management.js:365`, `server-routes.js:586-588`).
- **It's dead data on the wire**: a grep across `ManaBackendClient.cs`,
  `SettingsPanel.cs`, and `renderer.js` confirms zero references to this
  `recommendation` field anywhere in either launcher's UI. The backend
  computes it; nothing displays it.
- **Backend-build auto-selection genuinely doesn't exist**: no
  CUDA/Vulkan/ROCm/CPU llama.cpp build detection or selection logic was
  found anywhere in the codebase -- this part of the original research
  holds.

## Proposed Scope

- Surface the existing `recommendation` field from `GET /models/status`
  in a first-run wizard step or the model-picker screen, in both
  `windows-launcher` and `windows-native-launcher`.
- Add a per-role, per-model/quant hardware-fit indicator (fits
  comfortably / tight / likely too large) using the existing detection,
  not new detection logic.
- Detect GPU vendor and select the matching llama.cpp/whisper.cpp
  backend build at first run (this part is genuinely new work), with a
  manual override in advanced settings.

## Acceptance Criteria

- The model picker in both launchers shows a hardware-fit indicator per
  model/quant per role, sourced from the existing `GET /models/status`
  `recommendation` field.
- First run auto-selects a working llama.cpp/whisper.cpp backend build
  for the detected hardware, with no manual step required for the common
  case.
- A user with an under-specced GPU is warned before downloading/loading
  a model that won't fit, rather than discovering it via an OOM crash.

## Related

`docs/roadmap/oss-inspiration-survey-2026-09.md`. Relevant to both
launchers' first-run flow.
