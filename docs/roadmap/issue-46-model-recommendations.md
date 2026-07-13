# Issue 46: Add Hardware-Aware Local Model Recommendations

## Goal

Help users pick a sensible default/fast/quality/coding model tier for their
actual hardware instead of guessing, extending
`node-bot/model-management.js`.

## Why

Inspired by odysseus's Cookbook (hardware-aware model recommendations,
downloads, serving). Mana already has profile switching
(`node-bot/ai/local-ai.js`'s `LLAMA_MODEL_PROFILES`,
`node-bot/model-management.js`), but no guidance on which profile fits the
user's actual machine.

## Proposed Scope

- Detect available system RAM/VRAM (best-effort, e.g. via a lightweight
  native query or user-provided hint) at setup/doctor time.
- Recommend a starting profile (e.g. "fast" for under 8GB VRAM, "default"
  for 8-16GB, "quality" for 16GB+) with an explanation.
- Surface the recommendation in `tools/setup-mana.ps1` and/or the Doctor
  report, not just silently pick one.
- Do not auto-download models — keep the existing "point Mana at a GGUF you
  already downloaded" model, just make the recommendation smarter.

## Acceptance Criteria

- Doctor (or setup script) reports a recommended model profile with the
  reasoning shown.
- Recommendation only affects the suggestion shown to the user; existing
  manual profile selection is unaffected.
- Works without requiring any new heavy dependency.
