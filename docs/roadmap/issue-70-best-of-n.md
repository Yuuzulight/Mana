# Issue 70: Best-of-N Self-Voting Inference for Coding Replies

## Goal

Extend Mana's existing single-candidate reply verification/retry system into
real multi-draft generation with model-driven selection, for coding-mode
replies specifically.

## Why

`node-bot/ai/llama-server-runtime.js` never sent `temperature` or any other
sampling-variation parameter to llama-server -- every request produced
exactly one completion. The only existing "regeneration" logic was
`server.js`'s opt-in syntactic verify/retry pass (`MANA_VERIFY_REPLY`,
`MANA_AUTO_RETRY_VERIFICATION`), which re-runs the model once more, still
one candidate at a time, with no ranking between drafts.

## Proposed Scope

- Add sampling-parameter (temperature) support to a new best-of-N call path.
- For coding-mode replies, generate 3-5 candidates at varied temperature.
- A greedy (temp 0) judge pass picks the single best candidate.
- Decide whether this replaces or layers on the existing verify/retry pass.
- Gate behind its own opt-in env var, given the real latency cost.

## Status: Implemented

- **`runBestOfNReply(prompt, options)`** in `llama-server-runtime.js`:
  generates `n` candidates (default 3) against a fixed temperature ladder
  (0.2 -> 1.0, evenly spread), then a temp-0 judge call picks the best index
  from a numbered list of candidates. If the judge's reply doesn't parse to
  a clean in-range number, falls back to candidate 1 (the lowest-temperature,
  safest one) rather than guessing.
- **Sequential, not parallel**: this llama-server instance is spawned
  without `--parallel`, so it runs with the default single parallel slot --
  concurrent requests would just queue behind each other on this hardware,
  not actually overlap. N candidates are generated one after another.
- **Wired into `buildAssistantReply`** via a new `replyMaybeWithBestOfN()`
  that layers on top of the existing `replyMaybeWithTools()` rather than
  replacing the reply pipeline: it's tried first, and on any failure, empty
  result, or when its own gate conditions aren't met, falls straight through
  to the tool-calling-or-plain path that already existed. Guardrails:
  opt-in (`MANA_BEST_OF_N_ENABLED=1`), scoped to `mode === "coding"` only,
  availability-checked (`isLlamaServerEnabledForBestOfN()`), fail-soft.
- **Layers on top of verify/retry, doesn't duplicate it**: whatever
  `replyMaybeWithBestOfN()` returns becomes `reply`, and the existing
  `MANA_VERIFY_REPLY`/`MANA_AUTO_RETRY_VERIFICATION` syntactic check further
  down in `buildAssistantReply` still runs on it unchanged -- no code
  changes were needed there at all, since that block already operates
  generically on whatever `reply` ended up being produced.
- `MANA_BEST_OF_N_COUNT` (default 3) configures N.

## Real-hardware latency measurement (RTX 3070 Ti, 8GB VRAM)

Measured with the actual "coding" profile model
(`qwen2.5-coder-7b-instruct-q4_k_m.gguf`), `n=3`, a real coding prompt
("write a Python function that finds the longest common subsequence of two
strings"), `max_tokens=400`:

| Step | Time |
| --- | --- |
| Cold start (model load) | 17.4s (excluded from totals below) |
| Candidate 1 (temp 0.2) | 60.2s |
| Candidate 2 (temp 0.6) | 58.4s |
| Candidate 3 (temp 1.0) | 58.6s |
| Judge pass (temp 0, 16 max tokens) | 38.4s |
| **Total best-of-N latency** | **~215.6s** |
| Single plain reply (n=1, no judge) for comparison | ~60.2s |

**~3.6x latency multiplier** over a single plain reply. The judge pass alone
costs 38s despite generating only a handful of output tokens -- re-processing
three ~1300-character candidates as prompt context isn't free, even before
generation starts. (Note: FFXIV was running concurrently during this
measurement, competing for the same GPU -- the absolute numbers may be
somewhat pessimistic versus an idle machine, but the ~3.6x multiplier and the
general "this is minutes, not seconds" conclusion hold regardless.)

This firmly confirms the acceptance criteria's own expectation: best-of-N
must stay opt-in, never become a default coding-mode path. At today's
generation speed on this hardware, a coding reply that would normally take
~60s instead takes over 3.5 minutes with best-of-N enabled.

## Deliberately skipped: parallel generation

The issue floated generating candidates in parallel if hardware allows it.
Not attempted: this llama-server instance has no `--parallel` flag set (the
default is a single parallel slot), so concurrent HTTP requests to it would
simply queue rather than actually run concurrently -- there is no latency
win available without also reconfiguring the server's parallelism, which
has its own VRAM cost (each parallel slot holds its own KV cache) on an
already-tight 8GB card. Revisit if a wider-VRAM setup makes real parallel
slots worth the memory tradeoff.

### Verified

- `node-bot/test/llama-server-runtime.test.js`: 3 new tests for
  `runBestOfNReply` (candidate/judge round-trip with varied temperatures,
  fallback to candidate 1 on an unparseable judge reply, no judge round at
  all when `n=1`).
- `node-bot/test/server-routes.test.js`: 5 new tests on the
  `replyMaybeWithBestOfN` wiring (off by default, activates for coding mode,
  does not activate for non-coding replies, falls back when llama-server is
  unavailable, falls back when `runBestOfNReply` throws).
- Full suite (`node run_tests.js`): all files pass.
- Real-hardware latency measurement above, run against the actual
  `qwen2.5-coder-7b-instruct-q4_k_m.gguf` model and llama-server binary.
