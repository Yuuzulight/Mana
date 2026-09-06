# Issue 556: Evaluate Heretic For On-Demand Local Model Decensoring

## Goal

Decide whether Mana should offer Heretic-based abliteration as an option
for the local model stack, on measured quality/behavior tradeoffs rather
than the project's own benchmark table.

## Why

[p-e-w/heretic](https://github.com/p-e-w/heretic) (AGPLv3) is a
fully-automatic directional-ablation ("abliteration") tool: it removes a
transformer's learned refusal behavior without any fine-tuning, using a
TPE/Optuna-based optimizer that jointly minimizes refusal rate and
KL-divergence from the original model. Community reports and the
project's own comparison table suggest it produces less capability
damage than typical hand-tuned abliterations. Mana runs everything
local-first and already swaps in specific model builds for specific
roles (see `docs/coding_model_quantization.md`'s custom-calibrated
coding quant) -- an on-demand decensoring pass is the same kind of "tune
the local stack for what this user actually wants" work, not a new
category of thing Mana does.

This is explicitly about giving the *user* control over their own local
model's behavior, not about Mana's own default persona or guardrails.

## Proposed Scope

- Evaluation only, not a commitment to ship it.
- Run Heretic against a small model already in Mana's rotation (e.g.
  the fast/background Qwen3-1.7B tier) and measure refusal rate +
  KL-divergence before/after, plus a few real Mana-style prompts run
  through both versions.
- Check practical fit: dependency footprint (PyTorch/Optuna, GPU/VRAM
  needs), run time on Mana's own hardware, and whether the AGPLv3
  license creates any obligation given how Mana would package/invoke it
  (likely: shell out to a separately-installed tool, not vendor it).
- Only propose an integration path (e.g. an opt-in setup-time step or
  Doctor-panel action) if the quality tradeoff and licensing fit are
  both acceptable.

## Acceptance Criteria

- A documented before/after comparison on a real Mana model: refusal
  rate, KL-divergence or equivalent quality signal, and a few
  qualitative examples.
- A clear license/packaging note (how Mana would invoke it without
  AGPL obligations spreading to Mana itself).
- A clear build/don't-build recommendation.

## Related

None yet -- filed directly from a GitHub lookup, not from the OSS
survey docs.
