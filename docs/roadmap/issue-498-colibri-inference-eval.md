# Issue 498: Evaluate Colibri For Larger MoE Models On Modest Hardware

## Goal

Decide whether adopting Colibri as a second inference runtime alongside
llama.cpp is worth it, to unlock MoE models an order of magnitude larger
than Mana's hardware would otherwise support.

## Why

Inspired by JustVugg/colibri, a pure-C, zero-dependency inference engine
that runs 744B-2.8T parameter MoE models on consumer hardware by
streaming experts from disk, treating disk/RAM/VRAM as one inference
hierarchy. Different question from #335 (open, blocked on the VRAM
upgrade), which evaluates a MoE model that fits within Mana's normal
VRAM budget on the existing llama.cpp runtime -- this issue is about
models that couldn't run on Mana's hardware at all without a different
runtime.

## Proposed Scope

- Hands-on evaluation only, not a commitment to integrate.
- Measure real tokens/sec, VRAM/RAM/disk usage, and quality/persona-fit
  on Mana's actual target hardware -- same bar #335 already applies to
  its own candidates.
- Measure disk I/O overhead from expert streaming specifically, since
  that's the mechanism enabling the larger models in the first place and
  the most likely source of a real-world latency surprise.

## Acceptance Criteria

- A documented evaluation: measured throughput/quality/persona-fit
  against the current dense model, and whether disk-streaming latency is
  acceptable for Mana's conversational use case.
- A clear build/don't-build recommendation.

## Related

#335
