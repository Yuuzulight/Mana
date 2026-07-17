# Issue 46: Add Hardware-Aware Local Model Recommendations

## Status

Implemented. `node-bot/model-management.js` now detects GPU VRAM via
`nvidia-smi` (best-effort, returns `null` gracefully if unavailable) and
falls back to system RAM (`os.totalmem()`) as a rougher proxy, then
recommends a starting profile (`fast`/`default`/`quality`) with the
reasoning shown. No new dependency — both signals come from Node's
built-ins or shelling out to a tool most local-CUDA users already have.
Surfaced via `GET /models/status` (a new `recommendation` field) and a new
Doctor check (`recommended-model-profile`), which `tools/setup-mana.ps1`
already prints since it runs `node doctor.js` directly. The recommendation
is purely informational — it doesn't change `LLAMA_MODEL`/profile
selection, matching the acceptance criteria.

The VRAM tier boundary sits at 15GB, not 16GB: `nvidia-smi` reports usable
VRAM, which comes in under a card's nominal size (driver/OS reservations),
so a real 16GB card often reports ~16000-16300MB rather than the full
16384. Cutting at 15360MB keeps 16GB cards correctly landing in `quality`
instead of being silently under-recommended into `default`. The `quality`
profile (`node-bot/ai/local-ai.js`) now prefers a 14B-class model ahead of
the existing 8B one, so a 16GB upgrade actually gets used instead of
recommending the same model `default` can already fall back to.

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
